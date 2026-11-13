import {
  completeVocabularyAssessment,
  createVocabularyAssessment,
  generateVocabularyAssessmentTasks,
  recordVocabularyAssessmentAttempt,
  sampleVocabularyForAssessment,
  toLearnerVocabularyAssessmentTask,
} from '../domain/functions';
import type { VocabularyAssessmentWordFamily } from '../domain/functions';
import type {
  ISODateTime,
  Learner,
  LearnerVocabularyAssessmentTask,
  VocabularyAssessment,
  VocabularyAssessmentAttempt,
  VocabularyAssessmentTask,
  VocabularyBand,
  VocabularyEstimate,
  VocabularyListReference,
} from '../domain/model';
import { logger as defaultLogger, type AppLogger } from './logger';
import type { LearningStateRepository } from './repository';

/**
 * 词表读取端口：词族清单与词段词族总数存放在学习状态之外（本地版本化 JSON），
 * 由应用层/基础设施实现；测试使用内存实现。
 */
export interface VocabularyListRepository {
  loadWordFamilies(list: VocabularyListReference): Promise<VocabularyAssessmentWordFamily[]>;
  loadBandWordFamilyCounts(
    list: VocabularyListReference,
  ): Promise<Partial<Record<VocabularyBand, number>>>;
}

export interface StartVocabularyAssessmentUseCaseInput {
  learnerId: string;
  list: VocabularyListReference;
  /** 各词段的抽样词族数。 */
  sampleCounts: Partial<Record<VocabularyBand, number>>;
  seed: string;
  /** 应用层分配的测评 ID。 */
  assessmentId: string;
  /** 与样本等长的自评任务 ID。 */
  taskIds: string[];
  now: ISODateTime;
}

export type StartVocabularyAssessmentFailure =
  | 'learner_not_found'
  | 'invalid_input'
  | 'sample_failed';

export type StartVocabularyAssessmentResult =
  | { ok: true; assessmentId: string; tasks: LearnerVocabularyAssessmentTask[] }
  | { ok: false; reason: StartVocabularyAssessmentFailure };

/**
 * S02：开始词汇自评定级。
 * 加载学习者，通过词表 Repository 读取指定版本的词族，分层抽样后为样本创建
 * 只含被测词汇的自评任务（不生成语境、选项或正确答案，也不调用 AI），
 * 创建进行中的测评并在同一写入中保存测评及全部自评任务；
 * 返回按顺序转换的公开自评任务，不暴露服务端词义或答案。
 */
export async function startVocabularyAssessmentUseCase(
  deps: {
    repository: LearningStateRepository;
    vocabularyListRepository: VocabularyListRepository;
    logger?: AppLogger;
  },
  input: StartVocabularyAssessmentUseCaseInput,
): Promise<StartVocabularyAssessmentResult> {
  const logger = deps.logger ?? defaultLogger;
  logger.info(
    {
      learnerId: input.learnerId,
      listId: input.list.id,
      listVersion: input.list.version,
      assessmentId: input.assessmentId,
    },
    '词汇自评：开始',
  );

  const snapshot = deps.repository.load();
  const learner = snapshot.state.learners.find((item) => item.id === input.learnerId);
  if (!learner) {
    logger.warn({ learnerId: input.learnerId }, '词汇自评：失败（学习者不存在）');
    return { ok: false, reason: 'learner_not_found' };
  }

  const families = await deps.vocabularyListRepository.loadWordFamilies(input.list);
  let samples;
  try {
    samples = sampleVocabularyForAssessment({
      list: input.list,
      families,
      sampleCounts: input.sampleCounts,
      seed: input.seed,
    });
  } catch (error) {
    logger.warn(
      { learnerId: input.learnerId, error: error instanceof Error ? error.message : String(error) },
      '词汇自评：失败（抽样未通过）',
    );
    return { ok: false, reason: 'sample_failed' };
  }

  let tasks: VocabularyAssessmentTask[];
  let assessment: Extract<VocabularyAssessment, { status: 'in_progress' }>;
  try {
    tasks = generateVocabularyAssessmentTasks({ samples, taskIds: input.taskIds });
    assessment = createVocabularyAssessment({
      id: input.assessmentId,
      learnerId: learner.id,
      tasks,
      now: input.now,
    });
  } catch (error) {
    logger.warn(
      { learnerId: input.learnerId, error: error instanceof Error ? error.message : String(error) },
      '词汇自评：失败（输入校验未通过）',
    );
    return { ok: false, reason: 'invalid_input' };
  }

  deps.repository.save(
    {
      ...snapshot.state,
      vocabularyAssessments: [...snapshot.state.vocabularyAssessments, assessment],
      vocabularyAssessmentTasks: [...snapshot.state.vocabularyAssessmentTasks, ...tasks],
    },
    snapshot.revision,
  );
  logger.info(
    { learnerId: learner.id, assessmentId: assessment.id, taskCount: tasks.length },
    '词汇自评：测评及自评任务已保存',
  );
  return {
    ok: true,
    assessmentId: assessment.id,
    tasks: tasks.map(toLearnerVocabularyAssessmentTask),
  };
}

