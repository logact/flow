/// <reference types="jest" />

/**
 * S08 生成学习任务的应用用例测试。
 * 使用内存 Repository 与 Fake AI Provider，并注入静默 logger（日志行为见专门的日志用例）：
 * - 验证编排：加载目标知识点与来源材料 → AI 生成 → 解析 → validateGeneratedTask → createLearningTask。
 * - 验证失败路径：AI 请求失败、输出无法解析、输出与规格不匹配时不创建、不保存任务。
 * - 验证边界：本用例不单独持久化任务；服务端任务保留答案材料，公开视图必须剥离。
 * 不验证：AI 供应商真实调用（Live 验证另行进行）、S09 的计划持久化。
 */

import type { AppLogger } from '../lib/application/logger';
import { generateLearningTaskUseCase, MAX_TASK_GENERATION_ATTEMPTS } from '../lib/application/task-generation';
import type { TaskSpecification } from '../lib/domain/functions';
import { inspectGeneratedTask, toLearningTaskView } from '../lib/domain/functions';
import type * as Model from '../lib/domain/model';
import {
  aiOutputs,
  at,
  expectOk,
  goalId,
  inputFor,
  knowledgePoints,
  learnerId,
  learnerVocabulary,
  material,
  runScenario,
  silentLogger,
  setup,
  specifications,
  taskIds,
  type ScenarioKey,
} from './helpers/task-generation-fixture';

function expectReadingContent(
  envelope: Model.LearningTask['content'] | Model.LearningTaskView['content'],
): Model.ReadingFluencyTaskContent | Model.LearnerReadingFluencyTaskContent {
  if (envelope.task !== 'FLUENCY' || envelope.content.axis !== 'R') {
    throw new Error('期望 FLUENCY-R 任务内容');
  }
  return envelope.content;
}

type LogEntry = { level: string; msg: string } & Record<string, unknown>;

