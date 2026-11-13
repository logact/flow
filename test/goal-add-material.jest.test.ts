/// <reference types="jest" />

/**
 * S05 创建目标并加入已分析材料的应用用例测试。
 * 使用内存 Repository 验证编排：
 * - 目标不存在时创建目标并加入材料；已存在时加载后加入，标题与目标流利度不被覆盖。
 * - 同一写入保存目标、材料关联、规范化知识点、候选与来源，重新加载后状态约束成立。
 * - 增量合并不重置已有候选的选择状态；同一知识点跨材料累积多个来源。
 * - 同一材料同一分析版本重复加入幂等返回；同材料新版本分析更新固定的 analysisId 并移除旧版本来源。
 * - 学习者/材料/分析缺失、跨学习者、归属不符、分析未完成、输入非法时均不保存任何状态。
 * 不验证：SQLite 实现的外部存储、并发；本用例不调用 AI、不初始化流利度（由 S06 负责）。
 */

import { addMaterialToGoalUseCase } from '../lib/application/goal-material';
import type {
  AnalyzedMaterialAnalysis,
  GoalMaterialRepository,
  SaveGoalMaterialPayload,
} from '../lib/application/ports';
import { validateLearningState } from '../lib/domain/invariants';
import type * as Model from '../lib/domain/model';
import { silentLogger } from './helpers/silent-logger';

const at = {
  created: '2026-11-12T01:00:00.000Z',
  added: '2026-11-12T02:00:00.000Z',
  addedLater: '2026-11-12T03:00:00.000Z',
  selected: '2026-11-12T02:30:00.000Z',
};
const learnerId = 'learner-1';

const learner: Model.Learner = {
  id: learnerId,
  currentVocabulary: null,
  dailyTaskCapacity: 5,
  timezone: 'Asia/Shanghai',
  createdAt: at.created,
  updatedAt: at.created,
};

function createMaterial(id: string, ownerId: string = learnerId): Model.Material {
  return {
    id,
    learnerId: ownerId,
    title: id,
    filename: `${id}.md`,
    format: 'markdown',
    mimeType: 'text/markdown',
    checksum: `checksum-${id}`,
    storageKey: null,
    extractedText: `${id} text`,
    extractionMetadata: { extractor: 'provided' },
    createdAt: at.created,
  };
}

function wordKnowledgePoint(lemma: string): Model.KnowledgePoint {
  return {
    id: `word:${lemma}:placeholder:1`,
    kind: 'word',
    lemma,
    wordFamily: lemma,
    sense: { id: 'placeholder:1', definition: '', partOfSpeech: null, explanation: null },
  };
}

function analysisOf(
  id: string,
  materialId: string,
  lemmas: string[],
  status: 'analyzed' | 'pending' = 'analyzed',
): Model.MaterialAnalysis {
  if (status === 'pending') {
    return {
      id,
      materialId,
      analyzerVersion: 'material-analyzer-v1',
      status: 'pending',
      items: [],
      unmatchedItems: [],
      errors: [],
      createdAt: at.created,
      completedAt: null,
    };
  }
  const analysis: AnalyzedMaterialAnalysis = {
    id,
    materialId,
    analyzerVersion: 'material-analyzer-v1',
    status: 'analyzed',
    items: lemmas.map((lemma) => ({
      knowledgePoint: wordKnowledgePoint(lemma),
      occurrences: [{ rawForm: lemma, sentence: `${lemma} appears in context.`, context: [] }],
    })),
    unmatchedItems: [],
    errors: [],
    createdAt: at.created,
    completedAt: at.created,
  };
  return analysis;
}

/** 内存 Repository：记录每次写入，并把产物 upsert 进状态供 validateLearningState 校验。 */
class InMemoryGoalMaterialRepository implements GoalMaterialRepository {
  readonly saves: SaveGoalMaterialPayload[] = [];

  constructor(private readonly state: Model.LearningState) {}

  async loadLearner(id: string) {
    return this.state.learners.find((item) => item.id === id) ?? null;
  }

  async loadGoal(goalId: string) {
    return this.state.goals.find((goal) => goal.id === goalId) ?? null;
  }

  async loadMaterial(materialId: string) {
    return this.state.materials.find((material) => material.id === materialId) ?? null;
  }

  async loadAnalysis(analysisId: string) {
    return this.state.materialAnalyses.find((analysis) => analysis.id === analysisId) ?? null;
  }