export interface SubmitVocabularyAssessmentUseCaseInput {
  assessmentId: string;
  taskId: string;
  /** 应用层分配的自评作答 ID；重试使用同一 ID 时幂等返回当前进度。 */
  attemptId: string;
  known: boolean;
  answeredAt: ISODateTime;
  /** 完成测评所需的词表引用与词段词族总数由词表 Repository 按此版本读取。 */
  list: VocabularyListReference;
}

export type SubmitVocabularyAssessmentFailure =
  | 'assessment_not_found'
  | 'task_not_found'
  | 'vocabulary_list_unavailable'
  | 'invalid_input';

export type SubmitVocabularyAssessmentResult =
  | { ok: true; status: 'in_progress'; answered: number; total: number }
  | { ok: true; status: 'completed'; result: VocabularyEstimate }
  | { ok: false; reason: SubmitVocabularyAssessmentFailure };

/**
 * S03：提交词汇自评并完成测评。
 * 原样记录学习者的 known 自评（不做客观对错判定，也不调用 AI）；
 * 同一 attemptId 重试直接返回当前进度，不重复追加；
 * 仍有未自评词汇时只保存本次自评，测评保持 in_progress；
 * 全部自评后按各词段 knownCount / sampleCount 计算掌握概率与 Wilson 区间，
 * 在同一写入中保存最后一条自评、已完成测评和更新后的学习者（currentVocabulary）。
 */
