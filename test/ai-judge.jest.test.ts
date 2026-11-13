/// <reference types="jest" />

import { createHttpTaskAIJudge, parseSemanticJudgement } from '../lib/application/ai-judge';
import type { AppLogger } from '../lib/application/logger';
import type * as Model from '../lib/domain/model';
import { silentLogger } from './helpers/silent-logger';

const cuedTask: Model.LearningTask = {
  id: 'task-cued',
  learnerId: 'learner-1',
  goalId: 'goal-1',
  issuedAt: '2026-11-12T00:30:00.000Z',
  status: 'issued',
  completedAt: null,
  content: {
    schemaVersion: '1',
    task: 'RETRIEVE',
    wordId: 'kp:run',
    content: {
      axis: 'R',
      stage: 'cued',
      prompt: 'Explain the meaning of run.',
      cue: 't',
      answerKey: { acceptedAnswers: ['to move quickly'], explanation: 'run: to move quickly' },
    },
  },
};

const cuedSubmission: Model.TaskSubmission = { task: 'RETRIEVE', stage: 'cued', answer: 'to move quickly' };

function chatCompletion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function judgeOptions(fetchImpl: typeof fetch, auditLogger: AppLogger) {
  return {
    apiKey: 'test-key',
    baseURL: 'https://llm.example.test',
    model: 'test-model',
    fetchImpl,
    logger: silentLogger,
    auditLogger,
  };
}

/** 捕获 AI 交互审计条目的测试 logger。 */
function auditCapture(): { logger: AppLogger; entries: Array<{ obj: Record<string, unknown>; msg: string }> } {
  const entries: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const record = (obj: Record<string, unknown>, msg: string) => entries.push({ obj, msg });
  return {
    entries,
    logger: {
      debug: record,
      info: record,
      warn: record,
      error: record,
    },
  };
}

describe('parseSemanticJudgement', () => {
  test('解析合法 JSON 并保留全部语义字段', () => {
    const result = parseSemanticJudgement(JSON.stringify({
      taskId: 'task-1',
      retrieveAccepted: true,
      feedback: 'ok',
    }));
    expect(result).toEqual({ taskId: 'task-1', retrieveAccepted: true, feedback: 'ok' });
  });

  test('非法 JSON、缺失 taskId 与类型错误都抛出错误', () => {
    expect(() => parseSemanticJudgement('not json')).toThrow('invalid JSON');
    expect(() => parseSemanticJudgement('{"feedback":"ok"}')).toThrow('taskId');
    expect(() => parseSemanticJudgement('{"taskId":"t","retrieveAccepted":"yes"}')).toThrow('boolean');
    expect(() => parseSemanticJudgement('{"taskId":"t","production":{"targetPassed":true}}')).toThrow('overallPassed');
  });
});

describe('createHttpTaskAIJudge 的 AI 交互审计', () => {
  test('请求与原始响应完整写入审计通道', async () => {
    const raw = JSON.stringify({ taskId: 'task-cued', retrieveAccepted: true, feedback: '释义正确' });
    const fetchImpl = jest.fn(async () => chatCompletion(raw)) as unknown as typeof fetch;
    const audit = auditCapture();
    const judge = createHttpTaskAIJudge(judgeOptions(fetchImpl, audit.logger));

    const result = await judge.judge({ task: cuedTask, submission: cuedSubmission });

    expect(result).toEqual({ taskId: 'task-cued', retrieveAccepted: true, feedback: '释义正确' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const request = audit.entries.find((entry) => entry.obj.phase === 'request');
    expect(request).toBeDefined();
    expect(request!.obj.call).toBe('task-judging');
    expect(request!.obj.model).toBe('test-model');
    expect(request!.obj.taskId).toBe('task-cued');
    expect(String(request!.obj.prompt)).toContain('Task id: task-cued');
    expect(String(request!.obj.prompt)).toContain('to move quickly');
    const response = audit.entries.find((entry) => entry.obj.phase === 'response');
    expect(response).toBeDefined();
    expect(response!.obj.raw).toBe(raw);
  });

  test('供应商返回非 2xx 时写入 request-error 审计并抛出', async () => {
    const fetchImpl = jest.fn(async () => new Response('server error', { status: 500 })) as unknown as typeof fetch;
    const audit = auditCapture();
    const judge = createHttpTaskAIJudge(judgeOptions(fetchImpl, audit.logger));

    await expect(judge.judge({ task: cuedTask, submission: cuedSubmission })).rejects.toThrow('500');

    const failure = audit.entries.find((entry) => entry.obj.phase === 'request-error');
    expect(failure).toBeDefined();
    expect(failure!.obj.taskId).toBe('task-cued');
    expect(String(failure!.obj.error)).toContain('500');
    // 失败时不得记录伪造的响应阶段。
    expect(audit.entries.some((entry) => entry.obj.phase === 'response')).toBe(false);
  });

  test('响应缺少 message content 时写入 request-error 审计并抛出', async () => {
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({ choices: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
    const audit = auditCapture();
    const judge = createHttpTaskAIJudge(judgeOptions(fetchImpl, audit.logger));

    await expect(judge.judge({ task: cuedTask, submission: cuedSubmission }))
      .rejects.toThrow('missing message content');

    const failure = audit.entries.find((entry) => entry.obj.phase === 'request-error');
    expect(failure).toBeDefined();
    expect(String(failure!.obj.error)).toContain('missing message content');
  });
});