  async loadGoalScope(goalId: string) {
    return {
      materialLinks: this.state.goalMaterials.filter((link) => link.goalId === goalId),
      candidates: this.state.goalKnowledgePoints.filter((link) => link.goalId === goalId),
      sources: this.state.goalKnowledgePointSources.filter((link) => link.goalId === goalId),
    };
  }

  async saveGoalMaterial(payload: SaveGoalMaterialPayload) {
    this.saves.push(payload);
    const goalIndex = this.state.goals.findIndex((goal) => goal.id === payload.goal.id);
    if (goalIndex >= 0) this.state.goals[goalIndex] = payload.goal;
    else this.state.goals.push(payload.goal);
    const linkIndex = this.state.goalMaterials.findIndex(
      (link) => link.goalId === payload.materialLink.goalId && link.materialId === payload.materialLink.materialId,
    );
    if (linkIndex >= 0) this.state.goalMaterials[linkIndex] = payload.materialLink;
    else this.state.goalMaterials.push(payload.materialLink);
    for (const knowledgePoint of payload.knowledgePoints) {
      if (!this.state.knowledgePoints.some((item) => item.id === knowledgePoint.id)) {
        this.state.knowledgePoints.push(knowledgePoint);
      }
    }
    this.state.goalKnowledgePoints = [
      ...this.state.goalKnowledgePoints.filter((link) => link.goalId !== payload.goal.id),
      ...payload.candidates,
    ];
    this.state.goalKnowledgePointSources = [
      ...this.state.goalKnowledgePointSources.filter((link) => link.goalId !== payload.goal.id),
      ...payload.sources,
    ];
  }
}

function createState(): Model.LearningState {
  return {
    learners: [learner],
    vocabularyAssessments: [],
    vocabularyAssessmentTasks: [],
    vocabularyAssessmentAttempts: [],
    materials: [],
    materialAnalyses: [],
    goals: [],
    goalMaterials: [],
    knowledgePoints: [],
    knowledgePointVocabularyClassifications: [],
    goalKnowledgePoints: [],
    goalKnowledgePointSources: [],
    learnerKnowledgePoints: [],
    studyPlans: [],
    tasks: [],
    attempts: [],
  };
}

function setup() {
  const state = createState();
  const repository = new InMemoryGoalMaterialRepository(state);
  return { state, repository };
}

function seedAnalyzedMaterial(
  state: Model.LearningState,
  materialId: string,
  analysisId: string,
  lemmas: string[],
  ownerId: string = learnerId,
) {
  state.materials.push(createMaterial(materialId, ownerId));
  state.materialAnalyses.push(analysisOf(analysisId, materialId, lemmas));
}

function baseInput(overrides: Partial<Parameters<typeof addMaterialToGoalUseCase>[1]>) {
  return {
    goalId: 'goal-1',
    learnerId,
    title: '读懂并谈论团队如何应对变化',
    targetFluency: { R: 80, P: 80 },
    materialId: 'material-1',
    analysisId: 'analysis-1',
    addedAt: at.added,
    now: at.created,
    ...overrides,
  };
}

function expectOk(result: Awaited<ReturnType<typeof addMaterialToGoalUseCase>>) {
  if (!result.ok) throw new Error(`期望加入成功，实际失败：${result.reason}`);
  return result;
}

function candidateOf(result: ReturnType<typeof expectOk>, knowledgePointId: string) {
  return result.candidates.find((candidate) => candidate.knowledgePointId === knowledgePointId);
}

