import * as lemmatizer from 'wink-lemmatizer';
import type {
  AttemptValidity,
  DimensionJudgement,
  DimensionLearningState,
  FluencyDimension,
  FluencyScores,
  GeneratedTask,
  GoalKnowledgePoint,
  GoalKnowledgePointSelection,
  GoalKnowledgePointSource,
  GoalMaterial,
  ISODateTime,
  KnowledgePoint,
  KnowledgePointVocabularyClassification,
  Learner,
  LearnerKnowledgePoint,
  LearnerKnowledgePointInitialization,
  LearnerVocabularyAssessmentTask,
  LearningGoal,
  LearningState,
  LearningTask,
  LearningTaskView,
  LocalDate,
  Material,
  MaterialAnalysis,
  MaterialAnalysisItem,
  MaterialUnmatchedItem,
  Occurrence,
  ReadingFluencyTaskContent,
  ReadingFluencyTaskSubmission,
  RetrieveStage,
  ReviewSchedule,
  TaskAttempt,
  TaskJudgement,
  TaskSubmission,
  VocabularyAssessment,
  VocabularyAssessmentAttempt,
  VocabularyAssessmentTask,
  VocabularyBand,
  VocabularyEstimate,
  VocabularyListReference,
} from './model';

export interface CreateLearnerInput {
  id: string;
  timezone: string;
  dailyTaskCapacity: number;
  now: ISODateTime;
}

