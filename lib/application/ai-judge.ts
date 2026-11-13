import type { ReadingFreeQuestionVerdict } from '../domain/functions';
import type { LearningTask, TaskSubmission } from '../domain/model';
import { aiLogger, logger as defaultLogger } from './logger';
import type { AppLogger } from './logger';

/**
 * AI 对一次作答中需要语义判断部分给出的评判结果。
 * 选择题等答案完全确定的部分不在此返回，由应用层按规则判定后合并。
 */
export interface SemanticJudgementResult {
  taskId: string;
  /** RETRIEVE cued/free：答案是否表达了可接受的词义或表达。 */
  retrieveAccepted?: boolean;
  /** 阅读自由问题：按问题 ID 的语义正误。 */
  readingFreeQuestions?: ReadingFreeQuestionVerdict[];
  /** P 场景表达：目标表达与整体表达是否合格。 */
  production?: { targetPassed: boolean; overallPassed: boolean };
  /** 返回给学习者的反馈。 */
  feedback: string | null;
}

export interface TaskAIJudge {
  judge(input: { task: LearningTask; submission: TaskSubmission }): Promise<SemanticJudgementResult>;
}

export function parseSemanticJudgement(content: string): SemanticJudgementResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('AI judge returned invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI judge result must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.taskId !== 'string' || !record.taskId) {
    throw new Error('AI judge result requires a non-empty taskId');
  }
  const feedback = record.feedback ?? null;
  if (feedback !== null && typeof feedback !== 'string') {
    throw new Error('AI judge feedback must be a string or null');
  }
  const result: SemanticJudgementResult = { taskId: record.taskId, feedback };
  if (record.retrieveAccepted !== undefined) {
    if (typeof record.retrieveAccepted !== 'boolean') {
      throw new Error('AI judge retrieveAccepted must be a boolean');
    }
    result.retrieveAccepted = record.retrieveAccepted;
  }
  if (record.readingFreeQuestions !== undefined) {
    if (!Array.isArray(record.readingFreeQuestions)) {
      throw new Error('AI judge readingFreeQuestions must be an array');
    }
    result.readingFreeQuestions = record.readingFreeQuestions.map((item, index) => {
      if (!item || typeof item !== 'object'
        || typeof (item as { questionId?: unknown }).questionId !== 'string'
        || typeof (item as { correct?: unknown }).correct !== 'boolean') {
        throw new Error(`AI judge readingFreeQuestions[${index}] must contain questionId and correct`);
      }
      return {
        questionId: (item as { questionId: string }).questionId,
        correct: (item as { correct: boolean }).correct,
      };
    });
  }
  if (record.production !== undefined) {
    if (!record.production || typeof record.production !== 'object'
      || typeof (record.production as { targetPassed?: unknown }).targetPassed !== 'boolean'
      || typeof (record.production as { overallPassed?: unknown }).overallPassed !== 'boolean') {
      throw new Error('AI judge production must contain targetPassed and overallPassed booleans');
    }
    result.production = {
      targetPassed: (record.production as { targetPassed: boolean }).targetPassed,
      overallPassed: (record.production as { overallPassed: boolean }).overallPassed,
    };
  }
  return result;
}

