/**
 * S09 测试共享夹具：内存状态仓库（含并发注入包装）、S07→S08 真实流水线、
 * 大场景同源的六知识点状态。P1～P5 的决策由真实 planDailyStudy 产出，
 * 新任务由真实 S08 用例 + Fake AI Provider 生成，失败路径再手工构造非法输入。
 */

import { generateLearningTaskUseCase } from '../../lib/application/task-generation';
import { InMemoryLearningStateRepository } from '../../lib/application/repository';
import type { LearningStateRepository } from '../../lib/application/repository';
import { createLearningTask, planDailyStudy } from '../../lib/domain/functions';
import type { DailyStudyDecision, TaskSpecification } from '../../lib/domain/functions';
import type * as Model from '../../lib/domain/model';
import type {
  LearningTaskRepository,
  TaskGenerationAIProvider,
  TaskGenerationAIRequest,
} from '../../lib/application/ports';
import {
  aiOutputs,
  analysis,
  goal,
  goalId,
  knowledgePoints,
  learnerId,
  material,
  silentLogger,
  FakeTaskAIProvider,
  InMemoryTaskRepository,
} from './task-generation-fixture';

export { silentLogger };

export const at = {
  created: '2026-11-10T00:00:00.000Z',
  vocabulary: '2026-11-10T01:00:00.000Z',
  planned: '2026-11-13T04:00:00.000Z',
  answered: '2026-11-13T06:00:00.000Z',
  replanned: '2026-11-13T08:00:00.000Z',
};
export const planDate = '2026-11-13';
export const yesterday = '2026-11-12';

export const vocabularyEstimate: Model.VocabularyEstimate = {
  list: { id: 'fixture-list', version: '1' },
  bands: [],
  estimatedAt: at.vocabulary,
};

export const learner: Model.Learner = {
  id: learnerId,
  currentVocabulary: vocabularyEstimate,
  dailyTaskCapacity: 5,
  timezone: 'Asia/Shanghai',
  createdAt: at.created,
  updatedAt: at.created,
};

// 第二个 resilient 词义（不同知识点、同词族），使 FLUENCY-P 规格合法存在。
export const knowledgePointResilientB: Model.VocabularyKnowledgePoint & { kind: 'word' } = {
  id: 'kp-resilient-b',
  kind: 'word',
  lemma: 'resilient',
  wordFamily: 'resilient',
  sense: { id: 'sense-resilient-b', definition: '（材料等）能回弹的', partOfSpeech: 'adjective', explanation: null },
};

// 容量 5 下第一轮排不进计划的第七个候选，供 P2 第二轮补位。
export const knowledgePointSetback: Model.VocabularyKnowledgePoint & { kind: 'word' } = {
  id: 'kp-setback',
  kind: 'word',
  lemma: 'setback',
  wordFamily: 'setback',
  sense: { id: 'sense-setback', definition: '挫折，阻碍', partOfSpeech: 'noun', explanation: null },
};

const allKnowledgePoints = [...knowledgePoints, knowledgePointResilientB, knowledgePointSetback];

export const allCandidates: Model.GoalKnowledgePoint[] = allKnowledgePoints.map((knowledgePoint) => ({
  goalId,
  knowledgePointId: knowledgePoint.id,
  selection: 'included',
  addedAt: at.created,
  selectionUpdatedAt: at.created,
}));

export const allSources: Model.GoalKnowledgePointSource[] = allKnowledgePoints.map((knowledgePoint) => ({
  goalId,
  knowledgePointId: knowledgePoint.id,
  sourceAnalysisId: analysis.id,
  addedAt: at.created,
}));

function dueReview(dueAt: string): Model.ReviewSchedule {
  return {
    intervalDays: 3,
    dueAt,
    lastReviewedAt: '2026-11-08T00:00:00.000Z',
    successfulReviewStreak: 1,
    lapseCount: 0,
    graduated: false,
  };
}

function graduatedReview(dueAt: string): Model.ReviewSchedule {
  return {
    intervalDays: 30,
    dueAt,
    lastReviewedAt: '2026-11-10T00:00:00.000Z',
    successfulReviewStreak: 3,
    lapseCount: 0,
    graduated: true,
  };
}