export function createLearner(input: CreateLearnerInput): Learner {
  requireText(input.id, 'id');
  assertTimezone(input.timezone);
  assertNonNegativeInteger(input.dailyTaskCapacity, 'dailyTaskCapacity');
  assertDateTime(input.now, 'now');
  return {
    id: input.id,
    currentVocabulary: null,
    dailyTaskCapacity: input.dailyTaskCapacity,
    timezone: input.timezone,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export interface UpdateLearnerSettingsInput {
  dailyTaskCapacity?: number;
  timezone?: string;
  now: ISODateTime;
}

export function updateLearnerSettings(
  learner: Learner,
  input: UpdateLearnerSettingsInput,
): Learner {
  if (input.dailyTaskCapacity !== undefined) {
    assertNonNegativeInteger(input.dailyTaskCapacity, 'dailyTaskCapacity');
  }
  if (input.timezone !== undefined) assertTimezone(input.timezone);
  assertDateTime(input.now, 'now');
  return {
    ...learner,
    dailyTaskCapacity: input.dailyTaskCapacity ?? learner.dailyTaskCapacity,
    timezone: input.timezone ?? learner.timezone,
    updatedAt: input.now,
  };
}

export interface VocabularyAssessmentWordFamily {
  id: string;
  headword: string;
  band: VocabularyBand;
  members: string[];
  pos: string[];
}

export interface SampleVocabularyForAssessmentInput {
  list: VocabularyListReference;
  families: VocabularyAssessmentWordFamily[];
  sampleCounts: Partial<Record<VocabularyBand, number>>;
  seed: string;
}

export interface VocabularyAssessmentSample {
  familyId: string;
  band: VocabularyBand;
  lemma: string;
  wordFamily: string;
}

export function sampleVocabularyForAssessment(
  input: SampleVocabularyForAssessmentInput,
): VocabularyAssessmentSample[] {
  requireText(input.list.id, 'list.id');
  requireText(input.list.version, 'list.version');
  const familiesById = new Map<string, VocabularyAssessmentWordFamily>();
  for (const family of input.families) {
    requireText(family.id, 'family.id');
    requireText(family.headword, 'family.headword');
    if (familiesById.has(family.id)) throw new RangeError(`Duplicate word family: ${family.id}`);
    familiesById.set(family.id, family);
  }
  const random = createRandom(input.seed);
  const samples: VocabularyAssessmentSample[] = [];
  const bands = Object.keys(input.sampleCounts)
    .sort((a, b) => compareBands(a as VocabularyBand, b as VocabularyBand)) as VocabularyBand[];
  for (const band of bands) {
    const count = input.sampleCounts[band];
    if (count === undefined) continue;
    assertNonNegativeInteger(count, `sampleCounts.${band}`);
    const pool = input.families.filter((family) => family.band === band)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (count > pool.length) {
      throw new RangeError(`Not enough word families in ${band}: requested ${count}, available ${pool.length}`);
    }
    const shuffled = [...pool];
    for (let index = shuffled.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
    }
    for (const family of shuffled.slice(0, count)) {
      samples.push({
        familyId: family.id,
        band: family.band,
        lemma: family.headword,
        wordFamily: family.headword,
      });
    }
  }
  return samples;
}

export interface GenerateVocabularyAssessmentTasksInput {
  samples: VocabularyAssessmentSample[];
  taskIds: string[];
}

export function generateVocabularyAssessmentTasks(
  input: GenerateVocabularyAssessmentTasksInput,
): VocabularyAssessmentTask[] {
  if (input.samples.length !== input.taskIds.length) {
    throw new RangeError('taskIds must have the same length as samples');
  }
  assertUnique(input.taskIds, 'taskIds');
  return input.samples.map((sample, index) => {
    const taskId = input.taskIds[index];
    requireText(taskId, 'taskId');
    requireText(sample.lemma, 'sample.lemma');
    return {
      id: taskId,
      band: sample.band,
      knowledgePoint: {
        id: `assessment:${sample.familyId}`,
        kind: 'word',
        lemma: sample.lemma,
        wordFamily: sample.wordFamily,
        sense: {
          id: `assessment-sense:${sample.familyId}`,
          definition: `The meaning of ${sample.lemma}`,
          partOfSpeech: null,
          explanation: null,
        },
      },
    };
  });
}

export interface CreateVocabularyAssessmentInput {
  id: string;
  learnerId: string;
  tasks: VocabularyAssessmentTask[];
  now: ISODateTime;
}

export function createVocabularyAssessment(
  input: CreateVocabularyAssessmentInput,
): Extract<VocabularyAssessment, { status: 'in_progress' }> {
  requireText(input.id, 'id');
  requireText(input.learnerId, 'learnerId');
  assertDateTime(input.now, 'now');
  if (input.tasks.length === 0) throw new RangeError('An assessment requires at least one task');
  assertUnique(input.tasks.map((task) => task.id), 'task IDs');
  return {
    id: input.id,
    learnerId: input.learnerId,
    taskIds: input.tasks.map((task) => task.id),
    status: 'in_progress',
    result: null,
    createdAt: input.now,
    completedAt: null,
  };
}

export function toLearnerVocabularyAssessmentTask(
  task: VocabularyAssessmentTask,
): LearnerVocabularyAssessmentTask {
  return {
    id: task.id,
    band: task.band,
    knowledgePointId: task.knowledgePoint.id,
    lemma: task.knowledgePoint.lemma,
  };
}

export interface RecordVocabularyAssessmentAttemptInput {
  attemptId: string;
  assessment: VocabularyAssessment;
  task: VocabularyAssessmentTask;
  previousAttempts: VocabularyAssessmentAttempt[];
  known: boolean;
  answeredAt: ISODateTime;
}

export function recordVocabularyAssessmentAttempt(
  input: RecordVocabularyAssessmentAttemptInput,
): VocabularyAssessmentAttempt {
  if (input.assessment.status !== 'in_progress') throw new Error('Assessment is not in progress');
  if (!input.assessment.taskIds.includes(input.task.id)) throw new Error('Task does not belong to assessment');
  if (input.previousAttempts.some((attempt) => attempt.id === input.attemptId)) {
    throw new Error(`Attempt already exists: ${input.attemptId}`);
  }
  if (input.previousAttempts.some((attempt) => attempt.assessmentId === input.assessment.id
    && attempt.taskId === input.task.id)) {
    throw new Error(`Task has already been answered: ${input.task.id}`);
  }
  if (typeof input.known !== 'boolean') throw new RangeError('known must be a boolean');
  assertDateTime(input.answeredAt, 'answeredAt');
  return {
    id: input.attemptId,
    assessmentId: input.assessment.id,
    taskId: input.task.id,
    known: input.known,
    answeredAt: input.answeredAt,
  };
}

export interface VocabularyBandAssessmentEvidence {
  band: VocabularyBand;
  wordFamilyCount: number;
  tasks: VocabularyAssessmentTask[];
  attempts: VocabularyAssessmentAttempt[];
}

export interface EstimateVocabularyInput {
  list: VocabularyListReference;
  bands: VocabularyBandAssessmentEvidence[];
  estimatedAt: ISODateTime;
}

export function estimateVocabulary(input: EstimateVocabularyInput): VocabularyEstimate {
  assertDateTime(input.estimatedAt, 'estimatedAt');
  assertUnique(input.bands.map((band) => band.band), 'bands');
  const bands = [...input.bands].sort((a, b) => compareBands(a.band, b.band)).map((evidence) => {
    if (!Number.isInteger(evidence.wordFamilyCount) || evidence.wordFamilyCount <= 0) {
      throw new RangeError(`Invalid word-family count for ${evidence.band}`);
    }
    if (evidence.tasks.length > evidence.wordFamilyCount) {
      throw new RangeError(`Sample count exceeds population for ${evidence.band}`);
    }
    assertUnique(evidence.tasks.map((task) => task.id), `task IDs for ${evidence.band}`);
    assertUnique(evidence.attempts.map((attempt) => attempt.taskId), `attempt task IDs for ${evidence.band}`);
    const attempts = new Map(evidence.attempts.map((attempt) => [attempt.taskId, attempt]));
    let knownCount = 0;
    for (const task of evidence.tasks) {
      if (task.band !== evidence.band) throw new Error(`Task ${task.id} belongs to another band`);
      const attempt = attempts.get(task.id);
      if (!attempt) throw new Error(`Missing attempt for task ${task.id}`);
      if (typeof attempt.known !== 'boolean') throw new Error(`Attempt self-report is invalid for task ${task.id}`);
      if (attempt.known) knownCount++;
    }
    if (attempts.size !== evidence.tasks.length) throw new Error(`Unexpected attempts for ${evidence.band}`);
    const sampleCount = evidence.tasks.length;
    return {
      band: evidence.band,
      wordFamilyCount: evidence.wordFamilyCount,
      knownProbability: sampleCount === 0 ? 0 : knownCount / sampleCount,
      sampleCount,
      knownCount,
      interval: sampleCount === 0 ? null : wilsonInterval(knownCount, sampleCount),
    };
  });
  return { list: { ...input.list }, bands, estimatedAt: input.estimatedAt };
}

export interface CompleteVocabularyAssessmentInput {
  learner: Learner;
  assessment: VocabularyAssessment;
  tasks: VocabularyAssessmentTask[];
  attempts: VocabularyAssessmentAttempt[];
  list: VocabularyListReference;
  bandWordFamilyCounts: Partial<Record<VocabularyBand, number>>;
  now: ISODateTime;
}

export function completeVocabularyAssessment(
  input: CompleteVocabularyAssessmentInput,
): {
  assessment: Extract<VocabularyAssessment, { status: 'completed' }>;
  learner: Learner;
} {
  if (input.assessment.status !== 'in_progress') throw new Error('Assessment is not in progress');
  if (input.assessment.learnerId !== input.learner.id) throw new Error('Assessment belongs to another learner');
  const tasks = new Map(input.tasks.map((task) => [task.id, task]));
  if (tasks.size !== input.tasks.length
    || input.assessment.taskIds.some((id) => !tasks.has(id))
    || input.assessment.taskIds.length !== input.tasks.length) {
    throw new Error('Assessment tasks do not match the original task order');
  }
  for (const attempt of input.attempts) {
    if (attempt.assessmentId !== input.assessment.id) throw new Error('Attempt belongs to another assessment');
  }
  const bands = [...new Set(input.tasks.map((task) => task.band))].map((band) => {
    const wordFamilyCount = input.bandWordFamilyCounts[band];
    if (wordFamilyCount === undefined) throw new Error(`Missing word-family count for ${band}`);
    return {
      band,
      wordFamilyCount,
      tasks: input.tasks.filter((task) => task.band === band),
      attempts: input.attempts.filter((attempt) => tasks.get(attempt.taskId)?.band === band),
    };
  });
  const result = estimateVocabulary({ list: input.list, bands, estimatedAt: input.now });
  return {
    assessment: { ...input.assessment, status: 'completed', result, completedAt: input.now },
    learner: { ...input.learner, currentVocabulary: result, updatedAt: input.now },
  };
}

export interface CreateMaterialInput {
  id: string;
  learnerId: string;
  title: string;
  filename: string;
  format: Material['format'];
  mimeType: string | null;
  checksum: string;
  storageKey: string | null;
  extractedText: string | null;
  extractionMetadata: Record<string, unknown>;
  now: ISODateTime;
}

export function createMaterial(input: CreateMaterialInput): Material {
  requireText(input.id, 'id');
  requireText(input.learnerId, 'learnerId');
  assertDateTime(input.now, 'now');
  return {
    id: input.id,
    learnerId: input.learnerId,
    title: input.title,
    filename: input.filename,
    format: input.format,
    mimeType: input.mimeType,
    checksum: input.checksum,
    storageKey: input.storageKey,
    extractedText: input.extractedText,
    extractionMetadata: { ...input.extractionMetadata },
    createdAt: input.now,
  };
}

/** 材料中按词元归并后的一组原始出现。 */
export interface MaterialTerm {
  /** 归一化后的词元。 */
  lemma: string;
  /** 该词元在材料中的全部出现记录。 */
  occurrences: Occurrence[];
}

const SENTENCE_PATTERN = /[^.!?…\n]+[.!?…]+|[^.!?…\n]+$/g;
const TOKEN_PATTERN = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
/** PDF 序号上标被拆出的游离碎片（4th → th），不是真实用词。 */
const ORDINAL_FRAGMENT_PATTERN = /^(?:st|nd|rd|th)$/;

/**
 * 本地术语提取：分句、分词、词形归并，产出按 lemma 分组的原始出现记录。
 * 纯确定性处理，不含词义判断；词义由应用层消歧后以 assignments 交给 analyzeMaterial。
 */
export function extractMaterialTerms(material: Material): MaterialTerm[] {
  const text = material.extractedText ?? '';
  const groups = new Map<string, Occurrence[]>();
  const sentences = (text.match(SENTENCE_PATTERN) ?? [])
    .map((raw) => raw.trim())
    .filter((sentence) => sentence.length > 0);
  sentences.forEach((sentence, index) => {
    const context = [sentences[index - 1], sentences[index + 1]]
      .filter((item): item is string => item !== undefined);
    for (const match of sentence.normalize('NFKC').matchAll(TOKEN_PATTERN)) {
      const rawForm = match[0];
      const normalized = rawForm.toLocaleLowerCase('en');
      if (ORDINAL_FRAGMENT_PATTERN.test(normalized)) continue;
      const lemma = [lemmatizer.verb(normalized), lemmatizer.noun(normalized), lemmatizer.adjective(normalized)]
        .find((candidate) => candidate !== normalized) ?? normalized;
      let occurrences = groups.get(lemma);
      if (!occurrences) {
        occurrences = [];
        groups.set(lemma, occurrences);
      }
      occurrences.push({ rawForm, sentence, context });
    }
  });
  return [...groups.entries()].map(([lemma, occurrences]) => ({ lemma, occurrences }));
}

/** 一个 lemma 的一个义项及其分到的原始出现记录。 */
export interface TermSenseAssignment {
  /** 词元。 */
  lemma: string;
  /** 义项稳定标识；未匹配到词义库时为占位 'placeholder:1'。 */
  senseId: string;
  /** 义项词性；占位义项为 null。 */
  partOfSpeech: string | null;
  /** 义项释义。 */
  definition: string;
  /** 归入该义项的原始出现记录。 */
  occurrences: Occurrence[];
}

export interface AnalyzeMaterialInput {
  analysisId: string;
  material: Material;
  analyzerVersion: string;
  now: ISODateTime;
  /** 全部出现记录的义项归属；由应用层按词义库与消歧结果（或其兜底策略）生成。 */
  assignments: TermSenseAssignment[];
  /**
   * 被排除的词及其原因（词表过滤、词义库未收录）；
   * 逐词记入 unmatchedItems，在分析结果中可见但不生成知识点。
   */
  excludedTerms?: ExcludedTermInput[];
}

/** 被排除词的输入形态：词元、原因与全部出现记录。 */
export interface ExcludedTermInput {
  lemma: string;
  reason: string;
  occurrences: Occurrence[];
}

/**
 * 由义项归属组装固定版本的材料分析。
 * 同一 (lemma, senseId) 只构造一个知识点，ID 为 word:{lemma}:{senseId}，跨材料可稳定合并。
 */
export function analyzeMaterial(
  input: AnalyzeMaterialInput,
): Extract<MaterialAnalysis, { status: 'analyzed' }> {
  requireText(input.analysisId, 'analysisId');
  requireText(input.analyzerVersion, 'analyzerVersion');
  assertDateTime(input.now, 'now');
  if (!Array.isArray(input.assignments)) throw new Error('assignments must be an array');
  const unmatchedItems: MaterialUnmatchedItem[] = [];
  for (const excluded of input.excludedTerms ?? []) {
    requireText(excluded.lemma, 'excludedTerm.lemma');
    requireText(excluded.reason, 'excludedTerm.reason');
    if (!Array.isArray(excluded.occurrences) || excluded.occurrences.length === 0) {
      throw new Error('excludedTerm.occurrences must be a non-empty array');
    }
    unmatchedItems.push({ lemma: excluded.lemma, reason: excluded.reason, occurrences: [...excluded.occurrences] });
  }
  const items: MaterialAnalysisItem[] = [];
  const itemByKey = new Map<string, MaterialAnalysisItem>();
  for (const assignment of input.assignments) {
    requireText(assignment.lemma, 'assignment.lemma');
    requireText(assignment.senseId, 'assignment.senseId');
    requireText(assignment.definition, 'assignment.definition');
    if (!Array.isArray(assignment.occurrences) || assignment.occurrences.length === 0) {
      throw new Error('assignment.occurrences must be a non-empty array');
    }
    const key = `${assignment.lemma}::${assignment.senseId}`;
    let item = itemByKey.get(key);
    if (!item) {
      item = {
        knowledgePoint: {
          id: `word:${assignment.lemma}:${assignment.senseId}`,
          kind: 'word',
          lemma: assignment.lemma,
          wordFamily: assignment.lemma,
          sense: {
            id: assignment.senseId,
            definition: assignment.definition,
            partOfSpeech: assignment.partOfSpeech,
            explanation: null,
          },
        },
        occurrences: [],
      };
      itemByKey.set(key, item);
      items.push(item);
    }
    item.occurrences.push(...assignment.occurrences);
  }
  return {
    id: input.analysisId,
    materialId: input.material.id,
    analyzerVersion: input.analyzerVersion,
    status: 'analyzed',
    items,
    unmatchedItems,
    errors: [],
    createdAt: input.now,
    completedAt: input.now,
  };
}

export interface CreateLearningGoalInput {
  id: string;
  learnerId: string;
  title: string;
  targetFluency: FluencyScores;
  now: ISODateTime;
}

export function createLearningGoal(input: CreateLearningGoalInput): LearningGoal {
  requireText(input.id, 'id');
  requireText(input.learnerId, 'learnerId');
  assertFluencyScores(input.targetFluency);
  assertDateTime(input.now, 'now');
  return {
    id: input.id,
    learnerId: input.learnerId,
    title: input.title,
    targetFluency: { ...input.targetFluency },
    status: 'active',
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export interface AddAnalyzedMaterialToGoalInput {
  goal: LearningGoal;
  material: Material;
  analysis: Extract<MaterialAnalysis, { status: 'analyzed' }>;
  existingCandidates: GoalKnowledgePoint[];
  existingSources: GoalKnowledgePointSource[];
  addedAt: ISODateTime;
}

export interface AddAnalyzedMaterialToGoalResult {
  goal: LearningGoal;
  materialLink: GoalMaterial;
  knowledgePoints: KnowledgePoint[];
  candidates: GoalKnowledgePoint[];
  sources: GoalKnowledgePointSource[];
}

export function addAnalyzedMaterialToGoal(
  input: AddAnalyzedMaterialToGoalInput,
): AddAnalyzedMaterialToGoalResult {
  if (input.material.learnerId !== input.goal.learnerId) throw new Error('Material belongs to another learner');
  if (input.analysis.materialId !== input.material.id) throw new Error('Analysis belongs to another material');
  assertDateTime(input.addedAt, 'addedAt');
  const candidates = [...input.existingCandidates];
  const sources = [...input.existingSources];
  const knowledgePoints: KnowledgePoint[] = [];
  const seenKnowledgePoints = new Set<string>();
  for (const item of input.analysis.items) {
    const id = item.knowledgePoint.id;
    if (!seenKnowledgePoints.has(id)) {
      knowledgePoints.push(item.knowledgePoint);
      seenKnowledgePoints.add(id);
    }
    if (!candidates.some((candidate) => candidate.goalId === input.goal.id && candidate.knowledgePointId === id)) {
      candidates.push({
        goalId: input.goal.id,
        knowledgePointId: id,
        selection: 'undecided',
        addedAt: input.addedAt,
        selectionUpdatedAt: input.addedAt,
      });
    }
    if (!sources.some((source) => source.goalId === input.goal.id
      && source.knowledgePointId === id && source.sourceAnalysisId === input.analysis.id)) {
      sources.push({
        goalId: input.goal.id,
        knowledgePointId: id,
        sourceAnalysisId: input.analysis.id,
        addedAt: input.addedAt,
      });
    }
  }
  return {
    goal: { ...input.goal, updatedAt: input.addedAt },
    materialLink: {
      goalId: input.goal.id,
      materialId: input.material.id,
      analysisId: input.analysis.id,
      addedAt: input.addedAt,
    },
    knowledgePoints,
    candidates,
    sources,
  };
}

export interface SetGoalKnowledgePointSelectionInput {
  selection: GoalKnowledgePointSelection;
  now: ISODateTime;
}

export function setGoalKnowledgePointSelection(
  candidate: GoalKnowledgePoint,
  input: SetGoalKnowledgePointSelectionInput,
): GoalKnowledgePoint {
  assertDateTime(input.now, 'now');
  if (candidate.selection === input.selection) return { ...candidate };
  return { ...candidate, selection: input.selection, selectionUpdatedAt: input.now };
}

export interface ChangeLearningGoalStatusInput {
  status: LearningGoal['status'];
  now: ISODateTime;
}

export function changeLearningGoalStatus(
  goal: LearningGoal,
  input: ChangeLearningGoalStatusInput,
): LearningGoal {
  assertDateTime(input.now, 'now');
  if (goal.status === input.status) return { ...goal };
  return { ...goal, status: input.status, updatedAt: input.now };
}

export interface DeriveInitialFluencyInput {
  vocabulary: VocabularyEstimate;
  classification: KnowledgePointVocabularyClassification | null;
  policyVersion: string;
}

export interface DerivedInitialFluency {
  initialFluency: FluencyScores;
  initialization: LearnerKnowledgePointInitialization;
}

/**
 * 词段认识概率到初始 R 分数的离散档位映射。
 * 自评“认识”只有接受性证据，初始分只落到练习区档位，最高 50（free 档），
 * 任何词在产生真实练习证据前都进不了 FLUENCY 区（>=60）。
 */
function mapInitialReceptiveTier(probability: number): number {
  if (probability <= 0) return 0;
  if (probability < 0.4) return 10;
  if (probability < 0.7) return 30;
  return 50;
}

/** P 没有直接证据，在 R 的基础上自动退一个练习区档次，最低封底 0。 */
const PRODUCTION_ONE_TIER_DOWN: Record<number, number> = { 0: 0, 10: 0, 30: 10, 50: 30 };

export function deriveInitialFluency(input: DeriveInitialFluencyInput): DerivedInitialFluency {
  requireText(input.policyVersion, 'policyVersion');
  const classification = input.classification;
  if (classification && (classification.list.id !== input.vocabulary.list.id
    || classification.list.version !== input.vocabulary.list.version)) {
    throw new Error('Classification and vocabulary estimate use different lists');
  }
  const probability = classification
    ? input.vocabulary.bands.find((band) => band.band === classification.band)?.knownProbability ?? 0
    : 0;
  const receptive = mapInitialReceptiveTier(clamp(probability, 0, 1));
  const initialFluency = { R: receptive, P: PRODUCTION_ONE_TIER_DOWN[receptive] ?? 0 };
  return {
    initialFluency,
    initialization: {
      sourceVocabulary: clone(input.vocabulary),
      classification: classification ? clone(classification) : null,
      policyVersion: input.policyVersion,
      productionBasis: 'derived_from_receptive',
    },
  };
}

export interface InitializeLearnerKnowledgePointInput {
  learnerId: string;
  knowledgePoint: KnowledgePoint;
  derived: DerivedInitialFluency;
  now: ISODateTime;
}

export function initializeLearnerKnowledgePoint(
  input: InitializeLearnerKnowledgePointInput,
): LearnerKnowledgePoint {
  requireText(input.learnerId, 'learnerId');
  assertDateTime(input.now, 'now');
  assertFluencyScores(input.derived.initialFluency);
  if (input.derived.initialization.classification
    && input.derived.initialization.classification.knowledgePointId !== input.knowledgePoint.id) {
    throw new Error('Initialization classification belongs to another knowledge point');
  }
  const review = (): ReviewSchedule => ({
    intervalDays: 0,
    dueAt: input.now,
    lastReviewedAt: null,
    successfulReviewStreak: 0,
    lapseCount: 0,
    graduated: false,
  });
  return {
    learnerId: input.learnerId,
    knowledgePointId: input.knowledgePoint.id,
    initialFluency: { ...input.derived.initialFluency },
    initialization: clone(input.derived.initialization),
    dimensions: {
      R: { fluency: input.derived.initialFluency.R, review: review() },
      P: { fluency: input.derived.initialFluency.P, review: review() },
    },
    createdAt: input.now,
    updatedAt: input.now,
    version: 0,
  };
}

export interface TaskSpecificationBase {
  goalId: string;
  wordId: string;
}

export type TaskSpecification = TaskSpecificationBase & (
  | { task: 'ENCODE' }
  | { task: 'RETRIEVE'; axis: FluencyDimension; stage: RetrieveStage }
  | { task: 'FLUENCY'; axis: FluencyDimension }
);

export interface DecideNextTaskInput {
  goal: LearningGoal;
  candidate: GoalKnowledgePoint;
  knowledgePoint: KnowledgePoint;
  learning: LearnerKnowledgePoint | null;
  now: ISODateTime;
}

export function decideNextTask(input: DecideNextTaskInput): TaskSpecification | null {
  if (input.goal.status !== 'active' || input.candidate.selection !== 'included') return null;
  if (input.candidate.goalId !== input.goal.id
    || input.candidate.knowledgePointId !== input.knowledgePoint.id) {
    throw new Error('Goal, candidate, and knowledge point do not match');
  }
  const base = { goalId: input.goal.id, wordId: input.knowledgePoint.id };
  if (!input.learning) return { ...base, task: 'ENCODE' };
  if (input.learning.knowledgePointId !== input.knowledgePoint.id) {
    throw new Error('Learning state belongs to another knowledge point');
  }
  return decideNextTaskFromDimensions(
    input.goal,
    input.knowledgePoint,
    input.learning.dimensions,
    input.now,
  );
}

function decideNextTaskFromDimensions(
  goal: LearningGoal,
  knowledgePoint: KnowledgePoint,
  learningDimensions: Record<FluencyDimension, DimensionLearningState>,
  now: ISODateTime,
): TaskSpecification | null {
  const base = { goalId: goal.id, wordId: knowledgePoint.id };
  const nowTime = Date.parse(now);
  const dimensions = (['R', 'P'] as FluencyDimension[])
    .filter((dimension) => (!learningDimensions[dimension].review.graduated
      || learningDimensions[dimension].fluency < goal.targetFluency[dimension])
      && Date.parse(learningDimensions[dimension].review.dueAt) <= nowTime)
    .sort((a, b) => Date.parse(learningDimensions[a].review.dueAt)
      - Date.parse(learningDimensions[b].review.dueAt) || (a === 'R' ? -1 : 1));
  const dimension = dimensions[0];
  if (!dimension) return null;
  const fluency = learningDimensions[dimension].fluency;
  if (fluency >= goal.targetFluency[dimension]) return { ...base, task: 'FLUENCY', axis: dimension };
  if (fluency <= 0) return { ...base, task: 'ENCODE' };
  if (fluency < 60) {
    const stage: RetrieveStage = fluency < 20 ? 'choice' : fluency < 40 ? 'cued' : 'free';
    return { ...base, task: 'RETRIEVE', axis: dimension, stage };
  }
  return { ...base, task: 'FLUENCY', axis: dimension };
}

export interface GenerateLearningTaskInput {
  specification: TaskSpecification;
  knowledgePoint: KnowledgePoint;
  sourceMaterials: Material[];
}

export function generateLearningTask(input: GenerateLearningTaskInput): GeneratedTask {
  const target = knowledgePointName(input.knowledgePoint);
  const definition = input.knowledgePoint.sense.definition;
  const examples = input.sourceMaterials.flatMap((material) =>
    splitSentences(material.extractedText ?? '').filter((sentence) =>
      normalizeAnswer(sentence).includes(normalizeAnswer(target))))
    .slice(0, 2);
  const base = { schemaVersion: '1' as const, wordId: input.knowledgePoint.id };
  if (input.specification.task === 'ENCODE') {
    return {
      ...base,
      task: 'ENCODE',
      content: {
        word: target,
        ...(input.knowledgePoint.sense.partOfSpeech
          ? { partOfSpeech: input.knowledgePoint.sense.partOfSpeech }
          : {}),
        definition,
        examples: (examples.length ? examples : [`Use ${target} in a sentence.`])
          .map((sentence) => ({ sentence })),
        instruction: 'Read the word, meaning, and examples, then confirm when you are ready.',
      },
    };
  }
  if (input.specification.task === 'RETRIEVE') {
    const { axis, stage } = input.specification;
    if (stage === 'choice') {
      return {
        ...base,
        task: 'RETRIEVE',
        content: {
          axis,
          stage,
          prompt: axis === 'R' ? `What does ${target} mean?` : `Which expression means “${definition}”?`,
          options: axis === 'R'
            ? [{ id: 'a', text: definition }, { id: 'b', text: 'An unrelated meaning' }]
            : [{ id: 'a', text: target }, { id: 'b', text: 'A different expression' }],
          answerOptionId: 'a',
          explanation: `${target}: ${definition}`,
        },
      };
    }
    const acceptedAnswers = axis === 'R' ? [definition] : [target];
    const prompt = axis === 'R' ? `Explain the meaning of ${target}.` : `Express this meaning: ${definition}.`;
    const answerKey = { acceptedAnswers, explanation: `${target}: ${definition}` };
    if (stage === 'cued') {
      return {
        ...base,
        task: 'RETRIEVE',
        content: { axis, stage, prompt, cue: acceptedAnswers[0].slice(0, 1), answerKey },
      };
    }
    return { ...base, task: 'RETRIEVE', content: { axis, stage, prompt, answerKey } };
  }
  if (input.specification.axis === 'P') {
    return {
      ...base,
      task: 'FLUENCY',
      content: {
        axis: 'P',
        scenario: '请描述一个需要使用目标表达的日常生活场景。',
        responseInstruction: '请用英文自然地表达你的想法。',
        gradingRequirements: {
          targetExpression: target,
          targetUseCriteria: [`自然且正确地使用“${target}”。`],
          overallExpressionCriteria: ['表达完整、语义清楚。'],
        },
      },
    };
  }
  const passage = examples[0] ?? `This passage uses ${target}. ${target} appears here in a simple context.`;
  return {
    ...base,
    task: 'FLUENCY',
    content: {
      axis: 'R',
      passage,
      questions: [
        {
          id: 'target-meaning',
          role: 'target_meaning',
          kind: 'choice',
          prompt: `What does ${target} mean?`,
          evidence: passage,
          options: [{ id: 'a', text: definition }, { id: 'b', text: 'An unrelated meaning' }],
          answerOptionId: 'a',
        },
        {
          id: 'passage-comprehension',
          role: 'passage_comprehension',
          kind: 'free',
          prompt: 'Summarize the passage.',
          evidence: passage,
          answer: passage,
        },
      ],
      targetOccurrences: countOccurrences(passage, target),
    },
  };
}

/**
 * 任务校验的详细结果：reasons 为空表示通过。
 * malformed 表示输出连 GeneratedTask 的基本形状都不具备（缺字段/类型错误），
 * 应用层应将其归为 invalid_ai_output；纯值层面的违规则归为 spec_mismatch。
 */
export interface GeneratedTaskInspection {
  malformed: boolean;
  /** 未通过的具体原因（中文），供日志与 AI 重试反馈使用。 */
  reasons: string[];
}

/**
 * 校验 AI 生成的任务是否符合规格，并给出可读的失败原因。
 * targetLemma 为目标词形；传入时额外校验 FLUENCY-R 短文质量
 * （词数 80~100、目标词至少出现 3 次、声明次数与实际一致），不传则跳过该质量检查。
 */
export function inspectGeneratedTask(
  specification: TaskSpecification,
  generated: GeneratedTask,
  targetLemma?: string,
): GeneratedTaskInspection {
  const reasons: string[] = [];
  let malformed = false;
  const fail = (reason: string, isMalformed = false) => {
    reasons.push(reason);
    if (isMalformed) malformed = true;
  };

  if (!generated || typeof generated !== 'object' || generated.schemaVersion !== '1'
    || generated.task !== specification.task || generated.wordId !== specification.wordId
    || !generated.content || typeof generated.content !== 'object') {
    fail('顶层结构不符合规格（schemaVersion/task/wordId/content）');
    return { malformed, reasons };
  }

  if (specification.task === 'ENCODE') {
    if (generated.task !== 'ENCODE') return { malformed: true, reasons: ['task 与 content 结构不一致'] };
    const content = generated.content;
    if (typeof content.word !== 'string') fail('ENCODE 缺少 word 字段', true);
    else if (!content.word.trim()) fail('ENCODE word 不能为空');
    if (typeof content.definition !== 'string') fail('ENCODE 缺少 definition 字段', true);
    else if (!content.definition.trim()) fail('ENCODE definition 不能为空');
    if (typeof content.instruction !== 'string') fail('ENCODE 缺少 instruction 字段', true);
    else if (!content.instruction.trim()) fail('ENCODE instruction 不能为空');
    if (!Array.isArray(content.examples)) fail('ENCODE 缺少 examples 数组', true);
    else if (content.examples.length === 0) fail('ENCODE 至少需要一个例句');
    else if (!content.examples.every((example) => typeof example?.sentence === 'string' && example.sentence.trim())) {
      fail('ENCODE 例句不能为空');
    }
    return { malformed, reasons };
  }

  if (generated.task === 'ENCODE') return { malformed: true, reasons: ['task 与 content 结构不一致'] };
  if (generated.content.axis !== specification.axis) {
    fail(`axis 必须为 "${specification.axis}"`);
    return { malformed, reasons };
  }
  if (specification.task === 'RETRIEVE') {
    if (generated.task !== 'RETRIEVE') return { malformed: true, reasons: ['task 与 content 结构不一致'] };
    const content = generated.content;
    if (content.stage !== specification.stage) {
      fail(`stage 必须为 "${specification.stage}"`);
      return { malformed, reasons };
    }
    if (typeof content.prompt !== 'string' || !content.prompt.trim()) fail('RETRIEVE prompt 不能为空');
    if (content.stage === 'choice') {
      if (!Array.isArray(content.options)) fail('RETRIEVE-choice 缺少 options 数组', true);
      else if (content.options.length < 2) fail('RETRIEVE-choice 至少需要 2 个选项');
      else if (new Set(content.options.map((option) => option?.id)).size !== content.options.length) {
        fail('RETRIEVE-choice 选项 id 必须唯一');
      }
      else if (!content.options.every((option) => typeof option?.id === 'string' && option.id.trim()
        && typeof option?.text === 'string' && option.text.trim())) {
        fail('RETRIEVE-choice 选项 id 与 text 不能为空');
      }
      else if (!content.options.some((option) => option?.id === content.answerOptionId)) {
        fail('RETRIEVE-choice answerOptionId 必须指向一个存在的选项');
      }
      if (typeof content.explanation !== 'string' || !content.explanation.trim()) {
        fail('RETRIEVE-choice explanation 不能为空');
      }
      return { malformed, reasons };
    }
    if (!content.answerKey || typeof content.answerKey !== 'object') {
      fail('RETRIEVE 缺少 answerKey 对象', true);
    } else {
      if (!Array.isArray(content.answerKey.acceptedAnswers)) {
        fail('RETRIEVE 缺少 acceptedAnswers 数组', true);
      } else if (content.answerKey.acceptedAnswers.length === 0) {
        fail('RETRIEVE 至少需要一个可接受答案');
      } else if (!content.answerKey.acceptedAnswers.every((answer) => typeof answer === 'string' && answer.trim())) {
        fail('RETRIEVE 可接受答案不能为空');
      }
      if (typeof content.answerKey.explanation !== 'string' || !content.answerKey.explanation.trim()) {
        fail('RETRIEVE explanation 不能为空');
      }
    }
    if (content.stage === 'cued' && (typeof content.cue !== 'string' || !content.cue.trim())) {
      fail('RETRIEVE-cued cue 不能为空');
    }
    return { malformed, reasons };
  }

  if (generated.task !== 'FLUENCY') return { malformed: true, reasons: ['task 与 content 结构不一致'] };
  const content = generated.content;
  if (content.axis === 'R') {
    if (typeof content.passage !== 'string') fail('FLUENCY-R 缺少 passage 字段', true);
    else if (!content.passage.trim()) fail('FLUENCY-R passage 不能为空');
    else if (targetLemma) {
      const wordCount = content.passage.trim().split(/\s+/).length;
      if (wordCount < FLUENCY_PASSAGE_MIN_WORDS || wordCount > FLUENCY_PASSAGE_MAX_WORDS) {
        fail(`FLUENCY-R 短文必须为 ${FLUENCY_PASSAGE_MIN_WORDS}~${FLUENCY_PASSAGE_MAX_WORDS} 词（当前 ${wordCount} 词）`);
      }
      const actualOccurrences = countOccurrences(content.passage, targetLemma);
      if (actualOccurrences < FLUENCY_PASSAGE_MIN_TARGET_OCCURRENCES) {
        fail(`目标词 "${targetLemma}" 在短文中至少出现 ${FLUENCY_PASSAGE_MIN_TARGET_OCCURRENCES} 次（当前 ${actualOccurrences} 次）`);
      }
      if (content.targetOccurrences !== actualOccurrences) {
        fail(`targetOccurrences 与实际不符（声明 ${content.targetOccurrences} 次，实际 ${actualOccurrences} 次）`);
      }
    }
    if (!Array.isArray(content.questions)) fail('FLUENCY-R 缺少 questions 数组', true);
    else if (content.questions.length === 0) fail('FLUENCY-R 至少需要一个问题');
    else if (new Set(content.questions.map((question) => question?.id)).size !== content.questions.length) {
      fail('FLUENCY-R 问题 id 必须唯一');
    } else if (!content.questions.every((question) => question && typeof question === 'object'
      && typeof question.prompt === 'string' && question.prompt.trim()
      && typeof question.evidence === 'string' && question.evidence.trim()
      && typeof content.passage === 'string' && content.passage.includes(question.evidence)
      && (question.kind === 'choice'
        ? Array.isArray(question.options) && question.options.length >= 2
          && question.options.some((option) => option?.id === question.answerOptionId)
        : typeof question.answer === 'string' && Boolean(question.answer.trim())))) {
      fail('FLUENCY-R 问题字段不完整：prompt/evidence 非空且 evidence 逐字来自短文；选择题选项与答案有效，自由题答案非空');
    }
    if (!Number.isInteger(content.targetOccurrences) || content.targetOccurrences < 0) {
      fail('FLUENCY-R targetOccurrences 必须是非负整数');
    }
    return { malformed, reasons };
  }
  if (!content.gradingRequirements || typeof content.gradingRequirements !== 'object') {
    fail('FLUENCY-P 缺少 gradingRequirements 对象', true);
    return { malformed, reasons };
  }
  const requirements = content.gradingRequirements;
  if (typeof content.scenario !== 'string' || !content.scenario.trim()) fail('FLUENCY-P scenario 不能为空');
  if (typeof content.responseInstruction !== 'string' || !content.responseInstruction.trim()) {
    fail('FLUENCY-P responseInstruction 不能为空');
  }
  if (typeof requirements.targetExpression !== 'string') fail('FLUENCY-P 缺少 targetExpression 字段', true);
  else if (!requirements.targetExpression.trim()) fail('FLUENCY-P targetExpression 不能为空');
  if (!Array.isArray(requirements.targetUseCriteria)) fail('FLUENCY-P 缺少 targetUseCriteria 数组', true);
  else if (requirements.targetUseCriteria.length === 0) fail('FLUENCY-P 至少需要一个目标表达使用标准');
  if (!Array.isArray(requirements.overallExpressionCriteria)) fail('FLUENCY-P 缺少 overallExpressionCriteria 数组', true);
  else if (requirements.overallExpressionCriteria.length === 0) fail('FLUENCY-P 至少需要一个整体表达标准');
  if (Array.isArray(requirements.targetUseCriteria) && Array.isArray(requirements.overallExpressionCriteria)
    && ![...requirements.targetUseCriteria, ...requirements.overallExpressionCriteria]
      .every((criterion) => typeof criterion === 'string' && criterion.trim())) {
    fail('FLUENCY-P 评分标准不能为空');
  }
  return { malformed, reasons };
}

/** FLUENCY-R 短文词数下限/上限。 */
export const FLUENCY_PASSAGE_MIN_WORDS = 80;
export const FLUENCY_PASSAGE_MAX_WORDS = 100;
/** FLUENCY-R 短文中目标词至少出现的次数。 */
export const FLUENCY_PASSAGE_MIN_TARGET_OCCURRENCES = 3;

export function validateGeneratedTask(
  specification: TaskSpecification,
  generated: GeneratedTask,
  targetLemma?: string,
): boolean {
  return inspectGeneratedTask(specification, generated, targetLemma).reasons.length === 0;
}

export interface CreateLearningTaskInput {
  id: string;
  learnerId: string;
  specification: TaskSpecification;
  generated: GeneratedTask;
  issuedAt: ISODateTime;
}

export function createLearningTask(input: CreateLearningTaskInput): LearningTask {
  if (!validateGeneratedTask(input.specification, input.generated)) {
    throw new Error('Generated task does not match its specification');
  }
  requireText(input.id, 'id');
  requireText(input.learnerId, 'learnerId');
  assertDateTime(input.issuedAt, 'issuedAt');
  return {
    id: input.id,
    learnerId: input.learnerId,
    goalId: input.specification.goalId,
    issuedAt: input.issuedAt,
    status: 'issued',
    completedAt: null,
    content: clone(input.generated),
  } as LearningTask;
}

export function toLearningTaskView(task: LearningTask): LearningTaskView {
  const generated = task.content;
  const base = {
    id: task.id,
    learnerId: task.learnerId,
    goalId: task.goalId,
    issuedAt: task.issuedAt,
    status: task.status,
    completedAt: task.completedAt,
  } as const;
  if (generated.task === 'ENCODE') {
    return {
      ...base,
      content: {
        ...generated,
        content: {
          ...generated.content,
          examples: generated.content.examples.map((example) => ({ ...example })),
        },
      },
    } as LearningTaskView;
  }
  if (generated.task === 'RETRIEVE') {
    const content = generated.content;
    if (content.stage === 'choice') {
      return {
        ...base,
        content: {
          schemaVersion: '1',
          task: 'RETRIEVE',
          wordId: generated.wordId,
          content: {
            axis: content.axis,
            stage: content.stage,
            prompt: content.prompt,
            options: content.options.map((option) => ({ ...option })),
          },
        },
      } as LearningTaskView;
    }
    return {
      ...base,
      content: {
        schemaVersion: '1',
        task: 'RETRIEVE',
        wordId: generated.wordId,
        content: content.stage === 'cued'
          ? { axis: content.axis, stage: content.stage, prompt: content.prompt, cue: content.cue }
          : { axis: content.axis, stage: content.stage, prompt: content.prompt },
      },
    } as LearningTaskView;
  }
  if (generated.content.axis === 'R') {
    return {
      ...base,
      content: {
        schemaVersion: '1',
        task: 'FLUENCY',
        wordId: generated.wordId,
        content: {
          axis: 'R',
          passage: generated.content.passage,
          questions: generated.content.questions.map((question) => question.kind === 'choice'
            ? {
                id: question.id,
                role: question.role,
                kind: 'choice',
                prompt: question.prompt,
                options: question.options.map((option) => ({ ...option })),
              }
            : { id: question.id, role: question.role, kind: 'free', prompt: question.prompt }),
        },
      },
    } as LearningTaskView;
  }
  return {
    ...base,
    content: {
      schemaVersion: '1',
      task: 'FLUENCY',
      wordId: generated.wordId,
      content: {
        axis: 'P',
        scenario: generated.content.scenario,
        responseInstruction: generated.content.responseInstruction,
      },
    },
  } as LearningTaskView;
}

export interface PlanDailyStudyInput {
  learnerId: string;
  date: LocalDate;
  now: ISODateTime;
}

export type PlannedTask =
  | { source: 'existing'; taskId: string }
  | { source: 'new'; specification: TaskSpecification };

export interface DailyStudyDecision {
  learnerId: string;
  date: LocalDate;
  taskCapacity: number;
  tasks: PlannedTask[];
  expireTaskIds: string[];
  cancelTaskIds: string[];
}

/**
 * S07：生成每日排期决策。纯函数，只产出暂态决策，不修改状态、不创建任务。
 * 流程：① 清理已签发任务（范围失效的取消、历史日期的过期，既有任务不顺延）
 * → ② 今日计划中的既有任务优先保留 → ③ 收集 active 目标 included 候选的下一任务规格
 * → ④ 排序并填充新位置，其中新词需通过未来 42 天容量准入检查
 * → ⑤ 同词族任务（无词族信息时按词本身）在不打破优先级顺序的前提下拉开位置间隔，
 * 任务不足时保持原顺序。
 * 到期复习与新词引入共用本决策：调用方只传新的 date/now，复习间隔不在此处计算。
 */
export function planDailyStudy(
  state: Readonly<LearningState>,
  input: PlanDailyStudyInput,
): DailyStudyDecision {
  const learner = state.learners.find((item) => item.id === input.learnerId);
  if (!learner) throw new Error(`Learner not found: ${input.learnerId}`);
  assertLocalDate(input.date);
  assertDateTime(input.now, 'now');
  const tasks: PlannedTask[] = [];
  const expireTaskIds: string[] = [];
  const cancelTaskIds: string[] = [];
  const currentPlan = state.studyPlans.find((plan) => plan.learnerId === learner.id && plan.date === input.date);
  const currentIds = new Set(currentPlan?.taskIds ?? []);
  const oldTaskIds = new Set(state.studyPlans.filter((plan) => plan.learnerId === learner.id
    && plan.date < input.date).flatMap((plan) => plan.taskIds));
  // 任务是否仍属于有效学习范围：目标 active 且候选 included。
  const isEligible = (task: LearningTask): boolean => {
    const goal = state.goals.find((item) => item.id === task.goalId);
    const candidate = state.goalKnowledgePoints.find((item) => item.goalId === task.goalId
      && item.knowledgePointId === task.content.wordId);
    return goal?.status === 'active' && candidate?.selection === 'included';
  };
  // ① 清理已签发任务：范围失效的进取消；来自历史日期且不在今日计划中的进过期。
  for (const task of state.tasks.filter((item) => item.learnerId === learner.id && item.status === 'issued')) {
    if (!isEligible(task)) {
      cancelTaskIds.push(task.id);
    } else if (oldTaskIds.has(task.id) || (!currentIds.has(task.id)
      && localDateFor(task.issuedAt, learner.timezone) < input.date)) {
      expireTaskIds.push(task.id);
    }
  }
  const hasLearningEvidence = (learning: LearnerKnowledgePoint | null): boolean => Boolean(learning
    && (learning.dimensions.R.review.lastReviewedAt !== null
      || learning.dimensions.P.review.lastReviewedAt !== null));
  // 已占用的规格键：既有任务落位后，同规格的新候选不再重复生成。
  const occupied = new Set<string>();
  // 今日计划中尚无学习证据的任务先延迟，确认引入新词时再优先落位。
  const deferredNewTasks: LearningTask[] = [];
  // ② 既有任务优先：按今日计划顺序保留；容量缩减时溢出部分由决策给出取消。
  if (currentPlan) {
    for (const id of currentPlan.taskIds) {
      const task = state.tasks.find((item) => item.id === id);
      if (!task || task.status !== 'issued' || !isEligible(task)) continue;
      const learning = state.learnerKnowledgePoints.find((item) => item.learnerId === learner.id
        && item.knowledgePointId === task.content.wordId) ?? null;
      if (!hasLearningEvidence(learning)) {
        deferredNewTasks.push(task);
        continue;
      }
      if (tasks.length >= learner.dailyTaskCapacity) {
        cancelTaskIds.push(id);
        continue;
      }
      tasks.push({ source: 'existing', taskId: id });
      occupied.add(taskSpecificationKey(task.goalId, task.content));
    }
  }
  // ③ 候选范围：所有 active 目标下 selection 为 included 的知识点。
  const scopes: Array<{
    goal: LearningGoal;
    candidate: GoalKnowledgePoint;
    knowledgePoint: KnowledgePoint;
    learning: LearnerKnowledgePoint | null;
  }> = [];
  for (const goal of state.goals.filter((item) => item.learnerId === learner.id && item.status === 'active')) {
    for (const candidate of state.goalKnowledgePoints.filter((item) => item.goalId === goal.id
      && item.selection === 'included')) {
      const knowledgePoint = state.knowledgePoints.find((item) => item.id === candidate.knowledgePointId);
      if (!knowledgePoint) continue;
      const learning = state.learnerKnowledgePoints.find((item) => item.learnerId === learner.id
        && item.knowledgePointId === knowledgePoint.id) ?? null;
      scopes.push({ goal, candidate, knowledgePoint, learning });
    }
  }
  // 既有学习路径的全成功预测，构成新词准入的容量基线。
  let futureDemand = new Map<LocalDate, number>();
  const candidates: Array<{
    specification: TaskSpecification;
    dueAt: number;
    isNew: boolean;
    isNewWord: boolean;
    scope: (typeof scopes)[number];
  }> = [];
  for (const scope of scopes) {
    const { goal, candidate, knowledgePoint, learning } = scope;
    if (learning) {
      futureDemand = mergeCapacityDemand(futureDemand, forecastSuccessfulPath(
        goal,
        knowledgePoint,
        learning.dimensions,
        learner.timezone,
        input,
        false,
      ));
    }
    const specification = decideNextTask({ goal, candidate, knowledgePoint, learning, now: input.now });
    if (!specification) continue;
    const key = taskSpecificationKey(specification.goalId, specification);
    if (occupied.has(key)) continue;
    const dueAt = learning
      ? Math.min(...(['R', 'P'] as FluencyDimension[]).map((dimension) =>
        Date.parse(learning.dimensions[dimension].review.dueAt)))
      : Number.POSITIVE_INFINITY;
    candidates.push({
      specification,
      dueAt,
      isNew: learning === null,
      isNewWord: !hasLearningEvidence(learning),
      scope,
    });
  }
  // ④ 排序：复习（有学习证据）优先于新词；再按到期时间、goalId、wordId 稳定排序。
  candidates.sort((a, b) => Number(a.isNewWord) - Number(b.isNewWord)
    || a.dueAt - b.dueAt
    || a.specification.goalId.localeCompare(b.specification.goalId)
    || a.specification.wordId.localeCompare(b.specification.wordId));
  const deferredKeys = new Set(deferredNewTasks.map((task) => taskSpecificationKey(task.goalId, task.content)));
  // 延迟新任务只整体落位一次；容量不足时同样由决策给出取消。
  let deferredRetained = false;
  const retainDeferredNewTasks = (): void => {
    if (deferredRetained) return;
    deferredRetained = true;
    for (const task of deferredNewTasks) {
      if (tasks.length >= learner.dailyTaskCapacity) {
        cancelTaskIds.push(task.id);
        continue;
      }
      tasks.push({ source: 'existing', taskId: task.id });
      occupied.add(taskSpecificationKey(task.goalId, task.content));
    }
  };
  // 按排序填充新位置；延迟新任务与已占用规格被跳过。
  for (const candidate of candidates) {
    const key = taskSpecificationKey(candidate.specification.goalId, candidate.specification);
    if (deferredKeys.has(key) || occupied.has(key)) continue;
    if (candidate.isNewWord) retainDeferredNewTasks();
    if (tasks.length >= learner.dailyTaskCapacity) break;
    if (candidate.isNew) {
      // 新词准入：合并该词全成功路径后，任何未来日期超容量即停止引入（含后续新词）。
      const { goal, knowledgePoint } = candidate.scope;
      const proposedDemand = mergeCapacityDemand(futureDemand, forecastSuccessfulPath(
        goal,
        knowledgePoint,
        initialDimensionsForNewWord(state, learner, knowledgePoint, input.now),
        learner.timezone,
        input,
        true,
      ));
      if ([...proposedDemand.values()].some((count) => count > learner.dailyTaskCapacity)) break;
      futureDemand = proposedDemand;
    }
    occupied.add(key);
    tasks.push({ source: 'new', specification: candidate.specification });
  }
  // 当天没有新词候选时，延迟新任务也要在此落位。
  retainDeferredNewTasks();
  return {
    learnerId: learner.id,
    date: input.date,
    taskCapacity: learner.dailyTaskCapacity,
    tasks: spreadSameWordTasks(tasks, (position) => plannedTaskGroupKey(state, position)),
    expireTaskIds: [...new Set(expireTaskIds)],
    cancelTaskIds: [...new Set(cancelTaskIds)],
  };
}

/** 同一词族的相邻两次练习之间至少间隔的其它任务数。 */
const SAME_WORD_TASK_GAP = 5;

/** 分散的分组键：有词族信息时按词族，否则按词本身。 */
function plannedTaskGroupKey(state: Readonly<LearningState>, position: PlannedTask): string {
  const wordId = position.source === 'new'
    ? position.specification.wordId
    : state.tasks.find((task) => task.id === position.taskId)?.content.wordId ?? '';
  const knowledgePoint = state.knowledgePoints.find((item) => item.id === wordId);
  const wordFamily = knowledgePoint && 'wordFamily' in knowledgePoint ? knowledgePoint.wordFamily : null;
  return wordFamily ? `family:${wordFamily}` : `word:${wordId}`;
}

/**
 * ⑤ 同词族分散：同一词族的任务位置至少间隔 5 个其它任务。
 * 只把重复任务向后顺延、不提前任何任务，优先级顺序不被打破；
 * 任务总数不足以拉开时整体保持原顺序。
 */
function spreadSameWordTasks(
  tasks: PlannedTask[],
  groupKeyOf: (task: PlannedTask) => string,
): PlannedTask[] {
  const placedAt = new Map<string, number>();
  const result: PlannedTask[] = [];
  const pending: PlannedTask[] = [];
  const allowed = (wordId: string): boolean => {
    const last = placedAt.get(wordId);
    return last === undefined || result.length - last > SAME_WORD_TASK_GAP;
  };
  const flushPending = (): void => {
    let index = 0;
    while (index < pending.length) {
      const wordId = groupKeyOf(pending[index]);
      if (!allowed(wordId)) {
        index++;
        continue;
      }
      const [task] = pending.splice(index, 1);
      placedAt.set(wordId, result.length);
      result.push(task);
    }
  };
  for (const task of tasks) {
    flushPending();
    const wordId = groupKeyOf(task);
    if (allowed(wordId)) {
      placedAt.set(wordId, result.length);
      result.push(task);
    } else {
      pending.push(task);
    }
  }
  flushPending();
  return pending.length > 0 ? tasks : result;
}

/**
 * 按“全部成功”路径推演一个知识点从给定维度状态出发的复习序列，
 * 产出未来各本地日期的任务需求（不含今天，含第 41 天），用于新词准入的容量预测。
 * startsWithEncode 表示该词尚未学习，路径从今天的 ENCODE 开始。
 */
function forecastSuccessfulPath(
  goal: LearningGoal,
  knowledgePoint: KnowledgePoint,
  initialDimensions: Record<FluencyDimension, DimensionLearningState>,
  timezone: string,
  input: PlanDailyStudyInput,
  startsWithEncode: boolean,
): Map<LocalDate, number> {
  const demand = new Map<LocalDate, number>();
  const dimensions = clone(initialDimensions);
  const through = addLocalDays(input.date, 41);
  let initialEncode = startsWithEncode;
  while (true) {
    let specification: TaskSpecification | null;
    let reviewedAt: ISODateTime;
    if (initialEncode) {
      specification = { goalId: goal.id, wordId: knowledgePoint.id, task: 'ENCODE' };
      reviewedAt = input.now;
    } else {
      const nextDueAt = (['R', 'P'] as FluencyDimension[])
        .filter((dimension) => !dimensions[dimension].review.graduated
          || dimensions[dimension].fluency < goal.targetFluency[dimension])
        .map((dimension) => dimensions[dimension].review.dueAt)
        .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
      if (!nextDueAt) break;
      reviewedAt = Date.parse(nextDueAt) < Date.parse(input.now) ? input.now : nextDueAt;
      specification = decideNextTaskFromDimensions(goal, knowledgePoint, dimensions, reviewedAt);
    }
    if (!specification) break;
    const judgement: DimensionJudgement = specification.task === 'FLUENCY'
      ? {
        outcome: 'correct',
        score: 1,
        targetPassed: true,
        overallPassed: true,
        speedWpm: specification.axis === 'R' ? 300 : 60,
      }
      : { outcome: 'correct', score: 1 };
    const taskDate = localDateFor(reviewedAt, timezone);
    if (taskDate > through) break;
    if (taskDate > input.date) demand.set(taskDate, (demand.get(taskDate) ?? 0) + 1);
    const affected: FluencyDimension[] = specification.task === 'ENCODE'
      ? ['R', 'P']
      : [specification.axis];
    for (const dimension of affected) {
      const current = dimensions[dimension];
      const nextFluency = calculateFluency(specification, current.fluency, judgement);
      const target = goal.targetFluency[dimension];
      const isReview = current.fluency >= target;
      dimensions[dimension] = {
        fluency: nextFluency,
        review: calculateNextReviewSchedule({
          current: current.review,
          nextFluency,
          judgement,
          reviewedAt,
          review: isReview,
          targetReached: !isReview && nextFluency >= target,
        }),
      };
    }
    initialEncode = false;
  }
  return demand;
}

/**
 * 新词准入预测用的初始维度：学习者已定级时按词表分类派生初始流利度，否则从 0 开始；
 * 复习 dueAt 视为 now，即今天即到期、今天就要派第一个任务。
 */
function initialDimensionsForNewWord(
  state: Readonly<LearningState>,
  learner: Learner,
  knowledgePoint: KnowledgePoint,
  now: ISODateTime,
): Record<FluencyDimension, DimensionLearningState> {
  let initialFluency: FluencyScores = { R: 0, P: 0 };
  if (learner.currentVocabulary) {
    const classification = state.knowledgePointVocabularyClassifications.find((item) =>
      item.knowledgePointId === knowledgePoint.id
      && item.list.id === learner.currentVocabulary!.list.id
      && item.list.version === learner.currentVocabulary!.list.version) ?? null;
    initialFluency = deriveInitialFluency({
      vocabulary: learner.currentVocabulary,
      classification,
      policyVersion: 'future-capacity-forecast',
    }).initialFluency;
  }
  const review = (): ReviewSchedule => ({
    intervalDays: 0,
    dueAt: now,
    lastReviewedAt: null,
    successfulReviewStreak: 0,
    lapseCount: 0,
    graduated: false,
  });
  return {
    R: { fluency: initialFluency.R, review: review() },
    P: { fluency: initialFluency.P, review: review() },
  };
}

/** 合并两组按本地日期计数的容量需求。 */
function mergeCapacityDemand(
  base: ReadonlyMap<LocalDate, number>,
  added: ReadonlyMap<LocalDate, number>,
): Map<LocalDate, number> {
  const merged = new Map(base);
  for (const [date, count] of added) merged.set(date, (merged.get(date) ?? 0) + count);
  return merged;
}

export interface ApplyDailyStudyDecisionInput {
  planId?: string;
  decision: DailyStudyDecision;
  newTasks: LearningTask[];
  now: ISODateTime;
}

export function applyDailyStudyDecision(
  state: Readonly<LearningState>,
  input: ApplyDailyStudyDecisionInput,
): LearningState {
  const { decision } = input;
  if (!state.learners.some((learner) => learner.id === decision.learnerId)) {
    throw new Error(`Learner not found: ${decision.learnerId}`);
  }
  if (decision.tasks.length > decision.taskCapacity) throw new Error('Decision exceeds task capacity');
  const newPositions = decision.tasks.filter((task) => task.source === 'new');
  if (newPositions.length !== input.newTasks.length) throw new Error('Every new position requires one generated task');
  const existingPlan = state.studyPlans.find((plan) => plan.learnerId === decision.learnerId
    && plan.date === decision.date);
  if (!existingPlan && !input.planId) throw new Error('planId is required for a new daily plan');
  const taskIds: string[] = [];
  let newIndex = 0;
  for (const position of decision.tasks) {
    if (position.source === 'existing') {
      const task = state.tasks.find((item) => item.id === position.taskId);
      if (!task || task.learnerId !== decision.learnerId || task.status !== 'issued') {
        throw new Error(`Existing task is not issued: ${position.taskId}`);
      }
      taskIds.push(position.taskId);
    } else {
      const task = input.newTasks[newIndex++];
      if (!task || task.learnerId !== decision.learnerId || task.status !== 'issued'
        || !validateGeneratedTask(position.specification, task.content)
        || task.goalId !== position.specification.goalId) {
        throw new Error('New task does not match its planned specification');
      }
      if (state.tasks.some((item) => item.id === task.id)) throw new Error(`Task already exists: ${task.id}`);
      taskIds.push(task.id);
    }
  }
  assertUnique(taskIds, 'planned task IDs');
  assertUnique(input.newTasks.map((task) => task.id), 'new task IDs');
  const changed = new Set([...decision.expireTaskIds, ...decision.cancelTaskIds]);
  if (changed.size !== decision.expireTaskIds.length + decision.cancelTaskIds.length) {
    throw new Error('A task cannot be both expired and cancelled');
  }
  if ([...changed].some((id) => taskIds.includes(id))) throw new Error('A retained task cannot be expired or cancelled');
  const tasks = state.tasks.map((task) => {
    if (decision.expireTaskIds.includes(task.id)) return { ...task, status: 'expired', completedAt: null } as LearningTask;
    if (decision.cancelTaskIds.includes(task.id)) return { ...task, status: 'cancelled', completedAt: null } as LearningTask;
    return task;
  });
  tasks.push(...input.newTasks);
  const plan = {
    id: existingPlan?.id ?? input.planId!,
    learnerId: decision.learnerId,
    date: decision.date,
    taskCapacity: decision.taskCapacity,
    taskIds,
    createdAt: existingPlan?.createdAt ?? input.now,
    updatedAt: input.now,
  };
  return {
    ...state,
    studyPlans: existingPlan
      ? state.studyPlans.map((item) => item === existingPlan ? plan : item)
      : [...state.studyPlans, plan],
    tasks,
  };
}

export interface RecordTaskAttemptInput {
  attemptId: string;
  taskId: string;
  submission: TaskSubmission;
  validity: AttemptValidity;
  receivedAt: ISODateTime;
}

export interface RecordTaskAttemptResult {
  state: LearningState;
  attempt:
    | Extract<TaskAttempt, { status: 'received' }>
    | Extract<TaskAttempt, { status: 'invalid' | 'unavailable' }>;
}

export function recordTaskAttempt(
  state: Readonly<LearningState>,
  input: RecordTaskAttemptInput,
): RecordTaskAttemptResult {
  if (state.attempts.some((attempt) => attempt.id === input.attemptId || attempt.taskId === input.taskId)) {
    throw new Error('Attempt ID and task ID must be unique');
  }
  const task = state.tasks.find((item) => item.id === input.taskId);
  if (!task) throw new Error(`Task not found: ${input.taskId}`);
  assertDateTime(input.receivedAt, 'receivedAt');
  const base = {
    id: input.attemptId,
    taskId: input.taskId,
    learnerId: task.learnerId,
    submission: clone(input.submission),
    validity: { ...input.validity },
    receivedAt: input.receivedAt,
  };
  let attempt: RecordTaskAttemptResult['attempt'];
  if (task.status !== 'issued') {
    attempt = { ...base, status: 'unavailable', judgement: null, settlement: null, statusReason: 'Task is not issued' };
  } else if (input.validity.interrupted || !Number.isFinite(input.validity.elapsedMs)
    || input.validity.elapsedMs < 0) {
    attempt = { ...base, status: 'invalid', judgement: null, settlement: null, statusReason: 'Attempt timing or continuity is invalid' };
  } else {
    const submissionError = validateSubmission(task, input.submission);
    attempt = submissionError
      ? { ...base, status: 'invalid', judgement: null, settlement: null, statusReason: submissionError }
      : { ...base, status: 'received', judgement: null, settlement: null, statusReason: null };
  }
  return { state: { ...state, attempts: [...state.attempts, attempt] }, attempt };
}

export interface StartTaskAttemptJudgingInput {
  attemptId: string;
}

export interface StartTaskAttemptJudgingResult {
  state: LearningState;
  attempt: Extract<TaskAttempt, { status: 'judging' }>;
}

export function startTaskAttemptJudging(
  state: Readonly<LearningState>,
  input: StartTaskAttemptJudgingInput,
): StartTaskAttemptJudgingResult {
  const current = state.attempts.find((attempt) => attempt.id === input.attemptId);
  if (!current || current.status !== 'received') throw new Error('Only a received attempt can start judging');
  const attempt: Extract<TaskAttempt, { status: 'judging' }> = { ...current, status: 'judging' };
  return {
    state: { ...state, attempts: state.attempts.map((item) => item.id === attempt.id ? attempt : item) },
    attempt,
  };
}

export interface JudgeTaskInput {
  task: LearningTask;
  submission: TaskSubmission;
  judgedAt: ISODateTime;
  elapsedMs?: number;
}

export function judgeTask(input: JudgeTaskInput): TaskJudgement {
  const error = validateSubmission(input.task, input.submission);
  if (error) throw new Error(error);
  assertDateTime(input.judgedAt, 'judgedAt');
  const generated = input.task.content;
  let dimensions: Partial<Record<FluencyDimension, DimensionJudgement>>;
  let feedback: string;
  if (generated.task === 'ENCODE') {
    dimensions = { R: { outcome: 'correct', score: 1 }, P: { outcome: 'correct', score: 1 } };
    feedback = 'Completed';
  } else if (generated.task === 'RETRIEVE') {
    const content = generated.content;
    const submission = input.submission;
    if (submission.task !== 'RETRIEVE') throw new Error('Submission task mismatch');
    const correct = content.stage === 'choice' && submission.stage === 'choice'
      ? submission.selectedOptionId === content.answerOptionId
      : content.stage !== 'choice' && submission.stage !== 'choice'
        && content.answerKey.acceptedAnswers.some((answer) => normalizeAnswer(answer) === normalizeAnswer(submission.answer));
    dimensions = { [content.axis]: dimensionJudgement(correct ? 1 : 0) };
    feedback = correct ? 'Correct' : 'Incorrect';
  } else if (generated.content.axis === 'R') {
    if (input.submission.task !== 'FLUENCY' || input.submission.axis !== 'R') throw new Error('Submission axis mismatch');
    const answers = input.submission.answers;
    const exactVerdicts: ReadingFreeQuestionVerdict[] = generated.content.questions
      .filter((question) => question.kind === 'free')
      .map((question) => ({
        questionId: question.id,
        correct: (() => {
          const answer = answers.find((item) => item.questionId === question.id);
          return question.kind === 'free' && answer?.kind === 'free'
            && normalizeAnswer(answer.answer) === normalizeAnswer(question.answer);
        })(),
      }));
    const dimension = judgeReadingFluencyAnswers(generated.content, input.submission, exactVerdicts);
    dimensions = { R: dimension };
    const total = generated.content.questions.length;
    feedback = `${Math.round(dimension.score * total)}/${total} answers correct`;
  } else {
    if (input.submission.task !== 'FLUENCY' || input.submission.axis !== 'P') throw new Error('Submission axis mismatch');
    if (!Number.isFinite(input.elapsedMs) || input.elapsedMs! <= 0) {
      throw new Error('Production fluency judging requires positive elapsedMs');
    }
    const targetPassed = normalizeAnswer(input.submission.response)
      .includes(normalizeAnswer(generated.content.gradingRequirements.targetExpression));
    const overallPassed = targetPassed;
    const speedWpm = productionSpeedWpm(input.submission.response, input.elapsedMs!);
    dimensions = { P: { ...dimensionJudgement(targetPassed ? 1 : 0), targetPassed, overallPassed, speedWpm } };
    feedback = targetPassed ? 'Target expression used' : 'Target expression was not used correctly';
  }
  return { taskId: input.task.id, dimensions, feedback, judgedBy: 'rule', judgedAt: input.judgedAt };
}

/** 阅读自由问题的语义正误；由调用方通过规则精确匹配或 AI 语义评判得出。 */
export interface ReadingFreeQuestionVerdict {
  questionId: string;
  correct: boolean;
}

/**
 * 汇总阅读流利度任务各题正误为 R 维度评判证据：选择题按提交答案规则判定，
 * 自由题采用调用方给出的正误，并计算目标/整体通过与阅读速度。
 */
export function judgeReadingFluencyAnswers(
  content: ReadingFluencyTaskContent,
  submission: ReadingFluencyTaskSubmission,
  freeQuestionVerdicts: ReadingFreeQuestionVerdict[],
): DimensionJudgement {
  const answers = new Map(submission.answers.map((answer) => [answer.questionId, answer]));
  const freeVerdicts = new Map(freeQuestionVerdicts.map((verdict) => [verdict.questionId, verdict.correct]));
  const freeQuestionIds = new Set<string>();
  for (const question of content.questions) {
    if (question.kind !== 'free') continue;
    if (!answers.has(question.id)) throw new Error(`Missing answer for question: ${question.id}`);
    if (!freeVerdicts.has(question.id)) throw new Error(`Missing verdict for free question: ${question.id}`);
    freeQuestionIds.add(question.id);
  }
  for (const questionId of freeVerdicts.keys()) {
    if (!freeQuestionIds.has(questionId)) throw new Error(`Verdict does not match a free question: ${questionId}`);
  }
  const isCorrect = (question: (typeof content.questions)[number]): boolean => {
    if (question.kind === 'free') return freeVerdicts.get(question.id) === true;
    const answer = answers.get(question.id);
    return answer?.kind === 'choice' && answer.selectedOptionId === question.answerOptionId;
  };
  const targetQuestions = content.questions.filter((question) => question.role === 'target_meaning');
  const targetPassed = targetQuestions.length > 0 && targetQuestions.every(isCorrect);
  const correct = content.questions.filter(isCorrect).length;
  const overallPassed = correct === content.questions.length;
  const score = content.questions.length === 0 ? 0 : correct / content.questions.length;
  const speedWpm = countWords(content.passage) * 60000 / submission.readingElapsedMs;
  return { ...dimensionJudgement(score), targetPassed, overallPassed, speedWpm };
}

/** 按产出词数与作答总耗时计算 P 维速度（词/分钟）。 */
export function productionSpeedWpm(response: string, elapsedMs: number): number {
  return countWords(response) * 60000 / elapsedMs;
}

export interface CalculateNextFluencyInput {
  task: LearningTask;
  dimension: FluencyDimension;
  currentFluency: number;
  judgement: DimensionJudgement;
}

type FluencyScoringTask =
  | { task: 'ENCODE' }
  | { task: 'RETRIEVE'; stage: RetrieveStage }
  | { task: 'FLUENCY'; axis: FluencyDimension };

export function calculateNextFluency(input: CalculateNextFluencyInput): number {
  const generated = input.task.content;
  const task: FluencyScoringTask = generated.task === 'ENCODE'
    ? { task: 'ENCODE' }
    : generated.task === 'RETRIEVE'
      ? { task: 'RETRIEVE', stage: generated.content.stage }
      : { task: 'FLUENCY', axis: generated.content.axis };
  return calculateFluency(task, input.currentFluency, input.judgement);
}

function calculateFluency(
  task: FluencyScoringTask,
  currentFluency: number,
  judgement: DimensionJudgement,
): number {
  if (!Number.isFinite(currentFluency) || currentFluency < 0) throw new RangeError('Invalid current fluency');
  if (task.task === 'ENCODE') {
    return judgement.outcome === 'correct' ? Math.max(5, currentFluency) : currentFluency;
  }
  if (task.task === 'RETRIEVE') {
    const table = {
      choice: { pass: 20, fail: 5 },
      cued: { pass: 40, fail: 5 },
      free: { pass: 60, fail: 20 },
    } as const;
    return table[task.stage][judgement.outcome === 'correct' ? 'pass' : 'fail'];
  }
  if (typeof judgement.targetPassed !== 'boolean'
    || typeof judgement.overallPassed !== 'boolean'
    || judgement.speedWpm === undefined) {
    throw new Error('Fluency judgement requires targetPassed, overallPassed, and speedWpm');
  }
  const speedWpm = judgement.speedWpm;
  if (!Number.isFinite(speedWpm) || speedWpm <= 0) return currentFluency;
  if (!judgement.targetPassed) return 40;
  if (!judgement.overallPassed) return currentFluency;
  const threshold = task.axis === 'R' ? 150 : 25;
  if (speedWpm < threshold) return 40;
  return task.axis === 'R'
    ? Math.min(100, 60 + (speedWpm - 150) / 3.75)
    : Math.min(100, 60 + (speedWpm - 25) * 40 / 35);
}

export interface CalculateNextReviewScheduleInput {
  current: ReviewSchedule;
  nextFluency: number;
  judgement: DimensionJudgement;
  reviewedAt: ISODateTime;
  review: boolean;
  targetReached: boolean;
}

export function calculateNextReviewSchedule(
  input: CalculateNextReviewScheduleInput,
): ReviewSchedule {
  assertDateTime(input.reviewedAt, 'reviewedAt');
  if (!Number.isFinite(input.nextFluency) || input.nextFluency < 0) throw new RangeError('Invalid next fluency');
  let intervalDays: number;
  let successfulReviewStreak = input.current.successfulReviewStreak;
  let lapseCount = input.current.lapseCount;
  let graduated = false;
  if (input.judgement.outcome === 'correct') {
    if (input.review && input.current.intervalDays === 30) {
      successfulReviewStreak++;
      intervalDays = 30;
      graduated = true;
    } else if (input.targetReached) {
      successfulReviewStreak = 1;
      intervalDays = 1;
    } else {
      successfulReviewStreak++;
      intervalDays = [1, 3, 7, 30][Math.min(successfulReviewStreak - 1, 3)];
    }
  } else if (input.judgement.outcome === 'incorrect') {
    successfulReviewStreak = 0;
    lapseCount++;
    intervalDays = 0;
  } else {
    intervalDays = Math.max(1, input.current.intervalDays);
  }
  return {
    intervalDays,
    dueAt: graduated
      ? input.current.dueAt
      : new Date(Date.parse(input.reviewedAt) + intervalDays * 86400000).toISOString(),
    lastReviewedAt: input.reviewedAt,
    successfulReviewStreak,
    lapseCount,
    graduated,
  };
}

export interface UpdateVocabularyEstimateInput {
  before: VocabularyEstimate;
  knowledgePoint: KnowledgePoint;
  classification: KnowledgePointVocabularyClassification | null;
  task: LearningTask;
  judgement: TaskJudgement;
  estimatedAt: ISODateTime;
}

export function updateVocabularyEstimate(input: UpdateVocabularyEstimateInput): VocabularyEstimate {
  if (input.task.content.wordId !== input.knowledgePoint.id || input.judgement.taskId !== input.task.id) {
    throw new Error('Vocabulary update evidence does not match the task');
  }
  if (input.classification) {
    if (input.classification.knowledgePointId !== input.knowledgePoint.id
      || input.classification.list.id !== input.before.list.id
      || input.classification.list.version !== input.before.list.version) {
      throw new Error('Classification does not match the vocabulary estimate');
    }
  }
  const after = clone(input.before);
  after.estimatedAt = input.estimatedAt;
  if (!input.classification) return after;
  const band = after.bands.find((item) => item.band === input.classification!.band);
  const judgement = input.judgement.dimensions.R ?? input.judgement.dimensions.P;
  if (!band || !judgement) return after;
  band.sampleCount++;
  if (judgement.outcome === 'correct') band.knownCount++;
  band.knownProbability = band.knownCount / band.sampleCount;
  band.interval = wilsonInterval(band.knownCount, band.sampleCount);
  return after;
}

export interface SettleTaskAttemptInput {
  attemptId: string;
  judgement: TaskJudgement;
  now: ISODateTime;
}

export interface SettleTaskAttemptResult {
  state: LearningState;
  attempt: Extract<TaskAttempt, { status: 'settled' }>;
}

export function settleTaskAttempt(
  state: Readonly<LearningState>,
  input: SettleTaskAttemptInput,
): SettleTaskAttemptResult {
  const current = state.attempts.find((attempt) => attempt.id === input.attemptId);
  if (!current || (current.status !== 'received' && current.status !== 'judging')) {
    throw new Error('Only a received or judging attempt can be settled');
  }
  const task = state.tasks.find((item) => item.id === current.taskId);
  if (!task || task.status !== 'issued') throw new Error('Only an issued task can be settled');
  if (input.judgement.taskId !== task.id) throw new Error('Judgement belongs to another task');
  if (current.validity.interrupted || !Number.isFinite(current.validity.elapsedMs) || current.validity.elapsedMs < 0) {
    throw new Error('Invalid attempts cannot be settled');
  }
  const submissionError = validateSubmission(task, current.submission);
  if (submissionError) throw new Error(submissionError);
  const learner = state.learners.find((item) => item.id === current.learnerId);
  const learning = state.learnerKnowledgePoints.find((item) => item.learnerId === current.learnerId
    && item.knowledgePointId === task.content.wordId);
  const knowledgePoint = state.knowledgePoints.find((item) => item.id === task.content.wordId);
  const goal = state.goals.find((item) => item.id === task.goalId);
  if (!learner?.currentVocabulary || !learning || !knowledgePoint || !goal) {
    throw new Error('Settlement requires learner vocabulary, goal, and initialized knowledge-point state');
  }
  const judgedDimensions = Object.entries(input.judgement.dimensions)
    .filter((entry): entry is [FluencyDimension, DimensionJudgement] => Boolean(entry[1]));
  if (judgedDimensions.length === 0) throw new Error('Judgement must contain at least one dimension');
  const allowedDimensions = task.content.task === 'ENCODE' ? ['R', 'P'] : [task.content.content.axis];
  if (judgedDimensions.some(([dimension]) => !allowedDimensions.includes(dimension))) {
    throw new Error('Judgement contains a dimension not assessed by the task');
  }
  const dimensions = clone(learning.dimensions);
  const fluencyChanges = [];
  const reviewChanges = [];
  for (const [dimension, judgement] of judgedDimensions) {
    if (task.content.task === 'FLUENCY'
      && (judgement.speedWpm === undefined || !Number.isFinite(judgement.speedWpm) || judgement.speedWpm <= 0)) {
      throw new Error('Invalid fluency judgement speed');
    }
    const before = learning.dimensions[dimension];
    const nextFluency = calculateNextFluency({ task, dimension, currentFluency: before.fluency, judgement });
    const target = goal.targetFluency[dimension];
    const isReview = before.fluency >= target;
    const scheduleJudgement = task.content.task === 'FLUENCY'
      ? dimensionJudgement(judgement.targetPassed === true
        && judgement.overallPassed === true
        && nextFluency >= target ? 1 : 0)
      : judgement;
    const review = calculateNextReviewSchedule({
      current: before.review,
      nextFluency,
      judgement: scheduleJudgement,
      reviewedAt: input.now,
      review: isReview,
      targetReached: !isReview && nextFluency >= target,
    });
    dimensions[dimension] = { fluency: nextFluency, review };
    fluencyChanges.push({
      knowledgePointId: learning.knowledgePointId,
      dimension,
      before: before.fluency,
      after: nextFluency,
    });
    reviewChanges.push({
      knowledgePointId: learning.knowledgePointId,
      dimension,
      before: clone(before.review),
      after: clone(review),
    });
  }
  const updatedLearning: LearnerKnowledgePoint = {
    ...learning,
    dimensions,
    updatedAt: input.now,
    version: learning.version + 1,
  };
  const classification = state.knowledgePointVocabularyClassifications.find((item) =>
    item.knowledgePointId === knowledgePoint.id
    && item.list.id === learner.currentVocabulary!.list.id
    && item.list.version === learner.currentVocabulary!.list.version) ?? null;
  const vocabularyAfter = updateVocabularyEstimate({
    before: learner.currentVocabulary,
    knowledgePoint,
    classification,
    task,
    judgement: input.judgement,
    estimatedAt: input.now,
  });
  const settlement = {
    fluencyChanges,
    reviewChanges,
    vocabularyBefore: clone(learner.currentVocabulary),
    vocabularyAfter,
    settledAt: input.now,
  };
  const attempt: Extract<TaskAttempt, { status: 'settled' }> = {
    ...current,
    status: 'settled',
    judgement: clone(input.judgement),
    settlement,
    statusReason: null,
  };
  const completedTask: LearningTask = { ...task, status: 'completed', completedAt: input.now };
  const updatedLearner: Learner = { ...learner, currentVocabulary: vocabularyAfter, updatedAt: input.now };
  return {
    state: {
      ...state,
      learners: state.learners.map((item) => item.id === learner.id ? updatedLearner : item),
      learnerKnowledgePoints: state.learnerKnowledgePoints.map((item) => item === learning ? updatedLearning : item),
      tasks: state.tasks.map((item) => item.id === task.id ? completedTask : item),
      attempts: state.attempts.map((item) => item.id === attempt.id ? attempt : item),
    },
    attempt,
  };
}

function requireText(value: string, path: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new RangeError(`${path} must not be empty`);
}

function assertNonNegativeInteger(value: number, path: string): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${path} must be a non-negative integer`);
}

function assertTimezone(value: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
  } catch {
    throw new RangeError(`Invalid IANA timezone: ${value}`);
  }
}

function assertDateTime(value: string, path: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new RangeError(`${path} must be an ISO date-time`);
}

function assertLocalDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new RangeError('date must be an ISO local date');
  }
}

function assertUnique(values: string[], path: string): void {
  if (new Set(values).size !== values.length) throw new RangeError(`${path} must be unique`);
}

function assertFluencyScores(scores: FluencyScores): void {
  for (const dimension of ['R', 'P'] as const) {
    if (!Number.isFinite(scores[dimension]) || scores[dimension] < 0) {
      throw new RangeError(`targetFluency.${dimension} must be non-negative`);
    }
  }
}

function compareBands(a: VocabularyBand, b: VocabularyBand): number {
  return Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b);
}

function createRandom(seed: string): () => number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  let state = hash >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function wilsonInterval(correct: number, total: number) {
  const z = 1.96;
  const probability = correct / total;
  const denominator = 1 + z * z / total;
  const center = (probability + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt(probability * (1 - probability) / total + z * z / (4 * total * total)) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), level: 0.95 };
}

function splitSentences(text: string): string[] {
  return (text.match(/[^.!?…\n]+[.!?…]+|[^.!?…\n]+$/g) ?? []).map((sentence) => sentence.trim()).filter(Boolean);
}

export function knowledgePointName(knowledgePoint: KnowledgePoint): string {
  return knowledgePoint.kind === 'word' || knowledgePoint.kind === 'phrase'
    ? knowledgePoint.lemma
    : knowledgePoint.name;
}

function countOccurrences(text: string, target: string): number {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (text.match(new RegExp(`\\b${escaped}\\b`, 'giu')) ?? []).length;
}

function taskSpecificationKey(goalId: string, task: TaskSpecification | GeneratedTask): string {
  const axis = task.task === 'ENCODE'
    ? 'both'
    : 'content' in task ? task.content.axis : task.axis;
  return `${goalId}:${task.wordId}:${axis}`;
}

function localDateFor(value: ISODateTime, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function addLocalDays(date: LocalDate, days: number): LocalDate {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function validateSubmission(task: LearningTask, submission: TaskSubmission): string | null {
  const generated = task.content;
  if (!submission || submission.task !== generated.task) return 'Submission task type does not match';
  if (generated.task === 'ENCODE') return null;
  if (generated.task === 'RETRIEVE') {
    if (submission.task !== 'RETRIEVE' || submission.stage !== generated.content.stage) return 'Submission stage does not match';
    if (generated.content.stage === 'choice') {
      return submission.stage === 'choice' && generated.content.options.some((option) => option.id === submission.selectedOptionId)
        ? null : 'Selected option is not available';
    }
    return submission.stage !== 'choice' && submission.answer.trim() ? null : 'Answer must not be empty';
  }
  if (submission.task !== 'FLUENCY' || submission.axis !== generated.content.axis) return 'Submission axis does not match';
  if (generated.content.axis === 'P') {
    return submission.axis === 'P' && submission.response.trim() ? null : 'Response must not be empty';
  }
  if (submission.axis !== 'R' || !Number.isFinite(submission.readingElapsedMs) || submission.readingElapsedMs <= 0) {
    return 'Reading time is invalid';
  }
  const questionIds = new Set(generated.content.questions.map((question) => question.id));
  const answerIds = new Set(submission.answers.map((answer) => answer.questionId));
  if (answerIds.size !== submission.answers.length || answerIds.size !== questionIds.size
    || [...questionIds].some((id) => !answerIds.has(id))) return 'Answers must cover every question exactly once';
  for (const answer of submission.answers) {
    const question = generated.content.questions.find((item) => item.id === answer.questionId)!;
    if (answer.kind !== question.kind) return 'Answer kind does not match question';
    if (question.kind === 'choice' && answer.kind === 'choice'
      && !question.options.some((option) => option.id === answer.selectedOptionId)) return 'Selected option is not available';
    if (answer.kind === 'free' && !answer.answer.trim()) return 'Answer must not be empty';
  }
  return null;
}

function countWords(value: string): number {
  const normalized = normalizeAnswer(value);
  return normalized ? normalized.split(' ').length : 0;
}

function normalizeAnswer(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

function dimensionJudgement(score: number): DimensionJudgement {
  return { outcome: score === 1 ? 'correct' : score > 0 ? 'partial' : 'incorrect', score };
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
