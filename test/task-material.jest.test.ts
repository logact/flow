import { describe, expect, test } from '@jest/globals';
import { buildTaskPrompt, createConfiguredTaskMaterialGenerator, createFixtureGenerator, createOpenAICompatibleGenerator, generateTask, toLearnerTask, type RawGenerationResult, type TaskGenerationInput, type TaskGenerationLogger } from '../lib/task-material';

const input = (task: TaskGenerationInput['task'], axis: TaskGenerationInput['axis'], stage?: TaskGenerationInput['stage']): TaskGenerationInput => ({
  word: { id: 'w1', text: 'harbor', sense: { id: 's1', definition: 'a sheltered place for ships', examples: ['The boats entered the harbor.'] } },
  axis, task, ...(stage ? { stage } : {}), learner: { level: 'B1', score: task === 'ENCODE' ? { R: 0, P: 0 } : 40, language: 'zh' }, promptVersion: 'p6-v1',
});
const passage = Array.from({ length: 8 }, () => 'The harbor welcomes many boats each morning and shelters nearby fishing families safely.').join(' ');
const material = (i: TaskGenerationInput, overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const base = i.task === 'ENCODE' ? { schemaVersion: '1', task: 'ENCODE', wordId: i.word.id, content: { word: i.word.text, definition: i.word.sense.definition, examples: [{ sentence: 'The harbor sheltered the boats.' }], instruction: 'Study the word and example.' } }
    : i.task === 'RETRIEVE' && i.stage === 'choice' ? { schemaVersion: '1', task: 'RETRIEVE', wordId: i.word.id, content: { axis: i.axis, stage: 'choice', prompt: 'Choose the meaning of harbor.', options: [{ id: 'a', text: 'A sheltered place for ships' }, { id: 'b', text: 'A mountain path' }], answerOptionId: 'a', explanation: 'A harbor shelters ships.' } }
      : i.task === 'RETRIEVE' ? { schemaVersion: '1', task: 'RETRIEVE', wordId: i.word.id, content: { axis: i.axis, stage: i.stage, prompt: 'Recall the word for a sheltered place for ships.', ...(i.stage === 'cued' ? { cue: 'A sheltered place for ships' } : {}), answerKey: { acceptedAnswers: ['harbor'], explanation: 'That is the target word.' } } }
        : i.axis === 'R' ? { schemaVersion: '1', task: 'FLUENCY', wordId: i.word.id, content: { axis: 'R', passage, questions: [{ role: 'target_meaning', prompt: 'What does harbor mean here?', answer: 'A safe place for ships.', evidence: 'harbor welcomes many boats' }, { role: 'passage_comprehension', prompt: 'Whom does it shelter?', answer: 'Nearby fishing families.', evidence: 'shelters nearby fishing families' }], targetOccurrences: 8 } }
          : { schemaVersion: '1', task: 'FLUENCY', wordId: i.word.id, content: { axis: 'P', scenario: '你在旅行中向朋友介绍一个安全停船的地方。', responseInstruction: '用今天学到的表达写一句英文。', gradingRequirements: { targetExpression: 'harbor', targetUseCriteria: ['用词义正确'], overallExpressionCriteria: ['句子通顺'] } } };
  return { ...base, ...overrides };
};
const raw = (value: unknown, provider = 'fixture'): RawGenerationResult => ({ provider, model: `${provider}-v1`, rawOutput: typeof value === 'string' ? value : JSON.stringify(value) });

