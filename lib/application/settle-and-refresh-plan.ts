import { localDateFor } from '../domain/functions';
import type { DailyStudyPlan, ISODateTime, LearningTaskView, TaskSettlement } from '../domain/model';
import { judgeAndSettleTaskAttempt } from './judge-settle-task-attempt';
import { logger as defaultLogger, type AppLogger } from './logger';
import type { TaskAIJudge } from './ai-judge';
import type { LearningTaskRepository, TaskGenerationAIProvider } from './ports';
import {
  refreshDailyPlanUseCase,
  type RefreshDailyPlanFailure,
} from './refresh-daily-plan';
import type { LearningStateRepository } from './repository';

export interface SettleAndRefreshPlanInput {
  attemptId: string;
  judgedAt: ISODateTime;
  now: ISODateTime;
}

export type SettleAndRefreshPlanRefreshResult =
  | { ok: true; plan: DailyStudyPlan; tasks: LearningTaskView[] }
  | { ok: false; reason: RefreshDailyPlanFailure };

export interface SettleAndRefreshPlanResult {
  settlement: TaskSettlement;
  feedback: string | null;
  refresh: SettleAndRefreshPlanRefreshResult;
}

/**
 * R2：结算并刷新计划（S11 + R1 薄封装）。
 * 先调用 S11 评判并结算作答；已 settled 的作答直接返回已有结算结果，天然幂等。
 * S11 成功后同一请求内调用 R1 刷新当日计划，learnerId 取作答所属学习者，
 * date 取 now 按学习者时区换算的当日日期。
 * S11 失败整体抛出、不进入 R1；R1 失败不回滚结算，由调用方决定稍后是否单独重试。
 */
export async function settleAndRefreshPlan(
  deps: {
    repository: LearningStateRepository;
    aiJudge: TaskAIJudge;
    taskRepository: LearningTaskRepository;
    aiProvider: TaskGenerationAIProvider;
    newTaskId?: () => string;
    newPlanId?: () => string;
    maxAttempts?: number;
    logger?: AppLogger;
  },
  input: SettleAndRefreshPlanInput,
): Promise<SettleAndRefreshPlanResult> {
  const logger = deps.logger ?? defaultLogger;
  const settled = await judgeAndSettleTaskAttempt(
    deps.repository,
    deps.aiJudge,
    { attemptId: input.attemptId, judgedAt: input.judgedAt, now: input.now },
    logger,
  );

  const snapshot = deps.repository.load();
  const attempt = snapshot.state.attempts.find((item) => item.id === input.attemptId);
  const task = attempt && snapshot.state.tasks.find((item) => item.id === attempt.taskId);
  const learner = task && snapshot.state.learners.find((item) => item.id === task.learnerId);
  if (!attempt || !task || !learner) {
    throw new Error(`Settled attempt context incomplete: ${input.attemptId}`);
  }
  const refresh = await refreshDailyPlanUseCase(deps, {
    learnerId: learner.id,
    date: localDateFor(input.now, learner.timezone),
    now: input.now,
  });
  return { settlement: settled.settlement, feedback: settled.feedback, refresh };
}
