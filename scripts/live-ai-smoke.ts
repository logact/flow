/**
 * S11 真实 AI 联调烟测：用真实 LLM（默认 DeepSeek）评判并结算学习任务作答。
 *
 * 用法：
 *   export LLM_API_KEY=sk-...            # 必需
 *   export LLM_BASE_URL=...              # 可选，默认 https://api.deepseek.com
 *   export LLM_MODEL=...                 # 可选，默认 deepseek-chat
 *   npm run test:ai-live
 *
 * 日志：业务日志 → logs/app.log，AI 请求/响应 → logs/ai.log。
 */
import vocabularyFixture from '../data/bnc-coca-l6-fixture.json';
import { createTaskAIJudgeFromEnv } from '../lib/application/ai-judge';
import { judgeAndSettleTaskAttempt } from '../lib/application/judge-settle-task-attempt';
import { aiLogger, logger } from '../lib/application/logger';
import { InMemoryLearningStateRepository } from '../lib/application/repository';
import * as Domain from '../lib/domain/functions';
import type * as Model from '../lib/domain/model';

const list = { id: 'bnc-coca-l6', version: '2.0.0' };
const families: Domain.VocabularyAssessmentWordFamily[] = vocabularyFixture.families.map((family) => ({
  ...family,
  band: family.band as Model.VocabularyBand,
}));
const at = {
  created: '2026-11-13T08:00:00.000Z',
  answered: '2026-11-13T08:10:00.000Z',
  planned: '2026-11-13T08:30:00.000Z',
  received: '2026-11-13T08:40:00.000Z',
  judged: '2026-11-13T08:45:00.000Z',
};

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

// 与单测相同的路径：真实走一遍定级与初始化，使作答可以真实结算。
function buildInitializedState(): Model.LearningState {
  const learner = Domain.createLearner({
    id: 'learner-1',
    timezone: 'Asia/Shanghai',
    dailyTaskCapacity: 3,
    now: at.created,
  });
  const samples = Domain.sampleVocabularyForAssessment({
    list,
    families,
    sampleCounts: { '2k': 1 },
    seed: 'ai-smoke',
  });
  const assessmentTasks = Domain.generateVocabularyAssessmentTasks({ samples, taskIds: ['assessment-task-1'] });
  const assessment = Domain.createVocabularyAssessment({
    id: 'assessment-1',
    learnerId: learner.id,
    tasks: assessmentTasks,
    now: at.created,
  });
  const assessmentAttempt = Domain.recordVocabularyAssessmentAttempt({
    attemptId: 'assessment-attempt-1',
    assessment,
    task: assessmentTasks[0],
    previousAttempts: [],
    known: false,
    answeredAt: at.answered,
  });
  const completed = Domain.completeVocabularyAssessment({
    learner,
    assessment,
    tasks: assessmentTasks,
    attempts: [assessmentAttempt],
    list,
    bandWordFamilyCounts: { '2k': 2000 },
    now: at.answered,
  });
  const material = Domain.createMaterial({
    id: 'material-1',
    learnerId: learner.id,
    title: 'Morning run',
    filename: 'morning-run.md',
    format: 'markdown',
    mimeType: 'text/markdown',
    checksum: 'checksum-1',
    storageKey: null,
    extractedText: 'I run every morning.',
    extractionMetadata: { extractor: 'live-ai-smoke' },
    now: at.answered,
  });
  const terms = Domain.extractMaterialTerms(material);
  const analysis = Domain.analyzeMaterial({
    analysisId: 'analysis-1',
    material,
    analyzerVersion: 'live-ai-smoke-v1',
    now: at.answered,
    assignments: terms.map((term) => ({
      lemma: term.lemma,
      senseId: 'placeholder:1',
      partOfSpeech: null,
      definition: `Meaning of ${term.lemma} in the source material`,
      occurrences: term.occurrences,
    })),
  });
  const goal = Domain.createLearningGoal({
    id: 'goal-1',
    learnerId: learner.id,
    title: 'Core vocabulary',
    targetFluency: { R: 100, P: 100 },
    now: at.answered,
  });
  const scope = Domain.addAnalyzedMaterialToGoal({
    goal,
    material,
    analysis,
    existingCandidates: [],
    existingSources: [],
    addedAt: at.answered,
  });
  const knowledgePoint = scope.knowledgePoints.find((item) => item.kind === 'word' && item.lemma === 'run');
  if (!knowledgePoint) throw new Error('run was not analyzed');
  const candidate = Domain.setGoalKnowledgePointSelection(
    scope.candidates.find((item) => item.knowledgePointId === knowledgePoint.id)!,
    { selection: 'included', now: at.answered },
  );
  const classification: Model.KnowledgePointVocabularyClassification = {
    knowledgePointId: knowledgePoint.id,
    list,
    band: '2k',
  };
  const derived = Domain.deriveInitialFluency({
    vocabulary: completed.learner.currentVocabulary!,
    classification,
    policyVersion: 'live-ai-smoke-v1',
  });
  const learning = Domain.initializeLearnerKnowledgePoint({
    learnerId: learner.id,
    knowledgePoint,
    derived,
    now: at.answered,
  });
  return {
    ...emptyState(),
    learners: [completed.learner],
    vocabularyAssessments: [completed.assessment],
    vocabularyAssessmentTasks: assessmentTasks,
    vocabularyAssessmentAttempts: [assessmentAttempt],
    materials: [material],
    materialAnalyses: [analysis],
    goals: [scope.goal],
    goalMaterials: [scope.materialLink],
    knowledgePoints: [knowledgePoint],
    knowledgePointVocabularyClassifications: [classification],
    goalKnowledgePoints: [candidate],
    goalKnowledgePointSources: scope.sources.filter((source) => source.knowledgePointId === knowledgePoint.id),
    learnerKnowledgePoints: [learning],
  };
}