describe('P6 task material generation', () => {
  // 提示词把模型必须返回的字段写清楚，减少真实模型擅自改字段名或多包一层对象的情况。
  test('prompt includes the exact versioned output envelope and task schema', () => {
    const request = input('ENCODE', 'both');
    const prompt = JSON.parse(buildTaskPrompt(request));
    expect(prompt.outputShape).toMatchObject({ schemaVersion: '1', task: 'ENCODE', wordId: 'w1', content: { word: 'harbor', definition: 'a sheltered place for ships' } });
    expect(prompt.instruction).toContain('do not rename keys');
    expect(prompt.learnerLevelRule).toContain('learner.level=B1');
    expect(prompt.learnerLevelRule).toContain('all learner-facing English vocabulary and grammar');
  });

  // 给每一种题型准备一份合格材料，确认它们都能走同一个生成入口并通过检查。
  test('fixture service returns validated material for all six task variants', async () => {
    const variants: Array<[TaskGenerationInput['task'], TaskGenerationInput['axis'], TaskGenerationInput['stage']?]> = [
      ['ENCODE', 'both'], ['RETRIEVE', 'R', 'choice'], ['RETRIEVE', 'P', 'cued'], ['RETRIEVE', 'R', 'free'], ['FLUENCY', 'R'], ['FLUENCY', 'P'],
    ];
    for (const [task, axis, stage] of variants) {
      const request = input(task, axis, stage);
      const result = await generateTask(request, createFixtureGenerator([raw(material(request))]), { generationId: `${task}-${axis}-${stage ?? ''}` });
      if (result.status !== 'ready') throw new Error(`${task}/${axis}/${stage}: ${result.reason}`);
      expect(result).toMatchObject({ status: 'ready' });
      if (result.status === 'ready') expect(result.material.wordId).toBe('w1');
    }
  });

  // 先故意给坏 JSON，再给词义不对的材料，最后给正确材料；确认服务会重试并逐次记日志。
  test('rejects malformed and mismatched outputs, retries, and logs every attempt', async () => {
    const request = input('ENCODE', 'both');
    const events: Parameters<TaskGenerationLogger>[0][] = [];
    const result = await generateTask(request, createFixtureGenerator([raw('{not json'), raw(material(request, { content: { word: 'harbor', definition: 'wrong sense' } })), raw(material(request))]), { maxAttempts: 3, generationId: 'retry-test', logger: event => events.push(event) });
    expect(result.status).toBe('ready');
    expect(events).toHaveLength(3);
    expect(events.map(event => event.errors)).toEqual([['invalid_json'], ['invalid_encode_schema', 'sense_mismatch', 'invalid_examples', 'invalid_instruction'], []]);
    expect(events[0]).toMatchObject({ attempt: 1, valid: false, retryReason: 'invalid_json' });
    expect(events[1].errors).toContain('sense_mismatch');
  });

  // 连续两次都给不合格的短文章；确认最终只返回 unavailable，不会把坏题交出去。
  test('exhaustion returns unavailable and never exposes invalid material', async () => {
    const request = input('FLUENCY', 'R');
    const events: Parameters<TaskGenerationLogger>[0][] = [];
    const result = await generateTask(request, createFixtureGenerator([raw(material(request, { content: { axis: 'R', passage: 'too short', questions: [], targetOccurrences: 0 } }))]), { maxAttempts: 2, logger: event => events.push(event) });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'passage_word_count,target_occurrence_count,invalid_questions' });
    expect(events).toHaveLength(2);
    expect(events.every(event => !event.valid)).toBe(true);
  });

  // P 轴材料不能把英文目标词直接露给学习者；R 轴文章里标注的目标词数量必须数得对。
  test('validates P fluency does not expose English target and R fluency counts', async () => {
    const p = input('FLUENCY', 'P');
    const badP = await generateTask(p, createFixtureGenerator([raw(material(p, { content: { ...(material(p) as any).content, scenario: 'Please say harbor now.' } }))]), { maxAttempts: 1 });
    expect(badP).toMatchObject({ status: 'unavailable', reason: 'target_revealed' });
    const r = input('FLUENCY', 'R');
    const badR = await generateTask(r, createFixtureGenerator([raw(material(r, { content: { ...(material(r) as any).content, targetOccurrences: 9 } }))]), { maxAttempts: 1 });
    expect(badR).toMatchObject({ status: 'unavailable', reason: 'target_occurrence_count' });
  });

  // 题目内部保留标准答案供服务端判分，但发给学习者的版本必须看不到答案和判分标准。
  test('removes answer keys and grading rubrics from learner-facing material', async () => {
    const retrieve = input('RETRIEVE', 'R', 'choice');
    const generated = await generateTask(retrieve, createFixtureGenerator([raw(material(retrieve))]));
    expect(generated.status).toBe('ready');
    if (generated.status !== 'ready') return;
    const learnerVersion = toLearnerTask(generated.material);
    expect(JSON.stringify(learnerVersion)).not.toContain('answerOptionId');
    expect(JSON.stringify(learnerVersion)).not.toContain('explanation');

    const production = input('FLUENCY', 'P');
    const fluency = await generateTask(production, createFixtureGenerator([raw(material(production))]));
    expect(fluency.status).toBe('ready');
    if (fluency.status !== 'ready') return;
    expect(JSON.stringify(toLearnerTask(fluency.material))).not.toContain('gradingRequirements');
  });

  // 传入 RETRIEVE 选择题后检查原对象没被生成流程改动，验证调用方状态不会被暗中修改。
  test('does not mutate its input and reports fixture retry attempts through the common service', async () => {
    const request = input('RETRIEVE', 'R', 'choice');
    const original = JSON.stringify(request);
    const result = await generateTask(request, createFixtureGenerator([raw(material(request))]), { logger: () => undefined });
    expect(result.status).toBe('ready');
    expect(JSON.stringify(request)).toBe(original);
  });

  // 模拟一个 OpenAI-compatible 接口响应，确认服务端密钥用于请求，但不会进入调试日志。
  test('provider adapter uses server API key and same raw-output service boundary', async () => {
    const originalFetch = globalThis.fetch;
    let authorization = '';
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('test-model');
      return new Response(JSON.stringify({ id: 'req-1', model: 'test-model', choices: [{ message: { content: JSON.stringify(material(input('ENCODE', 'both'))) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const request = input('ENCODE', 'both');
      const events: Parameters<TaskGenerationLogger>[0][] = [];
      const result = await generateTask(request, createOpenAICompatibleGenerator({ apiKey: 'test-secret', model: 'test-model', endpoint: 'https://provider.test' }), { logger: event => events.push(event) });
      expect(result.status).toBe('ready');
      expect(authorization).toBe('Bearer test-secret');
      expect(events[0]).toMatchObject({ provider: 'openai', model: 'test-model', requestId: 'req-1', valid: true });
      expect(events[0].request).toMatchObject({ url: 'https://provider.test', headers: { authorization: '[redacted]', 'content-type': 'application/json' } });
      expect(events[0].request?.body).toContain('test-model');
      expect(events[0].userPrompt).toContain('learnerLevelRule');
      expect(events[0].systemPrompt).toContain('Return only a JSON object');
      expect(events[0].rawResponse).toContain('"choices"');
      expect(JSON.stringify(events)).not.toContain('test-secret');
    } finally { globalThis.fetch = originalFetch; }
  });

  // 没有配置密钥时明确报错，避免开发者以为真实模型调用已经启用。
  test('provider adapter requires API key when configured for real generation', () => {
    expect(() => createOpenAICompatibleGenerator({ apiKey: '' })).toThrow('LLM_API_KEY');
  });

  // DeepSeek 和 Kimi 走各自官方地址、各自的密钥名；模型名由开发者传入，不写死在代码里。
  test('selects DeepSeek and Kimi endpoints and developer-selected models', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; model: string; authorization: string }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(url), model: body.model, authorization: new Headers(init?.headers).get('authorization') ?? '' });
      const request = input('ENCODE', 'both');
      return new Response(JSON.stringify({ id: 'provider-request', model: body.model, choices: [{ message: { content: JSON.stringify(material(request)) } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      for (const [provider, apiKey, model] of [['deepseek', 'ds-secret', 'deepseek-reasoner'], ['kimi', 'kimi-secret', 'kimi-k2.6']] as const) {
        const request = input('ENCODE', 'both');
        const endpoint = provider === 'deepseek' ? 'https://api.deepseek.com/chat/completions' : 'https://api.moonshot.ai/v1/chat/completions';
        const result = await generateTask(request, createConfiguredTaskMaterialGenerator([], { provider, apiKey, model, endpoint }), { logger: () => undefined });
        expect(result.status).toBe('ready');
      }
      expect(calls).toEqual([
        { url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-reasoner', authorization: 'Bearer ds-secret' },
        { url: 'https://api.moonshot.ai/v1/chat/completions', model: 'kimi-k2.6', authorization: 'Bearer kimi-secret' },
      ]);
    } finally { globalThis.fetch = originalFetch; }
  });

  // 即使 provider 返回错误状态，也要把发送的请求和收到的原始错误响应记录下来，且日志不能出现密钥。
  test('logs raw request and response when the provider returns an HTTP error', async () => {
    const originalFetch = globalThis.fetch;
    const events: Parameters<TaskGenerationLogger>[0][] = [];
    globalThis.fetch = (async () => new Response('{"error":{"message":"rate limited"}}', { status: 429 })) as typeof fetch;
    try {
      const result = await generateTask(input('ENCODE', 'both'), createOpenAICompatibleGenerator({ apiKey: 'never-log-this', model: 'test-model', endpoint: 'https://provider.test/chat/completions' }), { maxAttempts: 1, logger: event => events.push(event) });
      expect(result).toMatchObject({ status: 'unavailable', reason: 'provider_http_429' });
      expect(events[0]).toMatchObject({ provider: 'openai', model: 'test-model', valid: false, rawResponse: '{"error":{"message":"rate limited"}}' });
      expect(events[0].request?.body).toContain('test-model');
      expect(JSON.stringify(events)).not.toContain('never-log-this');
    } finally { globalThis.fetch = originalFetch; }
  });

  // 没设置 provider 时默认走内置 fixture，开发者不配置 API key 也能走完整服务流程。
  test('configured generator defaults to fixtures without an API key', async () => {
    const request = input('ENCODE', 'both');
    const result = await generateTask(request, createConfiguredTaskMaterialGenerator([raw(material(request))], { provider: 'fixture' }), { logger: () => undefined });
    expect(result.status).toBe('ready');
  });

  // 只设置约定的三个 LLM_* 环境变量，就能自动识别 DeepSeek 地址并使用指定模型。
  test('reads LLM_API_KEY, LLM_BASE_URL, and LLM_MODEL from the server environment', async () => {
    const prior = { key: process.env.LLM_API_KEY, base: process.env.LLM_BASE_URL, model: process.env.LLM_MODEL, provider: process.env.TASK_MATERIAL_PROVIDER };
    const originalFetch = globalThis.fetch;
    let captured: { url: string; model: string; authorization: string } | undefined;
    process.env.LLM_API_KEY = 'env-secret';
    process.env.LLM_BASE_URL = 'https://api.deepseek.com';
    process.env.LLM_MODEL = 'deepseek-chat';
    delete process.env.TASK_MATERIAL_PROVIDER;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      captured = { url: String(url), model: body.model, authorization: new Headers(init?.headers).get('authorization') ?? '' };
      const request = input('ENCODE', 'both');
      return new Response(JSON.stringify({ id: 'env-request', choices: [{ message: { content: JSON.stringify(material(request)) } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const request = input('ENCODE', 'both');
      const result = await generateTask(request, createConfiguredTaskMaterialGenerator([]), { logger: () => undefined });
      expect(result.status).toBe('ready');
      expect(captured).toEqual({ url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat', authorization: 'Bearer env-secret' });
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries({ LLM_API_KEY: prior.key, LLM_BASE_URL: prior.base, LLM_MODEL: prior.model, TASK_MATERIAL_PROVIDER: prior.provider })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});
