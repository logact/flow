/// <reference types="jest" />

import { selectKnowledgePointsUseCase } from '../lib/application/knowledge-point-selection';
import type {
  KnowledgePointSelectionContext,
  KnowledgePointSelectionRepository,
  SaveKnowledgePointSelectionPayload,
  VocabularyIndex,
} from '../lib/application/ports';
import * as Domain from '../lib/domain/functions';
import { validateLearningState } from '../lib/domain/invariants';
import type * as Model from '../lib/domain/model';
import { silentLogger } from './helpers/silent-logger';

const list = { id: 'bnc-coca-l6', version: '2.0.0' };
const at = {
  created: '2026-11-12T00:00:00.000Z',
  assessed: '2026-11-12T00:10:00.000Z',
  added: '2026-11-12T00:20:00.000Z',
  selected: '2026-11-12T00:30:00.000Z',
};

function bandEstimate(band: string, knownProbability: number): Model.VocabularyBandEstimate {
  return {
    band: band as Model.VocabularyBand,
    wordFamilyCount: 1000,
    sampleCount: 10,
    knownCount: Math.round(knownProbability * 10),
    knownProbability,
    interval: null,
  };
}

function vocabulary(bands: Model.VocabularyBandEstimate[]): Model.VocabularyEstimate {
  return { list, bands, estimatedAt: at.assessed };
}

function wordKP(id: string, lemma: string): Model.VocabularyKnowledgePoint {
  return {
    id,
    kind: 'word',
    lemma,
    wordFamily: lemma,
    sense: { id: `sense:${lemma}`, definition: `Meaning of ${lemma}`, partOfSpeech: null, explanation: null },
  };
}

function candidate(
  knowledgePointId: string,
  selection: Model.GoalKnowledgePointSelection = 'undecided',
): Model.GoalKnowledgePoint {
  return { goalId: 'goal-1', knowledgePointId, selection, addedAt: at.added, selectionUpdatedAt: at.added };
}

function learnerWith(vocab: Model.VocabularyEstimate | null): Model.Learner {
  return {
    id: 'learner-1',
    currentVocabulary: vocab,
    dailyTaskCapacity: 5,
    timezone: 'Asia/Shanghai',
    createdAt: at.created,
    updatedAt: at.assessed,
  };
}

const goal: Model.LearningGoal = {
  id: 'goal-1',
  learnerId: 'learner-1',
  title: '读懂并谈论团队如何应对变化',
  targetFluency: { R: 80, P: 80 },
  status: 'active',
  createdAt: at.created,
  updatedAt: at.added,
};

class MemorySelectionRepository implements KnowledgePointSelectionRepository {
  saved: SaveKnowledgePointSelectionPayload[] = [];

  constructor(public context: KnowledgePointSelectionContext) {}

  async loadSelectionContext(goalId: string): Promise<KnowledgePointSelectionContext | null> {
    return this.context.goal.id === goalId ? this.context : null;
  }

  async saveKnowledgePointSelection(payload: SaveKnowledgePointSelectionPayload): Promise<void> {
    this.saved.push(payload);
    for (const updated of payload.updatedCandidates) {
      const index = this.context.candidates
        .findIndex((item) => item.knowledgePointId === updated.knowledgePointId);
      if (index >= 0) this.context.candidates[index] = updated;
    }
    this.context.learnerKnowledgePoints.push(...payload.newLearnerKnowledgePoints);
    this.context.classifications.push(...payload.newClassifications);
  }
}

function makeRepo(options: {
  candidates: Model.GoalKnowledgePoint[];
  knowledgePoints: Model.KnowledgePoint[];
  classifications?: Model.KnowledgePointVocabularyClassification[];
  learnerKnowledgePoints?: Model.LearnerKnowledgePoint[];
  vocab?: Model.VocabularyEstimate | null;
}): MemorySelectionRepository {
  return new MemorySelectionRepository({
    learner: learnerWith(options.vocab ?? null),
    goal,
    candidates: options.candidates,
    knowledgePoints: options.knowledgePoints,
    classifications: options.classifications ?? [],
    learnerKnowledgePoints: options.learnerKnowledgePoints ?? [],
  });
}

