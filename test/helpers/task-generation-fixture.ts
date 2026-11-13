/**
 * S08 测试共享夹具：内存 Repository、Fake AI Provider、大场景五规格及固定 AI 输出。
 * 单元测试与 Live 验证都从这里取数据，保证两者跑的是同一套契约。
 */

import { generateLearningTaskUseCase } from '../../lib/application/task-generation';
import type { AppLogger } from '../../lib/application/logger';
import type {
  LearningTaskRepository,
  TaskGenerationAIProvider,
  TaskGenerationAIRequest,
  TaskGenerationContext,
} from '../../lib/application/ports';
import type { TaskSpecification } from '../../lib/domain/functions';
import type * as Model from '../../lib/domain/model';

/** 测试默认注入的静默 logger，避免污染 jest 输出。 */
export const silentLogger: AppLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export const at = {
  added: '2026-11-12T00:20:00.000Z',
  issued: '2026-11-12T00:30:00.000Z',
};
export const learnerId = 'learner-1';
export const goalId = 'goal-adapt';

export const material: Model.Material = {
  id: 'material-adapt',
  learnerId,
  title: 'How teams adapt',
  filename: 'how-teams-adapt.md',
  format: 'markdown',
  mimeType: 'text/markdown',
  checksum: 'checksum-adapt',
  storageKey: null,
  extractedText: 'Contemporary teams work in a world where digital tools are ubiquitous. When a project changes, a deliberate response is more useful than a rushed one. A resilient team learns from the setback, adjusts its plan, and keeps moving.',
  extractionMetadata: { extractor: 'fixture' },
  createdAt: at.added,
};

export const knowledgePoints: Array<Model.VocabularyKnowledgePoint & { kind: 'word' }> = [
  {
    id: 'kp-contemporary',
    kind: 'word',
    lemma: 'contemporary',
    wordFamily: 'contemporary',
    sense: { id: 'sense-contemporary', definition: '现代的，当代的', partOfSpeech: 'adjective', explanation: null },
  },
  {
    id: 'kp-ubiquitous',
    kind: 'word',
    lemma: 'ubiquitous',
    wordFamily: 'ubiquitous',
    sense: { id: 'sense-ubiquitous', definition: '无处不在的', partOfSpeech: 'adjective', explanation: null },
  },
  {
    id: 'kp-deliberate',
    kind: 'word',
    lemma: 'deliberate',
    wordFamily: 'deliberate',
    sense: { id: 'sense-deliberate', definition: '深思熟虑的', partOfSpeech: 'adjective', explanation: null },
  },
  {
    id: 'kp-resilient',
    kind: 'word',
    lemma: 'resilient',
    wordFamily: 'resilient',
    sense: { id: 'sense-resilient', definition: '有韧性的，能迅速恢复的', partOfSpeech: 'adjective', explanation: null },
  },
];

export const analysis: Extract<Model.MaterialAnalysis, { status: 'analyzed' }> = {
  id: 'analysis-adapt',
  materialId: material.id,
  analyzerVersion: 'fixture-v1',
  status: 'analyzed',
  items: knowledgePoints.map((knowledgePoint) => ({
    knowledgePoint,
    occurrences: [{ rawForm: knowledgePoint.lemma, sentence: material.extractedText!, context: [] }],
  })),
  unmatchedItems: [],
  errors: [],
  createdAt: at.added,
  completedAt: at.added,
};

export const goal: Model.LearningGoal = {
  id: goalId,
  learnerId,
  title: '读懂并谈论团队如何应对变化',
  targetFluency: { R: 80, P: 80 },
  status: 'active',
  createdAt: at.added,
  updatedAt: at.added,
};

// 学习者已完成首次测评：1k～2k 基本掌握，5k 部分掌握，25k 未掌握。
export const learnerVocabulary: Model.VocabularyEstimate = {
  list: { id: 'bnc-coca-l6', version: '2.0.0' },
  bands: [
    { band: '1k', wordFamilyCount: 1000, knownProbability: 0.95, sampleCount: 20, knownCount: 19, interval: null },
    { band: '2k', wordFamilyCount: 1000, knownProbability: 0.9, sampleCount: 20, knownCount: 18, interval: null },
    { band: '5k', wordFamilyCount: 1000, knownProbability: 0.55, sampleCount: 20, knownCount: 11, interval: null },
    { band: '25k', wordFamilyCount: 1000, knownProbability: 0.1, sampleCount: 20, knownCount: 2, interval: null },
  ],
  estimatedAt: at.added,
};

