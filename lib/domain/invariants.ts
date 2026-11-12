import type {
  FluencyDimension,
  FluencyScores,
  LearningState,
  LearningTask,
  ReviewSchedule,
  TaskAttempt,
  VocabularyEstimate,
} from './model';

const DIMENSIONS: FluencyDimension[] = ['R', 'P'];

export class LearningStateInvariantError extends Error {
  constructor(readonly issues: string[]) {
    super(`LearningState 约束校验失败：\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'LearningStateInvariantError';
  }
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isLocalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isISODateTime(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !isLocalDate(match[1])) return false;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  const offsetHour = match[5] === undefined ? 0 : Number(match[5]);
  const offsetMinute = match[6] === undefined ? 0 : Number(match[6]);
  return hour <= 23 && minute <= 59 && second <= 59
    && offsetHour <= 23 && offsetMinute <= 59
    && Number.isFinite(Date.parse(value));
}

function isVocabularyBand(value: string): boolean {
  return /^[1-9]\d*k$/.test(value);
}

function isTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function checkUnique(values: string[], path: string, issues: string[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  for (const value of duplicates) issues.push(`${path} 存在重复值 ${value}`);
}

function checkDateTime(value: string, path: string, issues: string[]): void {
  if (!isISODateTime(value)) issues.push(`${path} 不是有效的 ISO 8601 日期时间`);
}

function checkScores(scores: FluencyScores, path: string, issues: string[]): void {
  for (const dimension of DIMENSIONS) {
    if (!isNonNegativeNumber(scores[dimension])) {
      issues.push(`${path}.${dimension} 必须是有限的非负数`);
    }
  }
}

function checkReview(review: ReviewSchedule, path: string, issues: string[]): void {
  if (!isNonNegativeNumber(review.intervalDays)) issues.push(`${path}.intervalDays 必须是非负数`);
  if (!isNonNegativeInteger(review.successfulReviewStreak)) {
    issues.push(`${path}.successfulReviewStreak 必须是非负整数`);
  }
  if (!isNonNegativeInteger(review.lapseCount)) issues.push(`${path}.lapseCount 必须是非负整数`);
  if (typeof review.graduated !== 'boolean') issues.push(`${path}.graduated 必须是布尔值`);
  checkDateTime(review.dueAt, `${path}.dueAt`, issues);
  if (review.lastReviewedAt !== null) {
    checkDateTime(review.lastReviewedAt, `${path}.lastReviewedAt`, issues);
  }
}

function checkVocabularyEstimate(
  estimate: VocabularyEstimate,
  path: string,
  issues: string[],
): void {
  if (!estimate.list.id || !estimate.list.version) issues.push(`${path}.list 必须包含 ID 和版本`);
  checkDateTime(estimate.estimatedAt, `${path}.estimatedAt`, issues);
  checkUnique(estimate.bands.map((band) => band.band), `${path}.bands`, issues);
  estimate.bands.forEach((band, index) => {
    const bandPath = `${path}.bands[${index}]`;
    if (!isVocabularyBand(band.band)) issues.push(`${bandPath}.band 不是有效词频段`);
    if (!isNonNegativeInteger(band.wordFamilyCount) || band.wordFamilyCount === 0) {
      issues.push(`${bandPath}.wordFamilyCount 必须是正整数`);
    }
    if (!isNonNegativeInteger(band.sampleCount)) issues.push(`${bandPath}.sampleCount 必须是非负整数`);
    if (!isNonNegativeInteger(band.knownCount)) issues.push(`${bandPath}.knownCount 必须是非负整数`);
    if (band.knownCount > band.sampleCount || band.sampleCount > band.wordFamilyCount) {
      issues.push(`${bandPath} 必须满足 knownCount <= sampleCount <= wordFamilyCount`);
    }
    if (!isProbability(band.knownProbability)) issues.push(`${bandPath}.knownProbability 必须在 0～1 之间`);
    if (band.interval !== null) {
      if (!isProbability(band.interval.lower) || !isProbability(band.interval.upper)
        || band.interval.lower > band.interval.upper) {
        issues.push(`${bandPath}.interval 必须满足 0 <= lower <= upper <= 1`);
      }
      if (!isProbability(band.interval.level) || band.interval.level === 0 || band.interval.level === 1) {
        issues.push(`${bandPath}.interval.level 必须在 0～1 之间且不含端点`);
      }
    }
  });
}

function checkOptionIds(options: Array<{ id: string }>, path: string, issues: string[]): void {
  checkUnique(options.map((option) => option.id), path, issues);
}

function checkTask(task: LearningTask, state: LearningState, path: string, issues: string[]): void {
  const learner = state.learners.find((item) => item.id === task.learnerId);
  const goal = state.goals.find((item) => item.id === task.goalId);
  if (!learner) issues.push(`${path}.learnerId 引用了不存在的学习者`);
  if (!goal) {
    issues.push(`${path}.goalId 引用了不存在的目标`);
  } else if (goal.learnerId !== task.learnerId) {
    issues.push(`${path} 的任务学习者与目标所有者不一致`);
  }
  if (!state.knowledgePoints.some((item) => item.id === task.content.wordId)) {
    issues.push(`${path}.content.wordId 引用了不存在的知识点`);
  }
  const goalKnowledgePoint = state.goalKnowledgePoints.find((item) => item.goalId === task.goalId
    && item.knowledgePointId === task.content.wordId);
  if (!goalKnowledgePoint) {
    issues.push(`${path}.content.wordId 不是该目标的候选知识点`);
  } else if (goalKnowledgePoint.selection !== 'included') {
    const selectionUpdatedAt = Date.parse(goalKnowledgePoint.selectionUpdatedAt);
    const issuedAt = Date.parse(task.issuedAt);
    if (Number.isFinite(selectionUpdatedAt) && Number.isFinite(issuedAt)
      && issuedAt >= selectionUpdatedAt) {
      issues.push(`${path}.content.wordId 在选择未纳入学习后不能下发新任务`);
    }
  }
  checkDateTime(task.issuedAt, `${path}.issuedAt`, issues);
  if (task.completedAt !== null) checkDateTime(task.completedAt, `${path}.completedAt`, issues);

  const generated = task.content;
  if (generated.task === 'RETRIEVE' && generated.content.stage === 'choice') {
    const content = generated.content;
    checkOptionIds(content.options, `${path}.content.content.options`, issues);
    if (!content.options.some((option) => option.id === content.answerOptionId)) {
      issues.push(`${path}.content.content.answerOptionId 不在选项中`);
    }
  }
  if (generated.task === 'FLUENCY' && generated.content.axis === 'R') {
    const content = generated.content;
    if (!isNonNegativeInteger(content.targetOccurrences)) {
      issues.push(`${path}.content.content.targetOccurrences 必须是非负整数`);
    }
    checkUnique(content.questions.map((question) => question.id), `${path}.content.content.questions`, issues);
    content.questions.forEach((question, index) => {
      if (question.kind === 'choice') {
        checkOptionIds(question.options, `${path}.content.content.questions[${index}].options`, issues);
        if (!question.options.some((option) => option.id === question.answerOptionId)) {
          issues.push(`${path}.content.content.questions[${index}].answerOptionId 不在选项中`);
        }
      }
    });
  }
}

function checkAttempt(
  attempt: TaskAttempt,
  task: LearningTask | undefined,
  state: LearningState,
  path: string,
  issues: string[],
): void {
  checkDateTime(attempt.receivedAt, `${path}.receivedAt`, issues);
  if (!isNonNegativeNumber(attempt.validity.elapsedMs)) {
    issues.push(`${path}.validity.elapsedMs 必须是非负数`);
  }
  if ((attempt.status === 'invalid' || attempt.status === 'unavailable') && !attempt.statusReason.trim()) {
    issues.push(`${path}.statusReason 不能为空`);
  }
  if (!task) {
    issues.push(`${path}.taskId 引用了不存在的任务`);
    return;
  }
  if (attempt.learnerId !== task.learnerId) issues.push(`${path}.learnerId 与任务所有者不一致`);
  if (attempt.status === 'settled' && task.status !== 'completed') {
    issues.push(`${path} 已结算时任务必须为 completed`);
  }
  if (attempt.status === 'settled' && attempt.judgement.taskId !== task.id) {
    issues.push(`${path}.judgement.taskId 与作答任务不一致`);
  }
  if (attempt.status === 'settled' && attempt.validity.interrupted) {
    issues.push(`${path} 中断的作答不能结算`);
  }

  const submission = attempt.submission;
  const generated = task.content;
  if (submission.task !== generated.task) {
    issues.push(`${path}.submission.task 与任务类型不一致`);
    return;
  }
  if (generated.task === 'RETRIEVE' && submission.task === 'RETRIEVE') {
    const content = generated.content;
    if (submission.stage !== content.stage) {
      issues.push(`${path}.submission.stage 与任务阶段不一致`);
    } else if (submission.stage === 'choice' && content.stage === 'choice'
      && !content.options.some((option) => option.id === submission.selectedOptionId)) {
      issues.push(`${path}.submission.selectedOptionId 不在选项中`);
    }
  }
  if (generated.task === 'FLUENCY' && submission.task === 'FLUENCY') {
    const content = generated.content;
    if (submission.axis !== content.axis) {
      issues.push(`${path}.submission.axis 与任务维度不一致`);
    } else if (content.axis === 'R' && submission.axis === 'R') {
      if (!isNonNegativeNumber(submission.readingElapsedMs)) {
        issues.push(`${path}.submission.readingElapsedMs 必须是非负数`);
      }
      checkUnique(submission.answers.map((answer) => answer.questionId), `${path}.submission.answers`, issues);
      const questionIds = new Set(content.questions.map((question) => question.id));
      const answerIds = new Set(submission.answers.map((answer) => answer.questionId));
      if (questionIds.size !== answerIds.size || [...questionIds].some((id) => !answerIds.has(id))) {
        issues.push(`${path}.submission.answers 必须覆盖全部阅读问题且不能包含额外问题`);
      }
      submission.answers.forEach((answer, index) => {
        const question = content.questions.find((item) => item.id === answer.questionId);
        if (!question) return;
        if (question.kind !== answer.kind) {
          issues.push(`${path}.submission.answers[${index}].kind 与问题类型不一致`);
        } else if (question.kind === 'choice' && answer.kind === 'choice'
          && !question.options.some((option) => option.id === answer.selectedOptionId)) {
          issues.push(`${path}.submission.answers[${index}].selectedOptionId 不在选项中`);
        }
      });
    }
  }

  if (attempt.status !== 'settled') return;
  const allowedDimensions: FluencyDimension[] = generated.task === 'ENCODE'
    ? DIMENSIONS
    : [generated.content.axis];
  const judgedDimensions = Object.keys(attempt.judgement.dimensions) as FluencyDimension[];
  if (judgedDimensions.length === 0) issues.push(`${path}.judgement.dimensions 不能为空`);
  for (const dimension of judgedDimensions) {
    if (!allowedDimensions.includes(dimension)) issues.push(`${path}.judgement.dimensions.${dimension} 不属于任务考察维度`);
    const judgement = attempt.judgement.dimensions[dimension];
    if (judgement && !isNonNegativeNumber(judgement.score)) {
      issues.push(`${path}.judgement.dimensions.${dimension}.score 必须是非负数`);
    }
  }
  checkDateTime(attempt.judgement.judgedAt, `${path}.judgement.judgedAt`, issues);
  checkDateTime(attempt.settlement.settledAt, `${path}.settlement.settledAt`, issues);
  checkVocabularyEstimate(attempt.settlement.vocabularyBefore, `${path}.settlement.vocabularyBefore`, issues);
  checkVocabularyEstimate(attempt.settlement.vocabularyAfter, `${path}.settlement.vocabularyAfter`, issues);
  for (const [index, change] of attempt.settlement.fluencyChanges.entries()) {
    if (!state.learnerKnowledgePoints.some((item) => item.learnerId === attempt.learnerId
      && item.knowledgePointId === change.knowledgePointId)) {
      issues.push(`${path}.settlement.fluencyChanges[${index}] 引用了不存在的学习者知识点`);
    }
    if (!isNonNegativeNumber(change.before) || !isNonNegativeNumber(change.after)) {
      issues.push(`${path}.settlement.fluencyChanges[${index}] 的分数必须是非负数`);
    }
  }
  for (const [index, change] of attempt.settlement.reviewChanges.entries()) {
    if (!state.learnerKnowledgePoints.some((item) => item.learnerId === attempt.learnerId
      && item.knowledgePointId === change.knowledgePointId)) {
      issues.push(`${path}.settlement.reviewChanges[${index}] 引用了不存在的学习者知识点`);
    }
    checkReview(change.before, `${path}.settlement.reviewChanges[${index}].before`, issues);
    checkReview(change.after, `${path}.settlement.reviewChanges[${index}].after`, issues);
  }
}

export function validateLearningState(state: LearningState): string[] {
  const issues: string[] = [];

  checkUnique(state.learners.map((item) => item.id), 'learners.id', issues);
  checkUnique(state.vocabularyAssessments.map((item) => item.id), 'vocabularyAssessments.id', issues);
  checkUnique(state.vocabularyAssessmentTasks.map((item) => item.id), 'vocabularyAssessmentTasks.id', issues);
  checkUnique(state.vocabularyAssessmentAttempts.map((item) => item.id), 'vocabularyAssessmentAttempts.id', issues);
  checkUnique(state.materials.map((item) => item.id), 'materials.id', issues);
  checkUnique(state.materialAnalyses.map((item) => item.id), 'materialAnalyses.id', issues);
  checkUnique(state.goals.map((item) => item.id), 'goals.id', issues);
  checkUnique(state.knowledgePoints.map((item) => item.id), 'knowledgePoints.id', issues);
  checkUnique(state.studyPlans.map((item) => item.id), 'studyPlans.id', issues);
  checkUnique(state.tasks.map((item) => item.id), 'tasks.id', issues);
  checkUnique(state.attempts.map((item) => item.id), 'attempts.id', issues);
  checkUnique(state.attempts.map((item) => item.taskId), 'attempts.taskId', issues);
  checkUnique(state.vocabularyAssessmentAttempts.map((item) => `${item.assessmentId}:${item.taskId}`),
    'vocabularyAssessmentAttempts.(assessmentId,taskId)', issues);
  checkUnique(state.goalMaterials.map((item) => `${item.goalId}:${item.materialId}`),
    'goalMaterials.(goalId,materialId)', issues);
  checkUnique(state.goalKnowledgePoints.map((item) => `${item.goalId}:${item.knowledgePointId}`),
    'goalKnowledgePoints.(goalId,knowledgePointId)', issues);
  checkUnique(state.goalKnowledgePointSources.map((item) => `${item.goalId}:${item.knowledgePointId}:${item.sourceAnalysisId}`),
    'goalKnowledgePointSources.(goalId,knowledgePointId,sourceAnalysisId)', issues);
  checkUnique(state.learnerKnowledgePoints.map((item) => `${item.learnerId}:${item.knowledgePointId}`),
    'learnerKnowledgePoints.(learnerId,knowledgePointId)', issues);
  checkUnique(state.studyPlans.map((item) => `${item.learnerId}:${item.date}`),
    'studyPlans.(learnerId,date)', issues);
  checkUnique(state.knowledgePointVocabularyClassifications.map((item) =>
    `${item.knowledgePointId}:${item.list.id}:${item.list.version}`),
  'knowledgePointVocabularyClassifications.(knowledgePointId,list)', issues);

  state.learners.forEach((learner, index) => {
    const path = `learners[${index}]`;
    if (!isNonNegativeInteger(learner.dailyTaskCapacity)) issues.push(`${path}.dailyTaskCapacity 必须是非负整数`);
    if (!isTimezone(learner.timezone)) issues.push(`${path}.timezone 不是有效的 IANA 时区`);
    checkDateTime(learner.createdAt, `${path}.createdAt`, issues);
    checkDateTime(learner.updatedAt, `${path}.updatedAt`, issues);
    if (learner.currentVocabulary) {
      checkVocabularyEstimate(learner.currentVocabulary, `${path}.currentVocabulary`, issues);
    }
  });

  state.vocabularyAssessmentTasks.forEach((task, index) => {
    const path = `vocabularyAssessmentTasks[${index}]`;
    if (!isVocabularyBand(task.band)) issues.push(`${path}.band 不是有效词频段`);
  });

  state.vocabularyAssessments.forEach((assessment, index) => {
    const path = `vocabularyAssessments[${index}]`;
    if (!state.learners.some((learner) => learner.id === assessment.learnerId)) {
      issues.push(`${path}.learnerId 引用了不存在的学习者`);
    }
    checkUnique(assessment.taskIds, `${path}.taskIds`, issues);
    for (const taskId of assessment.taskIds) {
      if (!state.vocabularyAssessmentTasks.some((task) => task.id === taskId)) {
        issues.push(`${path}.taskIds 引用了不存在的任务 ${taskId}`);
      }
    }
    checkDateTime(assessment.createdAt, `${path}.createdAt`, issues);
    if (assessment.status === 'completed') {
      checkDateTime(assessment.completedAt, `${path}.completedAt`, issues);
      checkVocabularyEstimate(assessment.result, `${path}.result`, issues);
    }
  });

  state.vocabularyAssessmentAttempts.forEach((attempt, index) => {
    const path = `vocabularyAssessmentAttempts[${index}]`;
    const assessment = state.vocabularyAssessments.find((item) => item.id === attempt.assessmentId);
    const task = state.vocabularyAssessmentTasks.find((item) => item.id === attempt.taskId);
    if (!assessment) {
      issues.push(`${path}.assessmentId 引用了不存在的测评`);
    } else if (!assessment.taskIds.includes(attempt.taskId)) {
      issues.push(`${path}.taskId 不属于该测评`);
    }
    if (!task) issues.push(`${path}.taskId 引用了不存在的评级任务`);
    if (typeof attempt.known !== 'boolean') issues.push(`${path}.known 必须是布尔值`);
    checkDateTime(attempt.answeredAt, `${path}.answeredAt`, issues);
  });

  state.materials.forEach((material, index) => {
    if (!state.learners.some((learner) => learner.id === material.learnerId)) {
      issues.push(`materials[${index}].learnerId 引用了不存在的学习者`);
    }
    checkDateTime(material.createdAt, `materials[${index}].createdAt`, issues);
  });

  state.materialAnalyses.forEach((analysis, index) => {
    if (!state.materials.some((material) => material.id === analysis.materialId)) {
      issues.push(`materialAnalyses[${index}].materialId 引用了不存在的材料`);
    }
    checkDateTime(analysis.createdAt, `materialAnalyses[${index}].createdAt`, issues);
    if (analysis.completedAt !== null) {
      checkDateTime(analysis.completedAt, `materialAnalyses[${index}].completedAt`, issues);
    }
  });

  state.goals.forEach((goal, index) => {
    if (!state.learners.some((learner) => learner.id === goal.learnerId)) {
      issues.push(`goals[${index}].learnerId 引用了不存在的学习者`);
    }
    checkScores(goal.targetFluency, `goals[${index}].targetFluency`, issues);
    checkDateTime(goal.createdAt, `goals[${index}].createdAt`, issues);
    checkDateTime(goal.updatedAt, `goals[${index}].updatedAt`, issues);
  });

  state.goalMaterials.forEach((link, index) => {
    const path = `goalMaterials[${index}]`;
    const goal = state.goals.find((item) => item.id === link.goalId);
    const material = state.materials.find((item) => item.id === link.materialId);
    if (!goal) issues.push(`${path}.goalId 引用了不存在的目标`);
    if (!material) {
      issues.push(`${path}.materialId 引用了不存在的材料`);
    } else if (goal && material.learnerId !== goal.learnerId) {
      issues.push(`${path} 不能关联其他学习者的材料`);
    }
    if (link.analysisId !== null) {
      const analysis = state.materialAnalyses.find((item) => item.id === link.analysisId);
      if (!analysis) {
        issues.push(`${path}.analysisId 引用了不存在的分析`);
      } else {
        if (analysis.materialId !== link.materialId) issues.push(`${path}.analysisId 不属于关联材料`);
        if (analysis.status !== 'analyzed') issues.push(`${path}.analysisId 必须指向已完成分析`);
      }
    }
    checkDateTime(link.addedAt, `${path}.addedAt`, issues);
  });

  state.knowledgePointVocabularyClassifications.forEach((classification, index) => {
    const path = `knowledgePointVocabularyClassifications[${index}]`;
    const knowledgePoint = state.knowledgePoints.find((item) => item.id === classification.knowledgePointId);
    if (!knowledgePoint) {
      issues.push(`${path}.knowledgePointId 引用了不存在的知识点`);
    } else if (knowledgePoint.kind === 'grammar' || knowledgePoint.kind === 'other') {
      issues.push(`${path} 只能分类词汇知识点`);
    }
    if (!classification.list.id || !classification.list.version) issues.push(`${path}.list 必须包含 ID 和版本`);
    if (!isVocabularyBand(classification.band)) issues.push(`${path}.band 不是有效词频段`);
  });

  state.goalKnowledgePoints.forEach((link, index) => {
    const path = `goalKnowledgePoints[${index}]`;
    if (!state.goals.some((goal) => goal.id === link.goalId)) issues.push(`${path}.goalId 引用了不存在的目标`);
    if (!state.knowledgePoints.some((item) => item.id === link.knowledgePointId)) {
      issues.push(`${path}.knowledgePointId 引用了不存在的知识点`);
    }
    checkDateTime(link.addedAt, `${path}.addedAt`, issues);
    checkDateTime(link.selectionUpdatedAt, `${path}.selectionUpdatedAt`, issues);
    if (Date.parse(link.selectionUpdatedAt) < Date.parse(link.addedAt)) {
      issues.push(`${path}.selectionUpdatedAt 不能早于 addedAt`);
    }
  });

  state.goalKnowledgePointSources.forEach((link, index) => {
    const path = `goalKnowledgePointSources[${index}]`;
    if (!state.goalKnowledgePoints.some((item) => item.goalId === link.goalId
      && item.knowledgePointId === link.knowledgePointId)) {
      issues.push(`${path} 必须先建立目标候选知识点`);
    }
    const analysis = state.materialAnalyses.find((item) => item.id === link.sourceAnalysisId);
    if (!analysis) {
      issues.push(`${path}.sourceAnalysisId 引用了不存在的分析`);
    } else {
      if (analysis.status !== 'analyzed') {
        issues.push(`${path}.sourceAnalysisId 必须指向已完成分析`);
      } else if (!analysis.items.some((item) => item.knowledgePoint.id === link.knowledgePointId)) {
        issues.push(`${path}.knowledgePointId 不在来源分析中`);
      }
      if (!state.goalMaterials.some((item) => item.goalId === link.goalId
        && item.materialId === analysis.materialId && item.analysisId === analysis.id)) {
        issues.push(`${path} 的来源分析没有固定到对应目标材料`);
      }
    }
    checkDateTime(link.addedAt, `${path}.addedAt`, issues);
  });

  state.learnerKnowledgePoints.forEach((learning, index) => {
    const path = `learnerKnowledgePoints[${index}]`;
    if (!state.learners.some((learner) => learner.id === learning.learnerId)) {
      issues.push(`${path}.learnerId 引用了不存在的学习者`);
    }
    if (!state.knowledgePoints.some((item) => item.id === learning.knowledgePointId)) {
      issues.push(`${path}.knowledgePointId 引用了不存在的知识点`);
    }
    if (!isNonNegativeInteger(learning.version)) issues.push(`${path}.version 必须是非负整数`);
    checkScores(learning.initialFluency, `${path}.initialFluency`, issues);
    checkVocabularyEstimate(learning.initialization.sourceVocabulary, `${path}.initialization.sourceVocabulary`, issues);
    if (!learning.initialization.policyVersion.trim()) issues.push(`${path}.initialization.policyVersion 不能为空`);
    const classification = learning.initialization.classification;
    if (classification) {
      if (classification.knowledgePointId !== learning.knowledgePointId) {
        issues.push(`${path}.initialization.classification 与知识点不一致`);
      }
      if (classification.list.id !== learning.initialization.sourceVocabulary.list.id
        || classification.list.version !== learning.initialization.sourceVocabulary.list.version) {
        issues.push(`${path}.initialization.classification 与词汇估计的词表版本不一致`);
      }
      if (!state.knowledgePointVocabularyClassifications.some((item) =>
        item.knowledgePointId === classification.knowledgePointId
        && item.list.id === classification.list.id
        && item.list.version === classification.list.version
        && item.band === classification.band)) {
        issues.push(`${path}.initialization.classification 不在词频分类记录中`);
      }
    }
    for (const dimension of DIMENSIONS) {
      if (!isNonNegativeNumber(learning.dimensions[dimension].fluency)) {
        issues.push(`${path}.dimensions.${dimension}.fluency 必须是非负数`);
      }
      checkReview(learning.dimensions[dimension].review, `${path}.dimensions.${dimension}.review`, issues);
    }
    checkDateTime(learning.createdAt, `${path}.createdAt`, issues);
    checkDateTime(learning.updatedAt, `${path}.updatedAt`, issues);
  });

  state.tasks.forEach((task, index) => checkTask(task, state, `tasks[${index}]`, issues));

  state.studyPlans.forEach((plan, index) => {
    const path = `studyPlans[${index}]`;
    if (!state.learners.some((learner) => learner.id === plan.learnerId)) {
      issues.push(`${path}.learnerId 引用了不存在的学习者`);
    }
    if (!isLocalDate(plan.date)) issues.push(`${path}.date 不是有效的本地日期`);
    if (!isNonNegativeInteger(plan.taskCapacity)) issues.push(`${path}.taskCapacity 必须是非负整数`);
    if (plan.taskIds.length > plan.taskCapacity) issues.push(`${path}.taskIds 超出任务容量`);
    checkUnique(plan.taskIds, `${path}.taskIds`, issues);
    for (const taskId of plan.taskIds) {
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) {
        issues.push(`${path}.taskIds 引用了不存在的任务 ${taskId}`);
      } else if (task.learnerId !== plan.learnerId) {
        issues.push(`${path}.taskIds 包含其他学习者的任务 ${taskId}`);
      }
    }
    checkDateTime(plan.createdAt, `${path}.createdAt`, issues);
    checkDateTime(plan.updatedAt, `${path}.updatedAt`, issues);
  });

  state.attempts.forEach((attempt, index) => {
    checkAttempt(attempt, state.tasks.find((task) => task.id === attempt.taskId), state, `attempts[${index}]`, issues);
  });

  state.tasks.forEach((task, index) => {
    if (task.status === 'completed' && !state.attempts.some((attempt) =>
      attempt.taskId === task.id && attempt.status === 'settled')) {
      issues.push(`tasks[${index}] 已完成但没有已结算作答`);
    }
  });

  return issues;
}

export function assertValidLearningState(state: LearningState): void {
  const issues = validateLearningState(state);
  if (issues.length > 0) throw new LearningStateInvariantError(issues);
}