describe('S05 创建目标并加入已分析材料', () => {
  test('创建目标并加入已分析材料：一次写入保存目标、关联、知识点、候选与来源', async () => {
    const { state, repository } = setup();
    seedAnalyzedMaterial(state, 'material-1', 'analysis-1', ['contemporary', 'ubiquitous', 'deliberate', 'resilient']);

    const result = await addMaterialToGoalUseCase(
      { repository, logger: silentLogger },
      baseInput({}),
    );

    const scope = expectOk(result);
    expect(scope.goal).toEqual({
      id: 'goal-1',
      learnerId,
      title: '读懂并谈论团队如何应对变化',
      targetFluency: { R: 80, P: 80 },
      status: 'active',
      createdAt: at.created,
      updatedAt: at.added,
    });
    expect(scope.materialLink).toEqual({
      goalId: 'goal-1',
      materialId: 'material-1',
      analysisId: 'analysis-1',
      addedAt: at.added,
    });
    expect(scope.knowledgePoints.map((item) => item.id)).toEqual([
      'word:contemporary:placeholder:1',
      'word:ubiquitous:placeholder:1',
      'word:deliberate:placeholder:1',
      'word:resilient:placeholder:1',
    ]);
    // 候选全部保持未决定，由 S06 再做选择；本用例不初始化流利度。
    expect(scope.candidates).toHaveLength(4);
    for (const candidate of scope.candidates) {
      expect(candidate.selection).toBe('undecided');
      expect(candidate.addedAt).toBe(at.added);
      expect(candidate.selectionUpdatedAt).toBe(at.added);
    }
    expect(scope.sources).toHaveLength(4);
    for (const source of scope.sources) {
      expect(source.sourceAnalysisId).toBe('analysis-1');
      expect(source.addedAt).toBe(at.added);
    }

    expect(repository.saves).toHaveLength(1);
    expect(repository.saves[0]).toEqual({
      goal: scope.goal,
      materialLink: scope.materialLink,
      knowledgePoints: scope.knowledgePoints,
      candidates: scope.candidates,
      sources: scope.sources,
    });
    expect(validateLearningState(state)).toEqual([]);
    expect(state.learnerKnowledgePoints).toEqual([]);
  });

  test('向已有目标加入第二份材料：不覆盖标题与目标流利度，createdAt 不变', async () => {
    const { state, repository } = setup();
    seedAnalyzedMaterial(state, 'material-1', 'analysis-1', ['contemporary']);
    seedAnalyzedMaterial(state, 'material-2', 'analysis-2', ['resilient']);

    const first = await addMaterialToGoalUseCase(
      { repository, logger: silentLogger },
      baseInput({}),
    );
    expectOk(first);

    const second = await addMaterialToGoalUseCase(
      { repository, logger: silentLogger },
      baseInput({
        materialId: 'material-2',
        analysisId: 'analysis-2',
        addedAt: at.addedLater,
        title: '不应被采用的标题',
        targetFluency: { R: 10, P: 10 },
      }),
    );
    const scope = expectOk(second);
    expect(scope.goal.title).toBe('读懂并谈论团队如何应对变化');
    expect(scope.goal.targetFluency).toEqual({ R: 80, P: 80 });
    expect(scope.goal.createdAt).toBe(at.created);
    expect(scope.goal.updatedAt).toBe(at.addedLater);
    expect(state.goalMaterials).toHaveLength(2);
    expect(state.goalMaterials.map((link) => link.analysisId)).toEqual(['analysis-1', 'analysis-2']);
    expect(scope.candidates.map((candidate) => candidate.knowledgePointId)).toEqual([
      'word:contemporary:placeholder:1',
      'word:resilient:placeholder:1',
    ]);
    expect(validateLearningState(state)).toEqual([]);
  });

  test('增量合并不重置已有选择状态：重叠候选保持 included 与原 selectionUpdatedAt', async () => {
    const { state, repository } = setup();
    seedAnalyzedMaterial(state, 'material-1', 'analysis-1', ['contemporary', 'resilient']);
    seedAnalyzedMaterial(state, 'material-2', 'analysis-2', ['resilient', 'deliberate']);

    await addMaterialToGoalUseCase({ repository, logger: silentLogger }, baseInput({}));
    // 模拟 S06：学习者已把 resilient 纳入学习。
    const existing = state.goalKnowledgePoints.find(
      (candidate) => candidate.knowledgePointId === 'word:resilient:placeholder:1',
    );
    if (!existing) throw new Error('缺少预置候选');
    existing.selection = 'included';
    existing.selectionUpdatedAt = at.selected;

    const second = await addMaterialToGoalUseCase(
      { repository, logger: silentLogger },
      baseInput({ materialId: 'material-2', analysisId: 'analysis-2', addedAt: at.addedLater }),
    );
    const scope = expectOk(second);

    const resilient = candidateOf(scope, 'word:resilient:placeholder:1');
    expect(resilient).toEqual({
      goalId: 'goal-1',
      knowledgePointId: 'word:resilient:placeholder:1',
      selection: 'included',
      addedAt: at.added,
      selectionUpdatedAt: at.selected,
    });
    expect(candidateOf(scope, 'word:contemporary:placeholder:1')?.selection).toBe('undecided');
    expect(candidateOf(scope, 'word:deliberate:placeholder:1')?.selection).toBe('undecided');
    expect(scope.candidates).toHaveLength(3);
    expect(validateLearningState(state)).toEqual([]);
  });

  test('同一知识点跨材料来源累积：候选一条，两个来源分析各一条记录', async () => {
    const { state, repository } = setup();
    seedAnalyzedMaterial(state, 'material-1', 'analysis-1', ['resilient', 'contemporary']);
    seedAnalyzedMaterial(state, 'material-2', 'analysis-2', ['resilient']);

    await addMaterialToGoalUseCase({ repository, logger: silentLogger }, baseInput({}));
    const second = await addMaterialToGoalUseCase(
      { repository, logger: silentLogger },
      baseInput({ materialId: 'material-2', analysisId: 'analysis-2', addedAt: at.addedLater }),
    );
    const scope = expectOk(second);

    expect(scope.candidates.filter(
      (candidate) => candidate.knowledgePointId === 'word:resilient:placeholder:1',
    )).toHaveLength(1);
    const resilientSources = scope.sources.filter(
      (source) => source.knowledgePointId === 'word:resilient:placeholder:1',
    );
    expect(resilientSources.map((source) => source.sourceAnalysisId)).toEqual(['analysis-1', 'analysis-2']);
    expect(validateLearningState(state)).toEqual([]);
  });

  test('同一材料同一分析版本重复加入：幂等返回现有结果，不重复写入', async () => {
    const { state, repository } = setup();
    seedAnalyzedMaterial(state, 'material-1', 'analysis-1', ['contemporary']);

    const first = await addMaterialToGoalUseCase({ repository, logger: silentLogger }, baseInput({}));
    expectOk(first);
    const stateSnapshot = structuredClone(state);

    const second = await addMaterialToGoalUseCase(
      { repository, logger: silentLogger },
      baseInput({ addedAt: at.addedLater }),
    );
    const scope = expectOk(second);
    expect(scope.materialLink).toEqual({
      goalId: 'goal-1',
      materialId: 'material-1',
      analysisId: 'analysis-1',
      addedAt: at.added,
    });
    expect(scope.goal.updatedAt).toBe(at.added);
    expect(scope.candidates).toEqual(state.goalKnowledgePoints);
    expect(scope.sources).toEqual(state.goalKnowledgePointSources);
    expect(repository.saves).toHaveLength(1);
    expect(state).toEqual(stateSnapshot);
  });

  test('同材料新版本分析加入：更新固定的 analysisId，候选增量合并，旧版本来源移除', async () => {
    const { state, repository } = setup();
    seedAnalyzedMaterial(state, 'material-1', 'analysis-1', ['contemporary']);
    state.materialAnalyses.push(analysisOf('analysis-2', 'material-1', ['contemporary', 'deliberate']));

    await addMaterialToGoalUseCase({ repository, logger: silentLogger }, baseInput({}));
    const second = await addMaterialToGoalUseCase(
      { repository, logger: silentLogger },
      baseInput({ analysisId: 'analysis-2', addedAt: at.addedLater }),
    );
    const scope = expectOk(second);

    // 同一 (goalId, materialId) 仍只有一条关联，固定到新分析版本。
    expect(state.goalMaterials).toHaveLength(1);
    expect(scope.materialLink).toEqual({
      goalId: 'goal-1',
      materialId: 'material-1',
      analysisId: 'analysis-2',
      addedAt: at.addedLater,
    });
    // 候选按新分析增量合并：contemporary 保留，deliberate 新增。
    expect(scope.candidates.map((candidate) => candidate.knowledgePointId)).toEqual([
      'word:contemporary:placeholder:1',
      'word:deliberate:placeholder:1',
    ]);
    // 旧版本分析引入的来源不再固定到目标材料，已移除；来源只指向新版本分析。
    expect(scope.sources.map((source) => source.sourceAnalysisId)).toEqual(['analysis-2', 'analysis-2']);
    expect(validateLearningState(state)).toEqual([]);
  });
});

