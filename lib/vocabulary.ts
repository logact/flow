import { logger as appLogger } from './logger';
import { selectTask, type TaskType } from './scoring';
import crypto from 'node:crypto';
import { BNC_COCA_L6_V2, VOCABULARY_LIST_SOURCE, type FamilyList, type WordFamily } from './vocabulary-reference';

export type EstimateBand = 'common' | 'known' | 'less_common' | 'unknown';
export interface ListSource {
  id: string;
  basis: string;
}

export interface VocabularyEstimate {
  size: number;
  listSource: ListSource;
  distribution?: Array<{ value: number; probability: number }>;
  uncertainty?: { lower: number; upper: number; method: string };
  sourceVersion?: string;
}
export type FrequencyBand = `${number}k`;
export interface BandPopulation { band: FrequencyBand; familyCount: number }
export interface FamilyTestItem { familyId: string; band: FrequencyBand; correct: boolean }
export interface BandVocabularyTestInput { sourceVersion: string; listSource: ListSource; populations: BandPopulation[]; items: FamilyTestItem[] }
export interface VocabularyCapacityEvidence { band: FrequencyBand; familyCount: number; questions: number; correct: number }


/** Band-sampled family test estimator; probabilities form a coarse discrete uncertainty distribution. */
export function estimateVocabularyCapacityByBand(input: BandVocabularyTestInput): VocabularyEstimate {
  if (!input.sourceVersion || !input.listSource?.id || !input.listSource?.basis || !input.populations.length || !input.items.length) throw new RangeError('source identity, populations, and test items are required');
  const populations = new Map<string, number>();
  for (const p of input.populations) { if (!/^([1-9]|1[0-9]|2[0-5])k$/.test(p.band) || !Number.isInteger(p.familyCount) || p.familyCount <= 0 || populations.has(p.band)) throw new RangeError('invalid or duplicate band population'); populations.set(p.band, p.familyCount); }
  const seen = new Set<string>(); const evidence: VocabularyCapacityEvidence[] = [];
  for (const item of input.items) { const n = populations.get(item.band); if (!n || !item.familyId || seen.has(item.familyId) || typeof item.correct !== 'boolean') throw new RangeError('invalid, duplicate, or out-of-list family item'); seen.add(item.familyId); let e=evidence.find(x=>x.band===item.band); if(!e){e={band:item.band,familyCount:n,questions:0,correct:0}; evidence.push(e);} e.questions++; if(item.correct)e.correct++; }
  const size=evidence.reduce((s,e)=>s+e.familyCount*e.correct/e.questions,0); const variance=evidence.reduce((s,e)=>s+e.familyCount**2*(e.correct/e.questions)*(1-e.correct/e.questions)/e.questions,0); const sd=Math.sqrt(variance);
  return { size, listSource:{...input.listSource}, sourceVersion:input.sourceVersion, distribution:[{value:Math.max(0,size-sd),probability:.25},{value:size,probability:.5},{value:size+sd,probability:.25}], uncertainty:{lower:Math.max(0,size-1.96*sd),upper:size+1.96*sd,method:'stratified binomial normal approximation; prefix coverage prior'} };
}
export function estimateBandProbability(vocabulary: VocabularyEstimate, lower: number, upper: number): number {
  if (!(upper >= lower) || lower < 1 || !Number.isFinite(upper)) throw new RangeError('invalid cumulative band boundaries');
  const g=(v:number)=>Math.max(0,Math.min(1,(v-lower+1)/(upper-lower+1)));
  const d=vocabulary.distribution;
  return d?.length ? d.reduce((s,x)=>s+g(x.value)*x.probability,0) : g(vocabulary.size);
}

/** A test stratum samples words uniformly from an interval of the frequency list. */
export interface VocabularyCapacityTestStratum {
  rankStart: number;
  rankEnd: number;
  correct: number;
  questions: number;
}