function makeLearning(
  knowledgePointId: string,
  r: { fluency: number; review: Model.ReviewSchedule },
  p: { fluency: number; review: Model.ReviewSchedule },
): Model.LearnerKnowledgePoint {
  return {
    learnerId,
    knowledgePointId,
    initialFluency: { R: r.fluency, P: p.fluency },
    initialization: {
      sourceVocabulary: vocabularyEstimate,
      classification: null,
      policyVersion: 'fixture-v1',
      productionBasis: 'derived_from_receptive',
    },
    dimensions: {
      R: { fluency: r.fluency, review: r.review },
      P: { fluency: p.fluency, review: p.review },
    },
    createdAt: at.created,
    updatedAt: at.created,
    version: 0,
  };
}

// 学习状态按到期时间 20:00→23:00Z 排序，使 S07 第一轮依次产出
// ubiquitous/RETRIEVE-R-choice、deliberate/RETRIEVE-P-cued、contemporary/FLUENCY-R、
// resilient-b/FLUENCY-P，最后是新词 resilient-a/ENCODE（kp-setback 因容量落选）。
export const learnings: Model.LearnerKnowledgePoint[] = [
  makeLearning('kp-ubiquitous',
    { fluency: 10, review: dueReview('2026-11-12T20:00:00.000Z') },
    { fluency: 80, review: graduatedReview('2026-11-14T01:00:00.000Z') }),
  makeLearning('kp-deliberate',
    { fluency: 80, review: graduatedReview('2026-11-14T02:00:00.000Z') },
    { fluency: 30, review: dueReview('2026-11-12T21:00:00.000Z') }),
  makeLearning('kp-contemporary',
    { fluency: 70, review: dueReview('2026-11-12T22:00:00.000Z') },
    { fluency: 80, review: graduatedReview('2026-11-14T03:00:00.000Z') }),
  makeLearning('kp-resilient-b',
    { fluency: 80, review: graduatedReview('2026-11-14T04:00:00.000Z') },
    { fluency: 80, review: dueReview('2026-11-12T23:00:00.000Z') }),
];

export function createBaseState(): Model.LearningState {
  return {
    learners: [{ ...learner }],
    vocabularyAssessments: [],
    vocabularyAssessmentTasks: [],
    vocabularyAssessmentAttempts: [],
    materials: [material],
    materialAnalyses: [analysis],
    goals: [{ ...goal }],
    goalMaterials: [{ goalId, materialId: material.id, analysisId: analysis.id, addedAt: at.created }],
    knowledgePoints: allKnowledgePoints,
    knowledgePointVocabularyClassifications: [],
    goalKnowledgePoints: allCandidates,
    goalKnowledgePointSources: allSources,
    learnerKnowledgePoints: learnings,
    studyPlans: [],
    tasks: [],
    attempts: [],
  };
}

/** 记录写入次数、可在 save 前注入并发写入的状态仓库包装。 */
export class RecordingStateRepository implements LearningStateRepository {
  saveAttempts = 0;
  beforeSave: (() => void) | null = null;

  constructor(readonly inner: InMemoryLearningStateRepository) {}

  load() {
    return this.inner.load();
  }

  save(next: Model.LearningState, expectedRevision: number) {
    this.saveAttempts++;
    this.beforeSave?.();
    return this.inner.save(next, expectedRevision);
  }

  /** 直接经由内部仓库提交一次写入，用于模拟 S09 保存窗口内的并发修改。 */
  injectConcurrentWrite(): void {
    const snapshot = this.inner.load();
    this.inner.save(snapshot.state, snapshot.revision);
  }
}

