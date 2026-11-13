import { addAnalyzedMaterialToGoal, createLearningGoal } from '../domain/functions';
import type {
  FluencyScores,
  GoalKnowledgePoint,
  GoalKnowledgePointSource,
  GoalMaterial,
  ISODateTime,
  KnowledgePoint,
  LearningGoal,
} from '../domain/model';
import { logger as defaultLogger, type AppLogger } from './logger';
import type { GoalMaterialRepository } from './ports';

export interface AddMaterialToGoalUseCaseInput {
  /** 应用层分配的目标 ID；目标不存在时创建，已存在时加入该目标。 */
  goalId: string;
  learnerId: string;
  /** 目标标题；仅创建新目标时使用，加入已有目标时忽略。 */
  title?: string;
  /** 目标内所有知识点的目标流利度；仅创建新目标时使用。 */
  targetFluency?: FluencyScores;
  materialId: string;
  /** 用于确定学习范围的分析 ID，必须是已完成分析。 */
  analysisId: string;
  /** 材料加入目标的时间。 */
  addedAt: ISODateTime;
  /** 当前时间；创建新目标时作为创建时间。 */
  now: ISODateTime;
}

export type AddMaterialToGoalFailure =
  | 'learner_not_found'
  | 'goal_conflict'
  | 'material_not_found'
  | 'material_conflict'
  | 'analysis_not_found'
  | 'analysis_not_analyzed'
  | 'analysis_conflict'
  | 'invalid_input';

export interface AddMaterialToGoalScope {
  goal: LearningGoal;
  materialLink: GoalMaterial;
  knowledgePoints: KnowledgePoint[];
  candidates: GoalKnowledgePoint[];
  sources: GoalKnowledgePointSource[];
}

export type AddMaterialToGoalResult =
  | ({ ok: true } & AddMaterialToGoalScope)
  | { ok: false; reason: AddMaterialToGoalFailure };

/**
 * S05：创建目标并加入已分析材料。
 * 加载学习者、材料与已完成分析；目标不存在时调用 createLearningGoal 创建，
 * 已存在时直接加载；再调用 addAnalyzedMaterialToGoal 把分析的知识点增量合并进
 * 目标候选与来源，同一次写入保存目标、材料关联、规范化知识点、候选和来源。
 * 同一材料同一分析版本重复加入时幂等返回，不重复写入；
 * 同一材料新版本分析加入时更新固定的 analysisId，并移除旧版本分析引入的来源；
 * 增量合并不重置已有候选的选择状态，本用例也不初始化流利度（由 S06 负责）。
 */