export interface VocabularyCapacityTestInput {
  listSource: ListSource;
  strata: VocabularyCapacityTestStratum[];
}

export interface VocabularyCapacityEstimateEvent {
  event: 'vocabulary.capacity_estimated';
  listSource: ListSource;
  strata: VocabularyCapacityTestStratum[];
  estimate: VocabularyEstimate;
}

export type VocabularyCapacityEstimateLogger = (event: VocabularyCapacityEstimateEvent) => void;
const defaultVocabularyCapacityEstimateLogger: VocabularyCapacityEstimateLogger = event =>
  appLogger.info(event, 'User vocabulary capacity estimated');

/**
 * Extrapolates known vocabulary from representative, uniformly sampled rank bands.
 * The result uses the same frequency-list identity required by P3 score estimation.
 */
export function estimateVocabularyCapacity(input: VocabularyCapacityTestInput): VocabularyEstimate {
  if (!input.listSource?.id || !input.listSource?.basis) {
    throw new RangeError('listSource must include id and basis');
  }
  if (!Array.isArray(input.strata) || input.strata.length === 0) {
    throw new RangeError('at least one test stratum is required');
  }

  let estimatedSize = 0;
  for (const stratum of input.strata) {
    const { rankStart, rankEnd, correct, questions } = stratum;
    if (!Number.isFinite(rankStart) || !Number.isFinite(rankEnd) || rankStart < 0 || rankEnd <= rankStart) {
      throw new RangeError('each stratum must have a valid frequency interval');
    }
    if (!Number.isInteger(questions) || questions <= 0 || !Number.isInteger(correct) || correct < 0 || correct > questions) {
      throw new RangeError('each stratum must have valid correct and questions counts');
    }
    estimatedSize += (rankEnd - rankStart) * (correct / questions);
  }

  return { size: estimatedSize, listSource: { ...input.listSource } };
}

/** Estimate capacity and persist the test provenance at the application boundary. */
export function recordVocabularyCapacityEstimate(
  input: VocabularyCapacityTestInput,
  logger: VocabularyCapacityEstimateLogger = defaultVocabularyCapacityEstimateLogger,
): VocabularyCapacityEstimateEvent {
  const estimate = estimateVocabularyCapacity(input);
  const event: VocabularyCapacityEstimateEvent = {
    event: 'vocabulary.capacity_estimated',
    listSource: { ...input.listSource },
    strata: input.strata.map(stratum => ({ ...stratum })),
    estimate,
  };
  logger(event);
  return event;
}

/** P3 word-family estimator. Prefix coverage within a frequency band is a prior assumption, not observed learner knowledge. */
export interface TargetWordEstimateInput { word: string; context?: string; partOfSpeech?: string }
export interface FamilyBandBounds { band: FrequencyBand; lower: number; upper: number }
export interface BandScoreThreshold { minProbability: number; band: EstimateBand; R: number; P: number }
export const DEFAULT_SCORE_THRESHOLDS: readonly BandScoreThreshold[] = [
  { minProbability: .8, band: 'common', R: 60, P: 40 }, { minProbability: .5, band: 'known', R: 40, P: 20 },
  { minProbability: .2, band: 'less_common', R: 20, P: 5 }, { minProbability: 0, band: 'unknown', R: 0, P: 0 },
];
export function estimateInitialFamilyScores(input: { vocabulary: VocabularyEstimate; target: TargetWordEstimateInput; lookup: (word: string, options?: { partOfSpeech?: string }) => import('./vocabulary-reference').FamilyLookup; bounds: FamilyBandBounds[]; thresholds?: readonly BandScoreThreshold[] }) {
  const found=input.lookup(input.target.word,{partOfSpeech:input.target.partOfSpeech});
  if(found.status!=='matched' || !found.family) return { originalWord:input.target.word, family:null, lookup:found.status, probabilityKnown:null, R:0, P:0, scoreBand:'unknown' as const, comparable:false, reason:found.status==='ambiguous'?'ambiguous_family' as const:'not_in_list' as const };
  const b=input.bounds.find(x=>x.band===found.family!.band);
  if(!b || input.vocabulary.listSource.id!==found.source) return { originalWord:input.target.word,family:{headword:found.family.headword,band:found.family.band},lookup:'matched' as const,probabilityKnown:null,R:0,P:0,scoreBand:'unknown' as const,comparable:false,reason:'source_version_mismatch' as const };
  const p=estimateBandProbability(input.vocabulary,b.lower,b.upper), t=[...(input.thresholds??DEFAULT_SCORE_THRESHOLDS)].sort((a,b)=>b.minProbability-a.minProbability).find(x=>p>=x.minProbability)!;
  return { originalWord:input.target.word,family:{headword:found.family.headword,band:found.family.band},lookup:'matched' as const,probabilityKnown:p,R:t.R,P:t.P,scoreBand:t.band,comparable:true };
}