function captureLogger(entries: LogEntry[]): AppLogger {
  const push = (level: string) => (obj: Record<string, unknown>, msg: string) => {
    entries.push({ level, msg, ...obj });
  };
  return { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

describe('S08 生成学习任务', () => {
  const scenario: Array<{ key: ScenarioKey; name: string }> = [
    { key: 'encodeResilient', name: 'resilient / ENCODE' },
    { key: 'retrieveUbiquitousChoiceR', name: 'ubiquitous / RETRIEVE-R-choice' },
    { key: 'retrieveDeliberateCuedP', name: 'deliberate / RETRIEVE-P-cued' },
    { key: 'fluencyContemporaryR', name: 'contemporary / FLUENCY-R' },
    { key: 'fluencyResilientP', name: 'resilient / FLUENCY-P' },
  ];

  test.each(scenario)('按大场景规格生成任务：$name', async ({ key }) => {
    const { state, repository, provider, result } = await runScenario(key);
    const task = expectOk(result);
    const specification = specifications[key];

    expect(task.id).toBe(taskIds[key]);
    expect(task.learnerId).toBe(learnerId);
    expect(task.goalId).toBe(goalId);
    expect(task.issuedAt).toBe(at.issued);
    expect(task.status).toBe('issued');
    expect(task.completedAt).toBe(null);
    expect(task.content).toEqual(aiOutputs[key]);
    // AI Provider 收到排期规格、仓库加载的目标知识点、学习者词汇水平和来源材料。
    const knowledgePoint = knowledgePoints.find((item) => item.id === specification.wordId);
    expect(provider.requests).toEqual([{
      specification,
      knowledgePoint,
      sourceMaterials: [material],
      learnerVocabulary,
    }]);
    // 本用例不单独持久化任务，避免生成后未进入计划的孤立任务。
    expect(repository.persistedTasks).toHaveLength(0);
    expect(state.tasks).toHaveLength(0);
  });

  test('AI 请求失败时返回失败，不创建、不保存任务', async () => {
    const { repository, provider } = setup(() => {
      throw new Error('LLM unreachable');
    });
    const result = await generateLearningTaskUseCase(
      { repository, aiProvider: provider, logger: silentLogger },
      inputFor('encodeResilient'),
    );

    expect(result).toEqual({ ok: false, reason: 'ai_error' });
    expect(provider.requests).toHaveLength(1);
    expect(repository.persistedTasks).toHaveLength(0);
  });

  test('AI 输出无法解析为 JSON 时重试 3 次后返回失败，不落任何状态', async () => {
    const { repository, provider } = setup(() => 'not a json {');
    const result = await generateLearningTaskUseCase(
      { repository, aiProvider: provider, logger: silentLogger },
      inputFor('retrieveUbiquitousChoiceR'),
    );

    expect(result).toEqual({ ok: false, reason: 'invalid_ai_output' });
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[1].feedback).toContain('JSON');
    expect(repository.persistedTasks).toHaveLength(0);
  });

  const cued = aiOutputs.retrieveDeliberateCuedP;
  const mismatchCases: Array<{
    name: string;
    key: ScenarioKey;
    output: unknown;
    reason: 'spec_mismatch' | 'invalid_ai_output';
  }> = [
    {
      name: '任务类型与规格不符',
      key: 'retrieveUbiquitousChoiceR',
      output: { ...aiOutputs.encodeResilient, wordId: 'kp-ubiquitous' },
      reason: 'spec_mismatch',
    },
    {
      name: '知识点与规格不符',
      key: 'retrieveUbiquitousChoiceR',
      output: { ...aiOutputs.retrieveUbiquitousChoiceR, wordId: 'kp-resilient' },
      reason: 'spec_mismatch',
    },
    {
      name: 'R/P 维度与规格不符',
      key: 'retrieveUbiquitousChoiceR',
      output: {
        ...aiOutputs.retrieveUbiquitousChoiceR,
        content: { ...aiOutputs.retrieveUbiquitousChoiceR.content, axis: 'P' },
      },
      reason: 'spec_mismatch',
    },
    {
      name: '提取阶段与规格不符',
      key: 'retrieveDeliberateCuedP',
      output: { ...cued, content: { ...cued.content, stage: 'free' } },
      reason: 'spec_mismatch',
    },
    {
      name: '内容结构残缺导致校验无法完成',
      key: 'encodeResilient',
      output: { schemaVersion: '1', task: 'ENCODE', wordId: 'kp-resilient', content: {} },
      reason: 'invalid_ai_output',
    },
  ];

  test.each(mismatchCases)('AI 输出校验失败：$name', async ({ key, output, reason }) => {
    const { repository, provider } = setup(() => JSON.stringify(output));
    const result = await generateLearningTaskUseCase(
      { repository, aiProvider: provider, logger: silentLogger },
      inputFor(key),
    );

    expect(result).toEqual({ ok: false, reason });
    expect(provider.requests).toHaveLength(3);
    expect(repository.persistedTasks).toHaveLength(0);
  });

  test.each<{ name: string; specification: TaskSpecification }>([
    { name: '知识点不存在', specification: { goalId, wordId: 'kp-unknown', task: 'ENCODE' } },
    { name: '目标不存在', specification: { goalId: 'goal-unknown', wordId: 'kp-resilient', task: 'ENCODE' } },
  ])('前置条件不满足（$name）时不调用 AI，返回 context_not_found', async ({ specification }) => {
    const { repository, provider } = setup(() => JSON.stringify(aiOutputs.encodeResilient));
    const result = await generateLearningTaskUseCase(
      { repository, aiProvider: provider, logger: silentLogger },
      { taskId: 'task-x', learnerId, specification, issuedAt: at.issued },
    );

    expect(result).toEqual({ ok: false, reason: 'context_not_found' });
    expect(provider.requests).toHaveLength(0);
    expect(repository.persistedTasks).toHaveLength(0);
  });

  test('调用 AI 期间不持有数据库事务', async () => {
    const { repository, provider } = setup(() => JSON.stringify(aiOutputs.encodeResilient));
    let observedDepth: number | null = null;
    provider.onRequest = () => {
      observedDepth = repository.transactionDepth;
    };

    const result = await generateLearningTaskUseCase(
      { repository, aiProvider: provider, logger: silentLogger },
      inputFor('encodeResilient'),
    );

    expectOk(result);
    expect(observedDepth).toBe(0);
  });

  test('失败原因写入日志，便于排查', async () => {
    const entries: LogEntry[] = [];
    const { repository, provider } = setup(() => {
      throw new Error('LLM unreachable');
    });
    const result = await generateLearningTaskUseCase(
      { repository, aiProvider: provider, logger: captureLogger(entries) },
      inputFor('encodeResilient'),
    );

    expect(result).toEqual({ ok: false, reason: 'ai_error' });
    expect(entries).toContainEqual(expect.objectContaining({
      level: 'error',
      msg: '任务生成：AI 请求失败',
      error: 'LLM unreachable',
    }));
  });

  test('成功时 info 日志包含完整任务内容', async () => {
    const entries: LogEntry[] = [];
    const { repository, provider } = setup(() => JSON.stringify(aiOutputs.encodeResilient));
    const result = await generateLearningTaskUseCase(
      { repository, aiProvider: provider, logger: captureLogger(entries) },
      inputFor('encodeResilient'),
    );
    const task = expectOk(result);

    expect(entries).toContainEqual(expect.objectContaining({
      level: 'info',
      msg: '任务生成：任务已生成',
      taskContent: task.content,
    }));
  });

  test('RETRIEVE 选择题：服务端任务保留答案与解释，公开视图必须剥离', async () => {
    const task = expectOk((await runScenario('retrieveUbiquitousChoiceR')).result);
    const content = task.content.content;
    expect(content).toHaveProperty('answerOptionId', 'a');
    expect(content).toHaveProperty('explanation');

    const view = toLearningTaskView(task);
    expect(view.content.content).not.toHaveProperty('answerOptionId');
    expect(view.content.content).not.toHaveProperty('explanation');
  });

  test('FLUENCY-R：公开视图剥离证据句与自由题答案', async () => {
    const task = expectOk((await runScenario('fluencyContemporaryR')).result);
    const serverQuestions = expectReadingContent(task.content).questions;
    expect(serverQuestions[0]).toHaveProperty('answerOptionId');
    expect(serverQuestions[1]).toHaveProperty('answer');

    const view = toLearningTaskView(task);
    const viewQuestions = expectReadingContent(view.content).questions;
    for (const question of viewQuestions) {
      expect(question).not.toHaveProperty('answer');
      expect(question).not.toHaveProperty('evidence');
      expect(question).not.toHaveProperty('answerOptionId');
    }
  });

  test('FLUENCY-P：服务端任务保留评分要求，公开视图必须剥离', async () => {
    const task = expectOk((await runScenario('fluencyResilientP')).result);
    expect(task.content.content).toHaveProperty('gradingRequirements');

    const view = toLearningTaskView(task);
    expect(view.content.content).not.toHaveProperty('gradingRequirements');
  });

  test('ENCODE：视图与服务端内容一致（本来就没有隐藏答案）', async () => {
    const task = expectOk((await runScenario('encodeResilient')).result);
    expect(toLearningTaskView(task).content).toEqual(task.content);
  });
});

describe('S08 AI 生成重试', () => {
  test('解析失败带反馈重试，第二次成功', async () => {
    const outputs = ['not a json {', JSON.stringify(aiOutputs.encodeResilient)];
    let call = 0;
    const { repository, provider } = setup(() => outputs[call++]);
    const entries: LogEntry[] = [];

    const result = await generateLearningTaskUseCase(
      { repository, aiProvider: provider, logger: captureLogger(entries) },
      inputFor('encodeResilient'),
    );

    expectOk(result);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0].feedback).toBeUndefined();
    expect(provider.requests[1].feedback).toContain('JSON');
    expect(entries.filter((entry) => entry.msg === '任务生成：AI 尝试')).toHaveLength(2);
    expect(entries).toContainEqual(expect.objectContaining({
      level: 'info',
      msg: '任务生成：任务已生成',
      attempt: 2,
    }));
  });

  test('校验失败带原因重试，第二次成功', async () => {
    const shortPassage = aiOutputs.fluencyContemporaryR.content.passage.split(' ').slice(0, 40).join(' ');
    const outputs = [
      JSON.stringify({
        ...aiOutputs.fluencyContemporaryR,
        content: { ...aiOutputs.fluencyContemporaryR.content, passage: shortPassage },
      }),
      JSON.stringify(aiOutputs.fluencyContemporaryR),
    ];
    let call = 0;
    const { repository, provider } = setup(() => outputs[call++]);

    const result = await generateLearningTaskUseCase(
      { repository, aiProvider: provider, logger: silentLogger },
      inputFor('fluencyContemporaryR'),
    );

    expectOk(result);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].feedback).toContain('80~100');
  });

  test('3 次尝试全部失败则判失败，每次尝试与用尽都有日志', async () => {
    const entries: LogEntry[] = [];
    const { repository, provider } = setup(() => 'not a json {');

    const result = await generateLearningTaskUseCase(
      { repository, aiProvider: provider, logger: captureLogger(entries) },
      inputFor('encodeResilient'),
    );

    expect(result).toEqual({ ok: false, reason: 'invalid_ai_output' });
    expect(provider.requests).toHaveLength(MAX_TASK_GENERATION_ATTEMPTS);
    expect(entries.filter((entry) => entry.msg === '任务生成：AI 尝试')).toHaveLength(MAX_TASK_GENERATION_ATTEMPTS);
    expect(entries).toContainEqual(expect.objectContaining({
      level: 'error',
      msg: '任务生成：AI 尝试次数用尽',
      attempts: MAX_TASK_GENERATION_ATTEMPTS,
    }));
  });
});