export const learner: Model.Learner = {
  id: learnerId,
  currentVocabulary: learnerVocabulary,
  dailyTaskCapacity: 5,
  timezone: 'Asia/Shanghai',
  createdAt: at.added,
  updatedAt: at.added,
};

export const candidates: Model.GoalKnowledgePoint[] = knowledgePoints.map((knowledgePoint) => ({
  goalId,
  knowledgePointId: knowledgePoint.id,
  selection: 'included',
  addedAt: at.added,
  selectionUpdatedAt: at.added,
}));

export const sources: Model.GoalKnowledgePointSource[] = knowledgePoints.map((knowledgePoint) => ({
  goalId,
  knowledgePointId: knowledgePoint.id,
  sourceAnalysisId: analysis.id,
  addedAt: at.added,
}));

// 与 speedboat plan 大场景第 7 步一致的五个 new 规格。
export const specifications = {
  encodeResilient: { goalId, wordId: 'kp-resilient', task: 'ENCODE' },
  retrieveUbiquitousChoiceR: { goalId, wordId: 'kp-ubiquitous', task: 'RETRIEVE', axis: 'R', stage: 'choice' },
  retrieveDeliberateCuedP: { goalId, wordId: 'kp-deliberate', task: 'RETRIEVE', axis: 'P', stage: 'cued' },
  fluencyContemporaryR: { goalId, wordId: 'kp-contemporary', task: 'FLUENCY', axis: 'R' },
  fluencyResilientP: { goalId, wordId: 'kp-resilient', task: 'FLUENCY', axis: 'P' },
} satisfies Record<string, TaskSpecification>;

export const taskIds = {
  encodeResilient: 'task-resilient-encode',
  retrieveUbiquitousChoiceR: 'task-ubiquitous-choice',
  retrieveDeliberateCuedP: 'task-deliberate-cued',
  fluencyContemporaryR: 'task-contemporary-fluency-r',
  fluencyResilientP: 'task-resilient-fluency-p',
};

// Fake AI Provider 返回的固定题目；每个输出都能通过与对应规格一致的 validateGeneratedTask。
export const aiOutputs = {
  encodeResilient: {
    schemaVersion: '1',
    task: 'ENCODE',
    wordId: 'kp-resilient',
    content: {
      word: 'resilient',
      partOfSpeech: 'adjective',
      definition: 'able to recover quickly from difficulties',
      examples: [{ sentence: 'A resilient team learns from the setback.' }],
      instruction: 'Read the word, meaning, and example, then confirm when you are ready.',
    },
  },
  retrieveUbiquitousChoiceR: {
    schemaVersion: '1',
    task: 'RETRIEVE',
    wordId: 'kp-ubiquitous',
    content: {
      axis: 'R',
      stage: 'choice',
      prompt: 'What does ubiquitous mean?',
      options: [
        { id: 'a', text: 'present everywhere' },
        { id: 'b', text: 'rarely seen' },
      ],
      answerOptionId: 'a',
      explanation: 'Ubiquitous means present everywhere.',
    },
  },
  retrieveDeliberateCuedP: {
    schemaVersion: '1',
    task: 'RETRIEVE',
    wordId: 'kp-deliberate',
    content: {
      axis: 'P',
      stage: 'cued',
      prompt: '用英文表达这个意思：深思熟虑的。',
      cue: 'd',
      answerKey: {
        acceptedAnswers: ['deliberate'],
        explanation: 'Deliberate means carefully considered.',
      },
    },
  },
  fluencyContemporaryR: {
    schemaVersion: '1',
    task: 'FLUENCY',
    wordId: 'kp-contemporary',
    content: {
      axis: 'R',
      passage: 'Contemporary teams work in a world where digital tools are ubiquitous. When a project changes, a deliberate response is more useful than a rushed one. A contemporary team learns from the setback, adjusts its plan, and keeps moving. In this kind of contemporary workplace, people cannot avoid change, so they must adapt quickly. Teams that pause, think, and then act often do better than teams that panic. Leaders in contemporary organizations encourage honest feedback after every project, because each review makes the next challenge easier to handle.',
      questions: [
        {
          id: 'target-meaning',
          role: 'target_meaning',
          kind: 'choice',
          prompt: 'What does contemporary mean?',
          evidence: 'Contemporary teams work in a world where digital tools are ubiquitous.',
          options: [
            { id: 'a', text: 'modern' },
            { id: 'b', text: 'old-fashioned' },
          ],
          answerOptionId: 'a',
        },
        {
          id: 'passage-comprehension',
          role: 'passage_comprehension',
          kind: 'free',
          prompt: 'Summarize the passage.',
          evidence: 'A contemporary team learns from the setback, adjusts its plan, and keeps moving.',
          answer: 'The passage says a contemporary team learns from setbacks, adjusts its plan, and keeps moving.',
        },
      ],
      targetOccurrences: 4,
    },
  },
  fluencyResilientP: {
    schemaVersion: '1',
    task: 'FLUENCY',
    wordId: 'kp-resilient',
    content: {
      axis: 'P',
      scenario: '请描述一个团队从挫折中恢复过来的场景。',
      responseInstruction: '请用英文自然地表达你的想法。',
      gradingRequirements: {
        targetExpression: 'resilient',
        targetUseCriteria: ['自然且正确地使用 resilient 描述团队或人。'],
        overallExpressionCriteria: ['表达完整、语义清楚。'],
      },
    },
  },
} satisfies Record<string, Model.GeneratedTask>;