export async function submitVocabularyAssessmentUseCase(
  deps: {
    repository: LearningStateRepository;
    vocabularyListRepository: VocabularyListRepository;
    logger?: AppLogger;
  },
  input: SubmitVocabularyAssessmentUseCaseInput,
): Promise<SubmitVocabularyAssessmentResult> {
  const logger = deps.logger ?? defaultLogger;
  logger.info({ assessmentId: input.assessmentId, taskId: input.taskId }, '词汇自评提交：开始');

  const snapshot = deps.repository.load();
  const assessment = snapshot.state.vocabularyAssessments.find(
    (item) => item.id === input.assessmentId,
  );
  if (!assessment) {
    logger.warn({ assessmentId: input.assessmentId }, '词汇自评提交：失败（测评不存在）');
    return { ok: false, reason: 'assessment_not_found' };
  }
  const learner = snapshot.state.learners.find((item) => item.id === assessment.learnerId);
  if (!learner) {
    logger.warn({ assessmentId: input.assessmentId }, '词汇自评提交：失败（学习者不存在）');
    return { ok: false, reason: 'assessment_not_found' };
  }
  const tasks = snapshot.state.vocabularyAssessmentTasks.filter((task) =>
    assessment.taskIds.includes(task.id),
  );
  const task = tasks.find((item) => item.id === input.taskId);
  if (!task) {
    logger.warn(
      { assessmentId: input.assessmentId, taskId: input.taskId },
      '词汇自评提交：失败（任务不属于测评）',
    );
    return { ok: false, reason: 'task_not_found' };
  }

  const previousAttempts = snapshot.state.vocabularyAssessmentAttempts.filter(
    (attempt) => attempt.assessmentId === assessment.id,
  );
  if (previousAttempts.some((attempt) => attempt.id === input.attemptId)) {
    logger.debug({ assessmentId: assessment.id }, '词汇自评提交：attemptId 已处理，幂等返回');
    return progressOf(assessment, tasks, previousAttempts);
  }

  let attempt: VocabularyAssessmentAttempt;
  try {
    attempt = recordVocabularyAssessmentAttempt({
      attemptId: input.attemptId,
      assessment,
      task,
      previousAttempts,
      known: input.known,
      answeredAt: input.answeredAt,
    });
  } catch (error) {
    logger.warn(
      { assessmentId: assessment.id, error: error instanceof Error ? error.message : String(error) },
      '词汇自评提交：失败（输入校验未通过）',
    );
    return { ok: false, reason: 'invalid_input' };
  }
  const attempts = [...previousAttempts, attempt];

  if (assessment.taskIds.some((taskId) => !attempts.some((item) => item.taskId === taskId))) {
    deps.repository.save(
      {
        ...snapshot.state,
        vocabularyAssessmentAttempts: [...snapshot.state.vocabularyAssessmentAttempts, attempt],
      },
      snapshot.revision,
    );
    const answered = tasks.filter((item) =>
      attempts.some((recorded) => recorded.taskId === item.id),
    ).length;
    logger.info(
      { assessmentId: assessment.id, answered, total: tasks.length },
      '词汇自评提交：已保存，测评未完成',
    );
    return { ok: true, status: 'in_progress', answered, total: tasks.length };
  }

  const bandWordFamilyCounts = await deps.vocabularyListRepository.loadBandWordFamilyCounts(
    input.list,
  );
  let completed: { assessment: Extract<VocabularyAssessment, { status: 'completed' }>; learner: Learner };
  try {
    completed = completeVocabularyAssessment({
      learner,
      assessment,
      tasks,
      attempts,
      list: input.list,
      bandWordFamilyCounts,
      now: input.answeredAt,
    });
  } catch (error) {
    logger.warn(
      { assessmentId: assessment.id, error: error instanceof Error ? error.message : String(error) },
      '词汇自评提交：失败（词表统计缺失或不匹配）',
    );
    return { ok: false, reason: 'vocabulary_list_unavailable' };
  }

  deps.repository.save(
    {
      ...snapshot.state,
      learners: snapshot.state.learners.map((item) =>
        item.id === learner.id ? completed.learner : item,
      ),
      vocabularyAssessments: snapshot.state.vocabularyAssessments.map((item) =>
        item.id === assessment.id ? completed.assessment : item,
      ),
      vocabularyAssessmentAttempts: [...snapshot.state.vocabularyAssessmentAttempts, attempt],
    },
    snapshot.revision,
  );
  logger.info(
    { assessmentId: assessment.id, bandCount: completed.assessment.result.bands.length },
    '词汇自评提交：测评已完成，词汇估计已更新',
  );
  return { ok: true, status: 'completed', result: completed.assessment.result };
}

function progressOf(
  assessment: VocabularyAssessment,
  tasks: VocabularyAssessmentTask[],
  attempts: VocabularyAssessmentAttempt[],
): SubmitVocabularyAssessmentResult {
  const answered = tasks.filter((task) =>
    attempts.some((attempt) => attempt.taskId === task.id),
  ).length;
  if (assessment.status === 'completed' && assessment.result) {
    return { ok: true, status: 'completed', result: assessment.result };
  }
  return { ok: true, status: 'in_progress', answered, total: tasks.length };
}
