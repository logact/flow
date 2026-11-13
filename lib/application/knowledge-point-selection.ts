import {
  deriveInitialFluency,
  initializeLearnerKnowledgePoint,
  setGoalKnowledgePointSelection,
} from '../domain/functions';
import type {
  GoalKnowledgePoint,
  GoalKnowledgePointSelection,
  ISODateTime,
  LearnerKnowledgePoint,
} from '../domain/model';
import { logger as defaultLogger, type AppLogger } from './logger';
import type { KnowledgePointSelectionRepository } from './ports';

export interface SelectKnowledgePointsUseCaseInput {
  /** 目标 ID，候选范围由 Repository 按目标加载。 */
  goalId: string;
  /** 每个候选知识点的选择变更。 */
  selections: Array<{ knowledgePointId: string; selection: GoalKnowledgePointSelection }>;
  /** 词汇估计到初始分数的推导策略版本。 */
  policyVersion: string;
  /** 当前时间。 */
  now: ISODateTime;
}

export type SelectKnowledgePointsFailure =
  | 'goal_not_found'
  | 'invalid_input'
  | 'unknown_candidate'
  | 'assessment_incomplete'
  | 'initialization_failed';

export type SelectKnowledgePointsResult =
  | { ok: true; candidates: GoalKnowledgePoint[]; initialized: LearnerKnowledgePoint[] }
  | { ok: false; reason: SelectKnowledgePointsFailure };

const VALID_SELECTIONS: readonly GoalKnowledgePointSelection[] = ['undecided', 'included', 'excluded'];

/**
 * S06：设置知识点选择并初始化新增学习项。
 * 对每个候选调用 setGoalKnowledgePointSelection；
 * 对新变为 included 且尚无学习状态的知识点，要求学习者已完成定级（currentVocabulary 非空），
 * 再按 deriveInitialFluency 的离散档位映射初始化 R/P 分数（初始分永远低于 FLUENCY 区），
 * P 维度在 R 基础上自动退一个练习区档次；
 * 选择变更与新增学习状态在同一次写入中保存，任一步失败整批不写入；
 * excluded 不删除历史学习状态，需要取消的任务由后续 S07 决定。
 */
export async function selectKnowledgePointsUseCase(
  deps: {
    repository: KnowledgePointSelectionRepository;
    logger?: AppLogger;
  },
  input: SelectKnowledgePointsUseCaseInput,
): Promise<SelectKnowledgePointsResult> {
  const logger = deps.logger ?? defaultLogger;
  logger.info(
    { goalId: input.goalId, count: input.selections.length, policyVersion: input.policyVersion },
    '知识点选择：开始',
  );

  const context = await deps.repository.loadSelectionContext(input.goalId);
  if (!context) {
    logger.warn({ goalId: input.goalId }, '知识点选择：失败（目标不存在）');
    return { ok: false, reason: 'goal_not_found' };
  }
  if (input.selections.length === 0
    || !input.policyVersion.trim()
    || input.selections.some((item) => !VALID_SELECTIONS.includes(item.selection))) {
    logger.warn({ goalId: input.goalId }, '知识点选择：失败（输入校验未通过）');
    return { ok: false, reason: 'invalid_input' };
  }

  const existingByKnowledgePoint = new Map(
    context.learnerKnowledgePoints.map((learning) => [learning.knowledgePointId, learning]),
  );
  const updatedByKnowledgePoint = new Map<string, GoalKnowledgePoint>();
  const initialized: LearnerKnowledgePoint[] = [];

  try {
    for (const item of input.selections) {
      const current = updatedByKnowledgePoint.get(item.knowledgePointId)
        ?? context.candidates.find((candidate) => candidate.knowledgePointId === item.knowledgePointId);
      if (!current) {
        logger.warn({ goalId: input.goalId, knowledgePointId: item.knowledgePointId }, '知识点选择：失败（候选不存在）');
        return { ok: false, reason: 'unknown_candidate' };
      }
      const next = setGoalKnowledgePointSelection(current, { selection: item.selection, now: input.now });
      updatedByKnowledgePoint.set(item.knowledgePointId, next);

      const newlyIncluded = current.selection !== 'included' && next.selection === 'included';
      if (!newlyIncluded || existingByKnowledgePoint.has(item.knowledgePointId)) continue;

      const knowledgePoint = context.knowledgePoints.find((kp) => kp.id === item.knowledgePointId);
      if (!knowledgePoint) {
        throw new Error(`Knowledge point ${item.knowledgePointId} is missing from the selection context`);
      }
      const vocabulary = context.learner.currentVocabulary;
      if (!vocabulary) {
        logger.warn({ goalId: input.goalId, knowledgePointId: item.knowledgePointId }, '知识点选择：失败（测评未完成）');
        return { ok: false, reason: 'assessment_incomplete' };
      }
      const classification = context.classifications
        .find((entry) => entry.knowledgePointId === item.knowledgePointId) ?? null;
      const derived = deriveInitialFluency({
        vocabulary,
        classification,
        policyVersion: input.policyVersion,
      });
      initialized.push(initializeLearnerKnowledgePoint({
        learnerId: context.learner.id,
        knowledgePoint,
        derived,
        now: input.now,
      }));
    }
  } catch (error) {
    logger.warn(
      { goalId: input.goalId, error: error instanceof Error ? error.message : String(error) },
      '知识点选择：失败（初始化未完成）',
    );
    return { ok: false, reason: 'initialization_failed' };
  }

  await deps.repository.saveKnowledgePointSelection({
    updatedCandidates: [...updatedByKnowledgePoint.values()],
    newLearnerKnowledgePoints: initialized,
  });
  const candidates = context.candidates.map(
    (candidate) => updatedByKnowledgePoint.get(candidate.knowledgePointId) ?? candidate,
  );
  logger.info(
    { goalId: input.goalId, updatedCount: updatedByKnowledgePoint.size, initializedCount: initialized.length },
    '知识点选择：选择变更与学习状态已保存',
  );
  return { ok: true, candidates, initialized };
}