describe('inspectGeneratedTask：FLUENCY-R 短文质量', () => {
  const specification = specifications.fluencyContemporaryR;
  const base = aiOutputs.fluencyContemporaryR;
  const target = 'contemporary';
  const baseWords = base.content.passage.split(' ');

  const withPassage = (passage: string, targetOccurrences = 4) => ({
    ...base,
    content: { ...base.content, passage, targetOccurrences },
  });
  const passageWithWords = (count: number) => count <= baseWords.length
    ? baseWords.slice(0, count).join(' ')
    : `${base.content.passage} ${'again '.repeat(count - baseWords.length).trim()}`;

  test('合规短文通过', () => {
    expect(inspectGeneratedTask(specification, base, target).reasons).toEqual([]);
  });

  test.each([
    ['79 词不足下限', 79, false],
    ['80 词踩下限通过', 80, true],
    ['100 词踩上限通过', 100, true],
    ['101 词超出上限', 101, false],
  ])('词数边界：%s', (_name, count, valid) => {
    const inspection = inspectGeneratedTask(specification, withPassage(passageWithWords(count)), target);
    if (valid) {
      expect(inspection.reasons).toEqual([]);
    } else {
      expect(inspection.reasons.join()).toContain('80~100');
    }
  });

  test('目标词出现不足 3 次被拒', () => {
    const passage = base.content.passage
      .replace('A contemporary team learns', 'A team learns')
      .replace('In this kind of contemporary workplace', 'In this kind of workplace');
    const inspection = inspectGeneratedTask(specification, withPassage(passage, 2), target);
    expect(inspection.reasons.join()).toContain('至少出现 3 次');
  });

  test('声明次数与实际不符被拒', () => {
    const inspection = inspectGeneratedTask(specification, withPassage(base.content.passage, 2), target);
    expect(inspection.reasons.join()).toContain('targetOccurrences 与实际不符');
  });

  test('不传目标词形时跳过短文质量检查', () => {
    const declaredWrong = withPassage(base.content.passage, 99);
    expect(inspectGeneratedTask(specification, declaredWrong).reasons).toEqual([]);
    expect(inspectGeneratedTask(specification, declaredWrong, target).reasons.join())
      .toContain('targetOccurrences 与实际不符');
  });
});