/** Default public surface-word API backed by the pinned local BNC/COCA v2 list. */
export function estimateTargetWordInitialScores(input: { vocabulary: VocabularyEstimate; target: TargetWordEstimateInput; thresholds?: readonly BandScoreThreshold[] }) {
  // Keep the list adapter separate from estimator policy; importing here avoids startup coupling for legacy callers.
  const adapter = require('./vocabulary-reference') as typeof import('./vocabulary-reference');
  return estimateInitialFamilyScores({ vocabulary: input.vocabulary, target: input.target, lookup: adapter.bncCocaFamilyIndex.lookup, bounds: adapter.getBncCocaBandBounds(), ...(input.thresholds ? { thresholds: input.thresholds } : {}) });
}

// -----------------------------------------------------------------------------
// P3.1 vocabulary capacity test creation, validation, and recording
// -----------------------------------------------------------------------------

/** Learner-facing item: no family identity, no correctness answer. */
export interface VocabularyCapacityTestPromptItem { itemId: string; prompt: string }

/** Server-side answer key for a prompt. */
export interface VocabularyCapacityTestKeyItem {
  itemId: string;
  familyId: string;
  band: FrequencyBand;
  prompt: string;
}

/** Full server-side test form. */
export interface VocabularyCapacityTestForm {
  testId: string;
  listSource: ListSource;
  sourceVersion: string;
  populations: BandPopulation[];
  learnerItems: VocabularyCapacityTestPromptItem[];
  answerKey: VocabularyCapacityTestKeyItem[];
}

/** Public view handed to the learner; the answer key is intentionally absent. */
export interface VocabularyCapacityLearnerView {
  testId: string;
  listSource: ListSource;
  sourceVersion: string;
  populations: BandPopulation[];
  items: VocabularyCapacityTestPromptItem[];
}

export interface VocabularyCapacityTestBandSpec { band: FrequencyBand; count: number }
export interface VocabularyCapacityTestSpec { bands?: ReadonlyArray<VocabularyCapacityTestBandSpec>; seed?: number }

/** Default capacity test: 4 items from each of the 25 BNC/COCA frequency bands, 100 items total. */
export const DEFAULT_VOCABULARY_CAPACITY_ITEMS_PER_BAND = 4;
export const DEFAULT_VOCABULARY_CAPACITY_TEST_SPEC: VocabularyCapacityTestSpec = Object.freeze({
  bands: Object.freeze(
    Array.from({ length: 25 }, (_, i) => ({
      band: `${i + 1}k` as FrequencyBand,
      count: DEFAULT_VOCABULARY_CAPACITY_ITEMS_PER_BAND,
    })),
  ),
});

export interface VocabularyCapacityTestSubmission {
  testId: string;
  listSource: ListSource;
  sourceVersion: string;
  answers: Array<{ itemId: string; correct: boolean }>;
}

export interface VocabularyCapacityTestValidResult {
  valid: true;
  input: BandVocabularyTestInput;
}