function makeTask(
  state: Model.LearningState,
  specification: Domain.TaskSpecification,
  taskId: string,
): { state: Model.LearningState; task: Model.LearningTask } {
  const generated = Domain.generateLearningTask({
    specification,
    knowledgePoint: state.knowledgePoints[0],
    sourceMaterials: state.materials,
  });
  const task = Domain.createLearningTask({
    id: taskId,
    learnerId: state.learners[0].id,
    specification,
    generated,
    issuedAt: at.planned,
  });
  return { state: { ...state, tasks: [...state.tasks, task] }, task };
}

async function runScenario(
  name: string,
  specification: Domain.TaskSpecification,
  submission: Model.TaskSubmission,
  attemptId: string,
  elapsedMs = 5000,
): Promise<void> {
  const base = buildInitializedState();
  const wordId = base.knowledgePoints[0].id;
  const { state, task } = makeTask(base, specification, `task-${attemptId}`);
  const received = Domain.recordTaskAttempt(state, {
    attemptId,
    taskId: task.id,
    submission,
    validity: { elapsedMs, interrupted: false },
    receivedAt: at.received,
  });
  const repo = new InMemoryLearningStateRepository(received.state);
  const judge = createTaskAIJudgeFromEnv(process.env, logger, aiLogger);
  const started = Date.now();
  const result = await judgeAndSettleTaskAttempt(repo, judge, { attemptId, judgedAt: at.judged, now: at.judged });
  const attempt = repo.load().state.attempts.find((item) => item.id === attemptId);
  console.log(`\n=== ${name} ===`);
  console.log(`  latency: ${Date.now() - started}ms`);
  if (attempt?.judgement) {
    console.log(`  judgedBy: ${attempt.judgement.judgedBy}`);
    console.log(`  judgement dimensions: ${JSON.stringify(attempt.judgement.dimensions)}`);
  }
  console.log(`  settlement: ${result.settlement.fluencyChanges.length} fluency change(s), settledAt ${result.settlement.settledAt}`);
  console.log(`  feedback: ${result.feedback}`);
  console.log(`  fluency: ${JSON.stringify(repo.load().state.learnerKnowledgePoints[0].dimensions)}`);
}

async function main(): Promise<void> {
  if (!process.env.LLM_API_KEY) throw new Error('LLM_API_KEY is required');
  const state = buildInitializedState();
  const knowledgePointId = state.knowledgePoints[0].id;
  const run = (
    name: string,
    specification: Domain.TaskSpecification,
    submission: Model.TaskSubmission,
    attemptId: string,
    elapsedMs = 5000,
  ) => runScenario(name, specification, submission, attemptId, elapsedMs);

  await run(
    'RETRIEVE cued 正确作答',
    { goalId: 'goal-1', wordId: knowledgePointId, task: 'RETRIEVE', axis: 'R', stage: 'cued' },
    { task: 'RETRIEVE', stage: 'cued', answer: 'to move quickly using your legs' },
    'attempt-cued-good',
  );

  await run(
    'RETRIEVE cued 明显错误作答',
    { goalId: 'goal-1', wordId: knowledgePointId, task: 'RETRIEVE', axis: 'R', stage: 'cued' },
    { task: 'RETRIEVE', stage: 'cued', answer: 'a kind of fruit juice' },
    'attempt-cued-bad',
  );

  const readingBase = buildInitializedState();
  const readingWordId = readingBase.knowledgePoints[0].id;
  const reading = makeTask(readingBase, {
    goalId: 'goal-1', wordId: readingWordId, task: 'FLUENCY', axis: 'R',
  }, 'task-reading');
  if (reading.task.content.task !== 'FLUENCY' || reading.task.content.content.axis !== 'R') {
    throw new Error('expected reading task');
  }
  const questions = reading.task.content.content.questions;
  await run(
    'FLUENCY R 选择题全对 + 自由题概括正确',
    { goalId: 'goal-1', wordId: readingWordId, task: 'FLUENCY', axis: 'R' },
    {
      task: 'FLUENCY',
      axis: 'R',
      readingElapsedMs: 60000,
      answers: questions.map((question) => question.kind === 'choice'
        ? { questionId: question.id, kind: 'choice' as const, selectedOptionId: question.answerOptionId }
        : { questionId: question.id, kind: 'free' as const, answer: 'The passage is about running every morning.' }),
    },
    'attempt-reading-good',
    60000,
  );

  await run(
    'FLUENCY P 使用目标表达作答',
    { goalId: 'goal-1', wordId: knowledgePointId, task: 'FLUENCY', axis: 'P' },
    { task: 'FLUENCY', axis: 'P', response: 'I run every morning before work.' },
    'attempt-production-good',
  );

  console.log('\n全部场景完成。AI 请求/响应明细见 logs/ai.log');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