function run(repo: MemorySelectionRepository, input: {
  selections: Array<{ knowledgePointId: string; selection: Model.GoalKnowledgePointSelection }>;
  policyVersion?: string;
  goalId?: string;
  vocabularyIndex?: VocabularyIndex;
}) {
  return selectKnowledgePointsUseCase(
    { repository: repo, vocabularyIndex: input.vocabularyIndex, logger: silentLogger },
    { goalId: input.goalId ?? 'goal-1', policyVersion: input.policyVersion ?? 'initial-v2', now: at.selected, selections: input.selections },
  );
}

function emptyState(): Model.LearningState {
  return {
    learners: [],
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

function toState(repo: MemorySelectionRepository): Model.LearningState {
  const context = repo.context;
  return {
    ...emptyState(),
    learners: [context.learner],
    goals: [context.goal],
    knowledgePoints: context.knowledgePoints,
    knowledgePointVocabularyClassifications: context.classifications,
    goalKnowledgePoints: context.candidates,
    learnerKnowledgePoints: context.learnerKnowledgePoints,
  };
}

function initialLearning(knowledgePoint: Model.KnowledgePoint): Model.LearnerKnowledgePoint {
  const derived = Domain.deriveInitialFluency({
    vocabulary: vocabulary([bandEstimate('2k', 0.9)]),
    classification: {
      knowledgePointId: knowledgePoint.id,
      list,
      band: '2k',
    },
    policyVersion: 'initial-v1',
  });
  return Domain.initializeLearnerKnowledgePoint({
    learnerId: 'learner-1',
    knowledgePoint,
    derived,
    now: at.added,
  });
}

describe('S06 设置知识点选择并初始化新增学习项', () => {
  test('1. 黄金路径：批量混合选择、离散档位初始化、同批保存并可重新加载', async () => {
    const kpHigh = wordKP('word:resilient:s1', 'resilient');
    const kpMid = wordKP('word:deliberate:s1', 'deliberate');
    const kpExcluded = wordKP('word:quit:s1', 'quit');
    const kpUndecided = wordKP('word:setback:s1', 'setback');
    const kpExisting = wordKP('word:adjust:s1', 'adjust');
    const existingLearning = initialLearning(kpExisting);
    const repo = makeRepo({
      vocab: vocabulary([bandEstimate('9k', 0.9), bandEstimate('5k', 0.5)]),
      candidates: [
        candidate(kpHigh.id),
        candidate(kpMid.id),
        candidate(kpExcluded.id),
        candidate(kpUndecided.id),
        candidate(kpExisting.id, 'included'),
      ],
      knowledgePoints: [kpHigh, kpMid, kpExcluded, kpUndecided, kpExisting],
      classifications: [
        { knowledgePointId: kpHigh.id, list, band: '9k' },
        { knowledgePointId: kpMid.id, list, band: '5k' },
        // 既有学习状态当初初始化时留下的分类记录，S06 不会改动它。
        { knowledgePointId: kpExisting.id, list, band: '2k' },
      ],
      learnerKnowledgePoints: [existingLearning],
    });

    const result = await run(repo, {
      selections: [
        { knowledgePointId: kpHigh.id, selection: 'included' },
        { knowledgePointId: kpMid.id, selection: 'included' },
        { knowledgePointId: kpExcluded.id, selection: 'excluded' },
        { knowledgePointId: kpExisting.id, selection: 'included' },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 离散档位映射：0.9 → free 档 R=50，0.5 → cued 档 R=30；P 自动退一档，全部低于 60。
    expect(result.initialized.map((item) => item.initialFluency)).toEqual([
      { R: 50, P: 30 },
      { R: 30, P: 10 },
    ]);
    const [high, mid] = result.initialized;
    expect(high.knowledgePointId).toBe(kpHigh.id);
    expect(mid.knowledgePointId).toBe(kpMid.id);
    // 初始化证据留档：词汇快照、词频分类、策略版本、P 为推导值。
    expect(high.initialization.policyVersion).toBe('initial-v2');
    expect(high.initialization.productionBasis).toBe('derived_from_receptive');
    expect(high.initialization.classification).toMatchObject({ knowledgePointId: kpHigh.id, band: '9k' });
    // 新学习状态的复习计划从当前时间起步，version 从 0 开始。
    for (const learning of result.initialized) {
      expect(learning.dimensions.R.review).toMatchObject({ intervalDays: 0, dueAt: at.selected, graduated: false });
      expect(learning.dimensions.P.review.dueAt).toBe(at.selected);
      expect(learning.version).toBe(0);
      expect(learning.createdAt).toBe(at.selected);
    }
    // 选择变更全部落到候选上；未提交的 undecided 候选不受影响；重复 included 幂等。
    const byId = new Map(result.candidates.map((item) => [item.knowledgePointId, item]));
    expect(byId.get(kpHigh.id)?.selection).toBe('included');
    expect(byId.get(kpExcluded.id)?.selection).toBe('excluded');
    expect(byId.get(kpUndecided.id)?.selection).toBe('undecided');
    expect(byId.get(kpExisting.id)?.selection).toBe('included');
    expect(byId.get(kpHigh.id)?.selectionUpdatedAt).toBe(at.selected);
    // excluded / undecided / 已有状态的候选不产生新学习状态。
    expect(result.initialized).toHaveLength(2);
    // 选择变更与新增状态在同一写入中保存，重新加载后与返回值一致。
    expect(repo.saved).toHaveLength(1);
    expect(repo.saved[0].updatedCandidates).toHaveLength(4);
    expect(repo.saved[0].newLearnerKnowledgePoints).toHaveLength(2);
    const reloaded = await repo.loadSelectionContext('goal-1');
    expect(reloaded?.candidates).toEqual(result.candidates);
    expect(reloaded?.learnerKnowledgePoints).toEqual([existingLearning, ...result.initialized]);
    expect(validateLearningState(toState(repo))).toEqual([]);
  });

  test('2. 低档与边界：中低概率映射低档，词表未收录按概率 0 处理', async () => {
    const kpLow = wordKP('word:ubiquitous:s1', 'ubiquitous');
    const kpOut = wordKP('word:jargon:placeholder:1', 'jargon');
    const repo = makeRepo({
      vocab: vocabulary([bandEstimate('7k', 0.3)]),
      candidates: [candidate(kpLow.id), candidate(kpOut.id)],
      knowledgePoints: [kpLow, kpOut],
      classifications: [{ knowledgePointId: kpLow.id, list, band: '7k' }],
    });

    const result = await run(repo, {
      selections: [
        { knowledgePointId: kpLow.id, selection: 'included' },
        { knowledgePointId: kpOut.id, selection: 'included' },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.initialized.map((item) => item.initialFluency)).toEqual([
      { R: 10, P: 0 },
      { R: 0, P: 0 },
    ]);
    const [low, out] = result.initialized;
    // P 封底 0，不出现负分。
    expect(low.dimensions.P.fluency).toBe(0);
    // 词表未收录：classification 为空，走 ENCODE 起点。
    expect(out.initialization.classification).toBeNull();
    expect(validateLearningState(toState(repo))).toEqual([]);
  });

  test('3. 已有学习状态不重置：excluded 不删除历史，再 included 不重建', async () => {
    const kp = wordKP('word:adjust:s1', 'adjust');
    const learning = initialLearning(kp);
    const repo = makeRepo({
      vocab: vocabulary([bandEstimate('2k', 0.9)]),
      candidates: [candidate(kp.id, 'included')],
      knowledgePoints: [kp],
      classifications: [{ knowledgePointId: kp.id, list, band: '2k' }],
      learnerKnowledgePoints: [learning],
    });

    const excluded = await run(repo, { selections: [{ knowledgePointId: kp.id, selection: 'excluded' }] });
    expect(excluded.ok).toBe(true);
    // excluded 不删除历史学习状态，写入负载里也没有学习状态变更。
    expect(repo.context.learnerKnowledgePoints).toEqual([learning]);
    expect(repo.saved[0].newLearnerKnowledgePoints).toEqual([]);
    expect(validateLearningState(toState(repo))).toEqual([]);

    const reIncluded = await run(repo, { selections: [{ knowledgePointId: kp.id, selection: 'included' }] });
    expect(reIncluded.ok).toBe(true);
    if (!reIncluded.ok) return;
    // 再 included 不重建不覆盖：原有记录字段原样保留。
    expect(reIncluded.initialized).toEqual([]);
    expect(repo.context.learnerKnowledgePoints).toEqual([learning]);
    expect(repo.context.learnerKnowledgePoints[0].version).toBe(learning.version);
    expect(repo.context.learnerKnowledgePoints[0].createdAt).toBe(learning.createdAt);
    const selected = reIncluded.candidates.find((item) => item.knowledgePointId === kp.id);
    expect(selected?.selection).toBe('included');
    expect(selected?.selectionUpdatedAt).toBe(at.selected);
  });

  test('4. 测评未完成：返回前置条件错误，整批不写入', async () => {
    const kpA = wordKP('word:new-a:s1', 'newa');
    const kpB = wordKP('word:new-b:s1', 'newb');
    const repo = makeRepo({
      vocab: null,
      candidates: [candidate(kpA.id), candidate(kpB.id, 'excluded')],
      knowledgePoints: [kpA, kpB],
    });

    const result = await run(repo, {
      selections: [
        { knowledgePointId: kpA.id, selection: 'included' },
        { knowledgePointId: kpB.id, selection: 'included' },
      ],
    });

    expect(result).toEqual({ ok: false, reason: 'assessment_incomplete' });
    // 整批零写入：候选选择保持原样，Repository 没有保存调用。
    expect(repo.saved).toEqual([]);
    expect(repo.context.candidates.map((item) => item.selection)).toEqual(['undecided', 'excluded']);
  });

  test('5. 批内失败原子性与越权候选：任一落库前失败整批回滚', async () => {
    const kpOk = wordKP('word:ok:s1', 'ok');
    const kpMismatch = wordKP('word:mismatch:s1', 'mismatch');
    const repo = makeRepo({
      vocab: vocabulary([bandEstimate('2k', 0.9)]),
      candidates: [candidate(kpOk.id), candidate(kpMismatch.id)],
      knowledgePoints: [kpOk, kpMismatch],
      classifications: [
        { knowledgePointId: kpOk.id, list, band: '2k' },
        // 词表版本与词汇估计不一致，deriveInitialFluency 会抛错。
        { knowledgePointId: kpMismatch.id, list: { id: list.id, version: '1.0.0' }, band: '2k' },
      ],
    });

    const failed = await run(repo, {
      selections: [
        { knowledgePointId: kpOk.id, selection: 'included' },
        { knowledgePointId: kpMismatch.id, selection: 'included' },
      ],
    });

    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.reason).toBe('initialization_failed');
    // 先处理完的 kpOk 选择变更也不能部分落库。
    expect(repo.saved).toEqual([]);
    expect(repo.context.candidates.every((item) => item.selection === 'undecided')).toBe(true);

    const unknown = await run(repo, {
      selections: [{ knowledgePointId: 'word:not-in-goal:s1', selection: 'included' }],
    });
    expect(unknown).toEqual({ ok: false, reason: 'unknown_candidate' });
    expect(repo.saved).toEqual([]);
  });

  test('6. 对齐大场景第 6 步：四个重点候选纳入并分流到不同练习区', async () => {
    const words = [
      { lemma: 'contemporary', band: '4k', probability: 0.2 },
      { lemma: 'ubiquitous', band: '5k', probability: 0.5 },
      { lemma: 'deliberate', band: '9k', probability: 0.9 },
      { lemma: 'resilient', band: '9k', probability: 0.9 },
    ];
    const knowledgePoints = words.map((word) => wordKP(`word:${word.lemma}:s1`, word.lemma));
    const distinctBands = [...new Map(words.map((word) => [word.band, word.probability])).entries()];
    const repo = makeRepo({
      vocab: vocabulary(distinctBands.map(([band, probability]) => bandEstimate(band, probability))),
      candidates: knowledgePoints.map((kp) => candidate(kp.id)),
      knowledgePoints,
      classifications: words.map((word, index) => ({
        knowledgePointId: knowledgePoints[index].id,
        list,
        band: bandEstimate(word.band, word.probability).band,
      })),
    });

    const result = await run(repo, {
      selections: knowledgePoints.map((kp) => ({ knowledgePointId: kp.id, selection: 'included' as const })),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.initialized).toHaveLength(4);
    expect(validateLearningState(toState(repo))).toEqual([]);
    // 不同概率映射到不同练习区：不同初始分的词首任务规格不同。
    const nextSpecs = result.initialized.map((learning) => {
      const kp = knowledgePoints.find((item) => item.id === learning.knowledgePointId)!;
      return Domain.decideNextTask({
        goal,
        candidate: result.candidates.find((item) => item.knowledgePointId === kp.id)!,
        knowledgePoint: kp,
        learning,
        now: at.selected,
      });
    });
    // 0.2 → choice 档，0.5 → cued 档，0.9 → free 档；四词全部进入 RETRIEVE 区而非 ENCODE/FLUENCY。
    expect(nextSpecs.map((spec) => spec?.task)).toEqual(['RETRIEVE', 'RETRIEVE', 'RETRIEVE', 'RETRIEVE']);
    expect(nextSpecs.map((spec) => (spec?.task === 'RETRIEVE' ? spec.stage : null)))
      .toEqual(['choice', 'cued', 'free', 'free']);
  });

  test('7. 词表端口补建分类：命中建记录并参与初始分，未收录与非词汇类不建', async () => {
    const kpHit = wordKP('word:ubiquitous:s1', 'ubiquitous');
    const kpMiss = wordKP('word:jargon:s1', 'jargon');
    const kpGrammar: Model.KnowledgePoint = {
      id: 'grammar:present-perfect',
      kind: 'grammar',
      name: 'present perfect',
      sense: { id: 'sense:present-perfect', definition: '现在完成时', partOfSpeech: null, explanation: null },
    };
    const lookups: string[] = [];
    const vocabularyIndex: VocabularyIndex = {
      lookup: (lemma) => {
        lookups.push(lemma);
        return lemma === 'ubiquitous' ? { band: '5k', totalFrequency: 1200 } : null;
      },
    };
    const repo = makeRepo({
      vocab: vocabulary([bandEstimate('5k', 0.5)]),
      candidates: [candidate(kpHit.id), candidate(kpMiss.id), candidate(kpGrammar.id)],
      knowledgePoints: [kpHit, kpMiss, kpGrammar],
    });

    const result = await run(repo, {
      selections: [
        { knowledgePointId: kpHit.id, selection: 'included' },
        { knowledgePointId: kpMiss.id, selection: 'included' },
        { knowledgePointId: kpGrammar.id, selection: 'included' },
      ],
      vocabularyIndex,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 命中 5k 词族：分类记录写入并按 0.5 概率派生 R=30/P=10；未收录与非词汇类从 0 起步。
    expect(result.initialized.map((item) => item.initialFluency)).toEqual([
      { R: 30, P: 10 },
      { R: 0, P: 0 },
      { R: 0, P: 0 },
    ]);
    expect(lookups).toEqual(['ubiquitous', 'jargon']);
    const [hit, miss, grammar] = result.initialized;
    expect(hit.initialization.classification).toEqual({ knowledgePointId: kpHit.id, list, band: '5k' });
    expect(miss.initialization.classification).toBeNull();
    expect(grammar.initialization.classification).toBeNull();
    // 新分类记录随选择变更与学习状态同批写入，重新加载后可读到。
    expect(repo.saved[0].newClassifications).toEqual([{ knowledgePointId: kpHit.id, list, band: '5k' }]);
    const reloaded = await repo.loadSelectionContext('goal-1');
    expect(reloaded?.classifications).toEqual([{ knowledgePointId: kpHit.id, list, band: '5k' }]);
    expect(validateLearningState(toState(repo))).toEqual([]);
  });

  test('8. 已有分类记录不重复写入：词表端口不会覆盖既有分类', async () => {
    const kp = wordKP('word:resilient:s1', 'resilient');
    const existing = { knowledgePointId: kp.id, list, band: '9k' as const };
    const lookups: string[] = [];
    const vocabularyIndex: VocabularyIndex = {
      lookup: (lemma) => {
        lookups.push(lemma);
        return { band: '2k', totalFrequency: 9000 };
      },
    };
    const repo = makeRepo({
      vocab: vocabulary([bandEstimate('9k', 0.9)]),
      candidates: [candidate(kp.id)],
      knowledgePoints: [kp],
      classifications: [existing],
    });

    const result = await run(repo, {
      selections: [{ knowledgePointId: kp.id, selection: 'included' }],
      vocabularyIndex,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 既有 9k 分类优先，不查词表、不新建记录，初始分仍按 9k 的 0.9 派生。
    expect(lookups).toEqual([]);
    expect(result.initialized[0].initialFluency).toEqual({ R: 50, P: 30 });
    expect(result.initialized[0].initialization.classification).toEqual(existing);
    expect(repo.saved[0].newClassifications).toEqual([]);
    expect(repo.context.classifications).toEqual([existing]);
  });
});