export interface VocabularyCapacityTestInvalidResult {
  valid: false;
  errors: Array<{ itemId?: string; message: string }>;
}

export type VocabularyCapacityTestResult = VocabularyCapacityTestValidResult | VocabularyCapacityTestInvalidResult;

export interface VocabularyCapacityByBandEstimateEvent {
  event: 'vocabulary.capacity_estimated';
  listSource: ListSource;
  sourceVersion: string;
  populations: BandPopulation[];
  evidence: VocabularyCapacityEvidence[];
  estimate: VocabularyEstimate;
}

export type VocabularyCapacityByBandEstimateLogger = (event: VocabularyCapacityByBandEstimateEvent) => void;
const defaultVocabularyCapacityByBandEstimateLogger: VocabularyCapacityByBandEstimateLogger = event =>
  appLogger.info(event, 'User vocabulary capacity estimated');

/** Create a frozen, deterministic vocabulary capacity test form and a separate learner view. */
export function createVocabularyCapacityTest(
  spec: VocabularyCapacityTestSpec = DEFAULT_VOCABULARY_CAPACITY_TEST_SPEC,
  list: FamilyList = BNC_COCA_L6_V2,
): { form: Readonly<VocabularyCapacityTestForm>; learnerView: Readonly<VocabularyCapacityLearnerView> } {
  if (!list.source || !list.version || !Array.isArray(list.families) || list.families.length === 0) {
    throw new RangeError('list must have source, version, and at least one family');
  }
  const resolvedBands = spec.bands ?? DEFAULT_VOCABULARY_CAPACITY_TEST_SPEC.bands;
  if (!Array.isArray(resolvedBands) || resolvedBands.length === 0) throw new RangeError('at least one band spec is required');
  if (spec.seed !== undefined && !Number.isInteger(spec.seed)) throw new RangeError('seed must be an integer when supplied');

  const seed = spec.seed ?? randomSeed();
  const bandCounts = countFamiliesByBand(list);
  const bands = [...resolvedBands]
    .map(s => ({ ...s }))
    .sort((a, b) => parseInt(a.band, 10) - parseInt(b.band, 10));

  for (const s of bands) {
    const population = bandCounts.get(s.band);
    if (population === undefined) throw new RangeError(`band ${s.band} not found in list`);
    if (!Number.isInteger(s.count) || s.count <= 0 || s.count > population) {
      throw new RangeError(`invalid sample count for band ${s.band}: ${s.count}`);
    }
  }

  const familiesByBand = groupFamiliesByBand(list);
  const rng = mulberry32(seed);
  const sampled: Array<{ family: WordFamily; band: FrequencyBand }> = [];
  for (const s of bands) {
    const pool = familiesByBand.get(s.band)!;
    const picked = sampleWithoutReplacement(pool, s.count, rng);
    for (const family of picked) sampled.push({ family, band: s.band });
  }

  sampled.sort((a, b) => parseInt(a.band, 10) - parseInt(b.band, 10) || a.family.id.localeCompare(b.family.id));

  const canonical = `${list.source}:${list.version}:${seed}:` + bands.map(s => `${s.band}:${s.count}`).join('|');
  const testId = `vocab-capacity-${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
  const populations = bands.map(s => ({ band: s.band, familyCount: bandCounts.get(s.band)! }));

  const learnerItems: VocabularyCapacityTestPromptItem[] = [];
  const answerKey: VocabularyCapacityTestKeyItem[] = [];
  for (const { family, band } of sampled) {
    const itemId = `item:${family.id}`;
    const prompt = family.headword;
    learnerItems.push({ itemId, prompt });
    answerKey.push({ itemId, familyId: family.id, band, prompt });
  }

  const form: VocabularyCapacityTestForm = {
    testId,
    listSource: { id: list.source, basis: VOCABULARY_LIST_SOURCE.basis },
    sourceVersion: list.version,
    populations,
    learnerItems,
    answerKey,
  };

  return { form: deepFreeze(form), learnerView: getVocabularyCapacityLearnerView(form) };
}

/** Produce the learner-facing view from a full test form. */
export function getVocabularyCapacityLearnerView(form: VocabularyCapacityTestForm): Readonly<VocabularyCapacityLearnerView> {
  return deepFreeze({
    testId: form.testId,
    listSource: { ...form.listSource },
    sourceVersion: form.sourceVersion,
    populations: form.populations.map(p => ({ ...p })),
    items: form.learnerItems.map(i => ({ ...i })),
  });
}

/**
 * Validate a submitted test result against the issued form and pinned list.
 * Returns a ready-to-estimate input only when the submission is fully valid.
 */
export function checkVocabularyCapacityTest(
  form: VocabularyCapacityTestForm,
  submission: VocabularyCapacityTestSubmission,
  list: FamilyList = BNC_COCA_L6_V2,
): VocabularyCapacityTestResult {
  const errors: Array<{ itemId?: string; message: string }> = [];

  if (form.testId !== submission.testId) errors.push({ message: 'testId mismatch' });
  if (form.sourceVersion !== submission.sourceVersion) errors.push({ message: 'sourceVersion mismatch' });
  if (form.listSource.id !== submission.listSource?.id || form.listSource.basis !== submission.listSource?.basis) {
    errors.push({ message: 'listSource identity mismatch' });
  }
  if (form.sourceVersion !== list.version || form.listSource.id !== list.source || form.listSource.basis !== VOCABULARY_LIST_SOURCE.basis) {
    errors.push({ message: 'form does not match the pinned list identity' });
  }
  if (form.learnerItems.length === 0) errors.push({ message: 'test form contains no items' });

  const keyByItemId = new Map(form.answerKey.map(k => [k.itemId, k]));
  const familyMap = new Map(list.families.map(f => [f.id, f]));
  const bandCounts = countFamiliesByBand(list);

  const populationBands = new Set(form.populations.map(p => p.band));
  for (const pop of form.populations) {
    if (bandCounts.get(pop.band) !== pop.familyCount) {
      errors.push({ message: `population for ${pop.band} does not match the pinned list` });
    }
  }

  const seenFormFamilyIds = new Set<string>();
  for (const key of form.answerKey) {
    if (!populationBands.has(key.band)) {
      errors.push({ itemId: key.itemId, message: `missing population for band ${key.band}` });
    }
  }
  for (const key of form.answerKey) {
    if (seenFormFamilyIds.has(key.familyId)) {
      errors.push({ itemId: key.itemId, message: `duplicate family ${key.familyId} in test form` });
    }
    seenFormFamilyIds.add(key.familyId);
  }

  if (!Array.isArray(submission.answers)) {
    errors.push({ message: 'answers must be an array' });
  }

  const answerMap = new Map<string, boolean>();
  const seenAnswerItemIds = new Set<string>();
  if (Array.isArray(submission.answers)) {
    for (const answer of submission.answers) {
      if (!answer || typeof answer.itemId !== 'string') {
        errors.push({ message: 'answer missing a valid itemId' });
        continue;
      }
      if (seenAnswerItemIds.has(answer.itemId)) {
        errors.push({ itemId: answer.itemId, message: 'duplicate answer itemId' });
        continue;
      }
      seenAnswerItemIds.add(answer.itemId);

      if (typeof answer.correct !== 'boolean') {
        errors.push({ itemId: answer.itemId, message: 'answer correct must be a boolean' });
        continue;
      }
      answerMap.set(answer.itemId, answer.correct);

      const key = keyByItemId.get(answer.itemId);
      if (!key) {
        errors.push({ itemId: answer.itemId, message: 'answer itemId is not part of the test' });
        continue;
      }

      const family = familyMap.get(key.familyId);
      if (!family) {
        errors.push({ itemId: answer.itemId, message: `family ${key.familyId} is not in the pinned list` });
        continue;
      }
      if (family.band !== key.band) {
        errors.push({ itemId: answer.itemId, message: `family ${key.familyId} does not belong to band ${key.band}` });
      }
    }
  }

  for (const itemId of keyByItemId.keys()) {
    if (!answerMap.has(itemId)) errors.push({ itemId, message: 'missing answer' });
  }

  if (errors.length > 0) return { valid: false, errors };

  const items: FamilyTestItem[] = form.answerKey.map(key => ({
    familyId: key.familyId,
    band: key.band,
    correct: answerMap.get(key.itemId)!,
  }));

  return {
    valid: true,
    input: {
      sourceVersion: form.sourceVersion,
      listSource: { ...form.listSource },
      populations: form.populations.map(p => ({ ...p })),
      items,
    },
  };
}

/** Check a submission, estimate vocabulary capacity only if it is valid, and log the event. */
export function recordVocabularyCapacityTestResult(
  form: VocabularyCapacityTestForm,
  submission: VocabularyCapacityTestSubmission,
  logger: VocabularyCapacityByBandEstimateLogger = defaultVocabularyCapacityByBandEstimateLogger,
  list: FamilyList = BNC_COCA_L6_V2,
): { checked: VocabularyCapacityTestResult; event?: VocabularyCapacityByBandEstimateEvent } {
  const checked = checkVocabularyCapacityTest(form, submission, list);
  if (!checked.valid) return { checked };

  const estimate = estimateVocabularyCapacityByBand(checked.input);
  const event: VocabularyCapacityByBandEstimateEvent = {
    event: 'vocabulary.capacity_estimated',
    listSource: { ...checked.input.listSource },
    sourceVersion: checked.input.sourceVersion,
    populations: checked.input.populations.map(p => ({ ...p })),
    evidence: computeEvidence(checked.input.items, checked.input.populations),
    estimate,
  };
  logger(event);
  return { checked, event };
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

function randomSeed(): number {
  return crypto.randomInt(1, 0x7fffffff);
}

function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function countFamiliesByBand(list: FamilyList): Map<FrequencyBand, number> {
  const map = new Map<FrequencyBand, number>();
  for (const family of list.families) {
    map.set(family.band, (map.get(family.band) ?? 0) + 1);
  }
  return map;
}

function groupFamiliesByBand(list: FamilyList): Map<FrequencyBand, WordFamily[]> {
  const map = new Map<FrequencyBand, WordFamily[]>();
  for (const family of list.families) {
    const arr = map.get(family.band) ?? [];
    arr.push(family);
    map.set(family.band, arr);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.id.localeCompare(b.id));
  return map;
}

function sampleWithoutReplacement<T>(items: readonly T[], count: number, rng: () => number): T[] {
  const pool = items.slice();
  const result: T[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(rng() * pool.length);
    result.push(pool[idx]);
    pool[idx] = pool[pool.length - 1];
    pool.pop();
  }
  return result;
}

function computeEvidence(items: FamilyTestItem[], populations: BandPopulation[]): VocabularyCapacityEvidence[] {
  const counts = new Map(populations.map(p => [p.band, p.familyCount]));
  const map = new Map<FrequencyBand, VocabularyCapacityEvidence>();
  for (const item of items) {
    let e = map.get(item.band);
    if (!e) {
      e = { band: item.band, familyCount: counts.get(item.band)!, questions: 0, correct: 0 };
      map.set(item.band, e);
    }
    e.questions += 1;
    if (item.correct) e.correct += 1;
  }
  return [...map.values()].sort((a, b) => parseInt(a.band, 10) - parseInt(b.band, 10));
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  if (Array.isArray(obj)) {
    for (const item of obj) deepFreeze(item);
  } else {
    for (const key of Object.keys(obj)) deepFreeze((obj as Record<string, unknown>)[key]);
  }
  return obj;
}