export type ScenarioKey = keyof typeof specifications;

/** 内存 Repository：只实现 S08 需要的读取；记录事务深度与写入，便于断言用例不持久化。 */
export class InMemoryTaskRepository implements LearningTaskRepository {
  readonly transactionDepth = 0;
  readonly persistedTasks: Model.LearningTask[] = [];

  constructor(private readonly state: Model.LearningState) {}

  async loadTaskGenerationContext(
    goalId: string,
    knowledgePointId: string,
  ): Promise<TaskGenerationContext | null> {
    const goal = this.state.goals.find((item) => item.id === goalId) ?? null;
    const candidate = this.state.goalKnowledgePoints.find(
      (item) => item.goalId === goalId && item.knowledgePointId === knowledgePointId,
    ) ?? null;
    const knowledgePoint = this.state.knowledgePoints.find((item) => item.id === knowledgePointId) ?? null;
    if (!goal || !candidate || !knowledgePoint) return null;
    const learner = this.state.learners.find((item) => item.id === goal.learnerId) ?? null;
    const materialsById = new Map<string, Model.Material>();
    for (const source of this.state.goalKnowledgePointSources) {
      if (source.goalId !== goalId || source.knowledgePointId !== knowledgePointId) continue;
      const analysis = this.state.materialAnalyses.find((item) => item.id === source.sourceAnalysisId);
      const material = analysis
        ? this.state.materials.find((item) => item.id === analysis.materialId)
        : undefined;
      if (material) materialsById.set(material.id, material);
    }
    return {
      goal,
      candidate,
      knowledgePoint,
      sourceMaterials: [...materialsById.values()],
      learnerVocabulary: learner?.currentVocabulary ?? null,
    };
  }
}

export class FakeTaskAIProvider implements TaskGenerationAIProvider {
  readonly requests: TaskGenerationAIRequest[] = [];
  onRequest: (() => void) | null = null;

  constructor(private readonly respond: (request: TaskGenerationAIRequest) => string) {}

  async generateTask(request: TaskGenerationAIRequest): Promise<string> {
    this.requests.push(request);
    this.onRequest?.();
    return this.respond(request);
  }
}

export function createState(): Model.LearningState {
  return {
    learners: [learner],
    vocabularyAssessments: [],
    vocabularyAssessmentTasks: [],
    vocabularyAssessmentAttempts: [],
    materials: [material],
    materialAnalyses: [analysis],
    goals: [goal],
    goalMaterials: [{ goalId, materialId: material.id, analysisId: analysis.id, addedAt: at.added }],
    knowledgePoints,
    knowledgePointVocabularyClassifications: [],
    goalKnowledgePoints: candidates,
    goalKnowledgePointSources: sources,
    learnerKnowledgePoints: [],
    studyPlans: [],
    tasks: [],
    attempts: [],
  };
}

export function createRepository() {
  const state = createState();
  return { state, repository: new InMemoryTaskRepository(state) };
}

export function setup(respond: (request: TaskGenerationAIRequest) => string) {
  const { state, repository } = createRepository();
  const provider = new FakeTaskAIProvider(respond);
  return { state, repository, provider };
}

export function inputFor(key: ScenarioKey) {
  return {
    taskId: taskIds[key],
    learnerId,
    specification: specifications[key],
    issuedAt: at.issued,
  };
}

export async function runScenario(key: ScenarioKey) {
  const { state, repository, provider } = setup(() => JSON.stringify(aiOutputs[key]));
  const result = await generateLearningTaskUseCase(
    { repository, aiProvider: provider, logger: silentLogger },
    inputFor(key),
  );
  return { state, repository, provider, result };
}

export function expectOk(result: Awaited<ReturnType<typeof generateLearningTaskUseCase>>) {
  if (!result.ok) throw new Error(`期望生成成功，实际失败：${result.reason}`);
  return result.task;
}