export async function addMaterialToGoalUseCase(
  deps: { repository: GoalMaterialRepository; logger?: AppLogger },
  input: AddMaterialToGoalUseCaseInput,
): Promise<AddMaterialToGoalResult> {
  const logger = deps.logger ?? defaultLogger;
  logger.info(
    {
      goalId: input.goalId,
      learnerId: input.learnerId,
      materialId: input.materialId,
      analysisId: input.analysisId,
      isNewGoalTitleProvided: input.title != null,
    },
    '目标加入材料：开始',
  );

  const learner = await deps.repository.loadLearner(input.learnerId);
  if (!learner) {
    logger.warn({ learnerId: input.learnerId }, '目标加入材料：失败（学习者不存在）');
    return { ok: false, reason: 'learner_not_found' };
  }

  const existingGoal = await deps.repository.loadGoal(input.goalId);
  if (existingGoal && existingGoal.learnerId !== input.learnerId) {
    logger.warn({ goalId: input.goalId }, '目标加入材料：失败（目标属于其他学习者）');
    return { ok: false, reason: 'goal_conflict' };
  }

  const material = await deps.repository.loadMaterial(input.materialId);
  if (!material) {
    logger.warn({ materialId: input.materialId }, '目标加入材料：失败（材料不存在）');
    return { ok: false, reason: 'material_not_found' };
  }
  if (material.learnerId !== input.learnerId) {
    logger.warn({ materialId: input.materialId }, '目标加入材料：失败（材料属于其他学习者）');
    return { ok: false, reason: 'material_conflict' };
  }

  const analysis = await deps.repository.loadAnalysis(input.analysisId);
  if (!analysis) {
    logger.warn({ analysisId: input.analysisId }, '目标加入材料：失败（分析不存在）');
    return { ok: false, reason: 'analysis_not_found' };
  }
  if (analysis.materialId !== material.id) {
    logger.warn({ analysisId: input.analysisId }, '目标加入材料：失败（分析属于其他材料）');
    return { ok: false, reason: 'analysis_conflict' };
  }
  if (analysis.status !== 'analyzed') {
    logger.warn({ analysisId: input.analysisId, status: analysis.status }, '目标加入材料：失败（分析未完成）');
    return { ok: false, reason: 'analysis_not_analyzed' };
  }

  const scope = await deps.repository.loadGoalScope(input.goalId);
  const existingLink = scope.materialLinks.find((link) => link.materialId === material.id) ?? null;

  if (existingLink && existingLink.analysisId === analysis.id && existingGoal) {
    const seenKnowledgePoints = new Set<string>();
    const knowledgePoints: KnowledgePoint[] = [];
    for (const item of analysis.items) {
      const id = item.knowledgePoint.id;
      if (!seenKnowledgePoints.has(id)) {
        seenKnowledgePoints.add(id);
        knowledgePoints.push(item.knowledgePoint);
      }
    }
    logger.info({ goalId: input.goalId, materialId: material.id }, '目标加入材料：已存在，幂等返回');
    return {
      ok: true,
      goal: existingGoal,
      materialLink: existingLink,
      knowledgePoints,
      candidates: scope.candidates,
      sources: scope.sources,
    };
  }

  let goal: LearningGoal;
  if (existingGoal) {
    goal = existingGoal;
  } else {
    if (!input.title || !input.title.trim() || !input.targetFluency) {
      logger.warn({ goalId: input.goalId }, '目标加入材料：失败（创建目标缺少标题或目标流利度）');
      return { ok: false, reason: 'invalid_input' };
    }
    try {
      goal = createLearningGoal({
        id: input.goalId,
        learnerId: input.learnerId,
        title: input.title,
        targetFluency: input.targetFluency,
        now: input.now,
      });
    } catch {
      logger.warn({ goalId: input.goalId }, '目标加入材料：失败（目标构造校验未通过）');
      return { ok: false, reason: 'invalid_input' };
    }
  }

  let result;
  try {
    result = addAnalyzedMaterialToGoal({
      goal,
      material,
      analysis,
      existingCandidates: scope.candidates,
      existingSources: scope.sources,
      addedAt: input.addedAt,
    });
  } catch {
    logger.warn({ goalId: input.goalId }, '目标加入材料：失败（合并学习范围校验未通过）');
    return { ok: false, reason: 'invalid_input' };
  }

  // 同材料从旧分析版本切换到新版本时，旧版本分析引入的来源不再固定到目标材料，一并移除。
  const previousAnalysisId = existingLink?.analysisId ?? null;
  const sources = previousAnalysisId
    ? result.sources.filter((source) => source.sourceAnalysisId !== previousAnalysisId)
    : result.sources;

  await deps.repository.saveGoalMaterial({
    goal: result.goal,
    materialLink: result.materialLink,
    knowledgePoints: result.knowledgePoints,
    candidates: result.candidates,
    sources,
  });
  logger.info(
    {
      goalId: result.goal.id,
      materialId: material.id,
      analysisId: analysis.id,
      knowledgePointCount: result.knowledgePoints.length,
      candidateCount: result.candidates.length,
      sourceCount: sources.length,
    },
    '目标加入材料：学习范围已保存',
  );
  return {
    ok: true,
    goal: result.goal,
    materialLink: result.materialLink,
    knowledgePoints: result.knowledgePoints,
    candidates: result.candidates,
    sources,
  };
}
