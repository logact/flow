import { logger as appLogger } from './logger';
import { selectTask, type TaskType } from './scoring';

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