describe('S05 失败路径', () => {
  function expectFailure(
    result: Awaited<ReturnType<typeof addMaterialToGoalUseCase>>,
    reason: string,
  ) {
    expect(result).toEqual({ ok: false, reason });
  }

  test('学习者不存在：返回 learner_not_found，不保存任何状态', async () => {
    const { state, repository } = setup();
    seedAnalyzedMaterial(state, 'material-1', 'analysis-1', ['contemporary']);

    const result = await addMaterialToGoalUseCase(
      { repository, logger: silentLogger },
      baseInput({ learnerId: 'learner-9' }),
    );

    expectFailure(result, 'learner_not_found');
    expect(repository.saves).toHaveLength(0);
    expect(state.goals).toHaveLength(0);
    expect(state.goalMaterials).toHaveLength(0);
  });

  test('目标已存在但属于其他学习者：返回 goal_conflict，不保存任何状态', async () => {
    const { state, repository } = setup();
    seedAnalyzedMaterial(state, 'material-1', 'analysis-1', ['contemporary']);
    state.goals.push({
      id: 'goal-1',
      learnerId: 'learner-2',
      title: '他人目标',
      targetFluency: { R: 80, P: 80 },
      status: 'active',
      createdAt: at.created,
      updatedAt: at.created,
    });

    const result = await addMaterialToGoalUseCase(
      { repository, logger: silentLogger },
      baseInput({}),
    );

    expectFailure(result, 'goal_conflict');
    expect(repository.saves).toHaveLength(0);
    expect(state.goalMaterials).toHaveLength(0);
  });

  test('材料属于其他学习者：返回 material_conflict，不保存任何状态', async () => {
    const { state, repository } = setup();
    seedAnalyzedMaterial(state, 'material-1', 'analysis-1', ['contemporary'], 'learner-2');

    const result = await addMaterialToGoalUseCase(
      { repository, logger: silentLogger },
      baseInput({}),
    );

    expectFailure(result, 'material_conflict');
    expect(repository.saves).toHaveLength(0);
    expect(state.goals).toHaveLength(0);
  });

  test('材料不存在：返回 material_not_found，不保存任何状态', async () => {
    const { state, repository } = setup();

    const result = await addMaterialToGoalUseCase(
      { repository, logger: silentLogger },
      baseInput({}),
    );

    expectFailure(result, 'material_not_found');
    expect(repository.saves).toHaveLength(0);
    expect(state.goals).toHaveLength(0);
  });

  test('分析不存在：返回 analysis_not_found，不保存任何状态', async () => {
    const { state, repository } = setup();
    state.materials.push(createMaterial('material-1'));

    const result = await addMaterialToGoalUseCase(
      { repository, logger: silentLogger },
      baseInput({}),
    );

    expectFailure(result, 'analysis_not_found');
    expect(repository.saves).toHaveLength(0);
    expect(state.goals).toHaveLength(0);
  });

  test('分析属于其他材料：返回 analysis_conflict，不保存任何状态', async () => {
    const { state, repository } = setup();
    seedAnalyzedMaterial(state, 'material-1', 'analysis-1', ['contemporary']);
    state.materialAnalyses.push(analysisOf('analysis-other', 'material-other', ['resilient']));

    const result = await addMaterialToGoalUseCase(
      { repository, logger: silentLogger },
      baseInput({ analysisId: 'analysis-other' }),
    );

    expectFailure(result, 'analysis_conflict');
    expect(repository.saves).toHaveLength(0);
    expect(state.goals).toHaveLength(0);
  });

  test('分析未完成：返回 analysis_not_analyzed，不把该分析固定到目标', async () => {
    const { state, repository } = setup();
    state.materials.push(createMaterial('material-1'));
    state.materialAnalyses.push(analysisOf('analysis-1', 'material-1', ['contemporary'], 'pending'));

    const result = await addMaterialToGoalUseCase(
      { repository, logger: silentLogger },
      baseInput({}),
    );

    expectFailure(result, 'analysis_not_analyzed');
    expect(repository.saves).toHaveLength(0);
    expect(state.goals).toHaveLength(0);
  });

  test.each([
    {
      name: '创建目标缺少标题',
      overrides: { title: '' },
      reason: 'invalid_input',
    },
    {
      name: '目标流利度为负数',
      overrides: { targetFluency: { R: -5, P: 80 } },
      reason: 'invalid_input',
    },
    {
      name: '加入时间不是合法日期时间',
      overrides: { addedAt: 'not-a-date' },
      reason: 'invalid_input',
    },
  ])('非法输入（$name）：返回 $reason，不保存任何状态', async ({ overrides, reason }) => {
    const { state, repository } = setup();
    seedAnalyzedMaterial(state, 'material-1', 'analysis-1', ['contemporary']);

    const result = await addMaterialToGoalUseCase(
      { repository, logger: silentLogger },
      baseInput(overrides),
    );

    expectFailure(result, reason);
    expect(repository.saves).toHaveLength(0);
    expect(state.goals).toHaveLength(0);
    expect(state.goalMaterials).toHaveLength(0);
    expect(state.goalKnowledgePoints).toHaveLength(0);
    expect(state.goalKnowledgePointSources).toHaveLength(0);
    expect(state.knowledgePoints).toHaveLength(0);
  });
});