// AI 输出在 S08 夹具基础上替换 FLUENCY-P 的词为第二个 resilient 词义，并补 setback。
export const fixtureAiOutputs: Model.GeneratedTask[] = [
  aiOutputs.encodeResilient,
  aiOutputs.retrieveUbiquitousChoiceR,
  aiOutputs.retrieveDeliberateCuedP,
  aiOutputs.fluencyContemporaryR,
  { ...aiOutputs.fluencyResilientP, wordId: 'kp-resilient-b' },
  {
    schemaVersion: '1',
    task: 'ENCODE',
    wordId: 'kp-setback',
    content: {
      word: 'setback',
      partOfSpeech: 'noun',
      definition: 'a problem that delays or stops progress',
      examples: [{ sentence: 'The team recovered quickly from the setback.' }],
      instruction: 'Read the word, meaning, and example, then confirm when you are ready.',
    },
  },
];

export function respondBySpec(request: TaskGenerationAIRequest): string {
  const { specification } = request;
  const output = fixtureAiOutputs.find(
    (item) => item.task === specification.task && item.wordId === specification.wordId,
  );
  if (!output) throw new Error(`夹具缺少 ${specification.wordId}/${specification.task} 的 AI 输出`);
  return JSON.stringify(output);
}

export function createProvider(): FakeTaskAIProvider {
  return new FakeTaskAIProvider(respondBySpec);
}

/** 由规格确定任务 ID，保证两轮排期对同一规格得到稳定 ID。 */
export function idForSpec(specification: TaskSpecification): string {
  const parts = ['task', specification.wordId, specification.task.toLowerCase()];
  if (specification.task !== 'ENCODE') parts.push(specification.axis.toLowerCase());
  if (specification.task === 'RETRIEVE') parts.push(specification.stage);
  return parts.join('-');
}

export function setup(mutate?: (state: Model.LearningState) => void) {
  const state = createBaseState();
  mutate?.(state);
  const inner = new InMemoryLearningStateRepository(state);
  const repository = new RecordingStateRepository(inner);
  const provider = createProvider();
  return { state, inner, repository, provider };
}

/** S07→S08 真实流水线：在快照上排期，并为全部 new 位置生成任务。 */
export async function planAndGenerate(
  repository: LearningStateRepository,
  provider: TaskGenerationAIProvider,
  date: string,
  now: string,
): Promise<{ decision: DailyStudyDecision; newTasks: Model.LearningTask[] }> {
  const snapshot = repository.load();
  const decision = planDailyStudy(snapshot.state, { learnerId, date, now });
  const taskRepository: LearningTaskRepository = new InMemoryTaskRepository(snapshot.state);
  const newTasks: Model.LearningTask[] = [];
  for (const position of decision.tasks) {
    if (position.source !== 'new') continue;
    const result = await generateLearningTaskUseCase(
      { repository: taskRepository, aiProvider: provider, logger: silentLogger },
      {
        taskId: idForSpec(position.specification),
        learnerId,
        specification: position.specification,
        issuedAt: now,
      },
    );
    if (!result.ok) throw new Error(`夹具任务生成失败：${result.reason}`);
    newTasks.push(result.task);
  }
  return { decision, newTasks };
}

/** 决策的任务 ID 顺序：existing 取原 ID，new 按生成顺序对应。 */
export function decisionTaskIds(decision: DailyStudyDecision, newTasks: Model.LearningTask[]): string[] {
  const ids: string[] = [];
  let index = 0;
  for (const position of decision.tasks) {
    ids.push(position.source === 'existing' ? position.taskId : newTasks[index++].id);
  }
  return ids;
}

/** 手工构造一个已签发任务（ENCODE 内容），用于失败路径的非法输入。 */
export function makeIssuedTask(id: string, wordId: string, issuedAt: string): Model.LearningTask {
  return createLearningTask({
    id,
    learnerId,
    specification: { goalId, wordId, task: 'ENCODE' },
    generated: { ...aiOutputs.encodeResilient, wordId },
    issuedAt,
  });
}

/** 手工构造一个已完成任务，用于 existing 位置失效的失败路径。 */
export function makeCompletedTask(
  id: string,
  wordId: string,
  issuedAt: string,
  completedAt: string,
): Model.LearningTask {
  const task = makeIssuedTask(id, wordId, issuedAt);
  return { ...task, status: 'completed', completedAt } as Model.LearningTask;
}