function buildJudgingPrompt(task: LearningTask, submission: TaskSubmission): string {
  const content = task.content;
  const lines = [`Task id: ${task.id}`];
  let schema: string;
  if (content.task === 'RETRIEVE') {
    const retrieve = content.content;
    if (retrieve.stage === 'choice') {
      throw new Error('Choice retrieve tasks are graded by rule');
    }
    lines.push(
      `Task type: RETRIEVE (${retrieve.axis} dimension, ${retrieve.stage} stage)`,
      `Prompt: ${retrieve.prompt}`,
    );
    if (retrieve.stage === 'cued') lines.push(`Cue shown to the learner: ${retrieve.cue}`);
    lines.push(
      `Acceptable answers: ${retrieve.answerKey.acceptedAnswers.join(' | ')}`,
      `Answer explanation: ${retrieve.answerKey.explanation}`,
      `Learner answer: ${submission.task === 'RETRIEVE' && submission.stage !== 'choice' ? submission.answer : ''}`,
      '',
      'Judge whether the learner answer expresses an acceptable meaning for this prompt.',
    );
    schema = '{ "taskId": "<task id>", "retrieveAccepted": <boolean>, "feedback": <string or null> }';
  } else if (content.task === 'FLUENCY') {
    const fluency = content.content;
    if (fluency.axis === 'R') {
      lines.push(
        'Task type: FLUENCY reading (R dimension)',
        `Passage: ${fluency.passage}`,
        'Questions:',
        ...fluency.questions.map((question) => [
          `- id: ${question.id}`,
          `  role: ${question.role}`,
          `  kind: ${question.kind}`,
          `  prompt: ${question.prompt}`,
          ...(question.kind === 'free'
            ? [`  reference answer: ${question.answer}`, `  evidence: ${question.evidence}`]
            : []),
        ].join('\n')),
        'Learner answers:',
        ...(submission.task === 'FLUENCY' && submission.axis === 'R'
          ? submission.answers.map((answer) => `- ${answer.questionId}: ${
            answer.kind === 'choice' ? `selected option ${answer.selectedOptionId}` : answer.answer}`)
          : []),
        '',
        'Judge ONLY the free questions for semantic correctness against the reference answers.',
        'Do not return verdicts for choice questions; they are graded by rule.',
      );
      schema = '{ "taskId": "<task id>", "readingFreeQuestions": [{ "questionId": "<id>", "correct": <boolean> }], "feedback": <string or null> }';
    } else {
      lines.push(
        'Task type: FLUENCY production (P dimension)',
        `Scenario (Chinese): ${fluency.scenario}`,
        `Response instruction (Chinese): ${fluency.responseInstruction}`,
        `Target expression: ${fluency.gradingRequirements.targetExpression}`,
        `Target use criteria: ${fluency.gradingRequirements.targetUseCriteria.join(' | ')}`,
        `Overall expression criteria: ${fluency.gradingRequirements.overallExpressionCriteria.join(' | ')}`,
        `Learner response: ${submission.task === 'FLUENCY' && submission.axis === 'P' ? submission.response : ''}`,
        '',
        'Judge whether the target expression is used naturally and correctly (targetPassed),',
        'and whether the overall response satisfies the overall expression criteria (overallPassed).',
      );
      schema = '{ "taskId": "<task id>", "production": { "targetPassed": <boolean>, "overallPassed": <boolean> }, "feedback": <string or null> }';
    }
  } else {
    throw new Error('ENCODE tasks are graded by rule');
  }
  lines.push(
    '',
    `Return only JSON matching this schema: ${schema}`,
    'Put a short learning-oriented explanation in feedback, or null.',
  );
  return lines.join('\n');
}

export interface HttpTaskAIJudgeOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  fetchImpl?: typeof fetch;
  logger?: AppLogger;
  /** AI 链路 logger：完整记录请求 prompt 与原始响应；缺省统一写入 logs/ai.log。 */
  auditLogger?: AppLogger;
}

/** OpenAI 兼容聊天接口的 AI 评判实现，可用于 OpenAI、DeepSeek、Kimi 等供应商。 */
export function createHttpTaskAIJudge(options: HttpTaskAIJudgeOptions): TaskAIJudge {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseURL = options.baseURL.replace(/\/+$/, '');
  const logger = options.logger ?? defaultLogger;
  const audit = options.auditLogger ?? aiLogger;
  return {
    async judge({ task, submission }) {
      const prompt = buildJudgingPrompt(task, submission);
      logger.debug({ taskId: task.id, model: options.model }, '任务评判：AI 请求');
      logger.debug({ taskId: task.id, prompt: prompt.slice(0, 10000) }, '任务评判：AI 请求 prompt');
      audit.info(
        { call: 'task-judging', phase: 'request', model: options.model, taskId: task.id, prompt },
        'AI 交互：任务评判请求',
      );
      let content: string;
      try {
        const response = await fetchImpl(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: options.model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: 'You grade English learning tasks strictly and fairly. Reply with JSON only.',
              },
              { role: 'user', content: prompt },
            ],
          }),
        });
        if (!response.ok) throw new Error(`AI judge request failed with status ${response.status}`);
        const payload: unknown = await response.json();
        const text = (payload as { choices?: Array<{ message?: { content?: unknown } }> })
          ?.choices?.[0]?.message?.content;
        if (typeof text !== 'string') throw new Error('AI judge response is missing message content');
        content = text;
      } catch (error) {
        audit.error(
          {
            call: 'task-judging',
            phase: 'request-error',
            model: options.model,
            taskId: task.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'AI 交互：任务评判失败',
        );
        throw error;
      }
      logger.debug({ taskId: task.id, raw: content.slice(0, 8000) }, '任务评判：AI 原始返回');
      audit.info(
        { call: 'task-judging', phase: 'response', model: options.model, taskId: task.id, raw: content },
        'AI 交互：任务评判响应',
      );
      return parseSemanticJudgement(content);
    },
  };
}

export function createTaskAIJudgeFromEnv(
  env: Record<string, string | undefined> = process.env,
  appLogger?: AppLogger,
  auditLogger?: AppLogger,
): TaskAIJudge {
  return createHttpTaskAIJudge({
    apiKey: env.LLM_API_KEY ?? '',
    baseURL: env.LLM_BASE_URL ?? 'https://api.deepseek.com',
    model: env.LLM_MODEL ?? 'deepseek-chat',
    logger: appLogger,
    auditLogger: auditLogger ?? aiLogger,
  });
}
