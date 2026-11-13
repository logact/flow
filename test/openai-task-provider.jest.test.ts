/// <reference types="jest" />

/**
 * OpenAI 兼容 LLM 客户端与出题 prompt 的单元测试。
 * fetch 全部打桩，不触网；真实供应商行为由 task-generation.live.test.ts 验证。
 * 全部测试注入静默 logger，日志行为有专门的用例断言。
 */

import type { AppLogger } from '../lib/application/logger';
import {
  AIProviderError,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  OpenAICompatibleChatClient,
  loadLLMConfig,
  stripCodeFences,
  type LLMConfig,
} from '../lib/application/llm';
import { OpenAITaskGenerationProvider } from '../lib/application/openai-task-provider';
import {
  buildTaskGenerationMessages,
  formatLearnerVocabulary,
} from '../lib/application/task-generation-prompt';
import type { TaskGenerationAIRequest } from '../lib/application/ports';
import {
  knowledgePoints,
  learnerVocabulary,
  material,
  silentLogger,
  specifications,
} from './helpers/task-generation-fixture';

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function captureFetch(handler: (callIndex: number) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(calls.length - 1);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

type LogEntry = { level: string; msg: string } & Record<string, unknown>;

function captureLogger(entries: LogEntry[]): AppLogger {
  const push = (level: string) => (obj: Record<string, unknown>, msg: string) => {
    entries.push({ level, msg, ...obj });
  };
  return { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

const config: LLMConfig = {
  apiKey: 'test-key',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
};
const messages = [{ role: 'user' as const, content: 'hello' }];

describe('loadLLMConfig', () => {
  test('未设置环境变量时默认使用 DeepSeek', () => {
    expect(loadLLMConfig({})).toEqual({
      apiKey: '',
      baseUrl: DEFAULT_LLM_BASE_URL,
      model: DEFAULT_LLM_MODEL,
    });
  });

  test('环境变量覆盖默认值，且 baseUrl 末尾斜杠会被去掉', () => {
    const loaded = loadLLMConfig({
      LLM_API_KEY: 'sk-live',
      LLM_BASE_URL: 'https://api.moonshot.cn/v1/',
      LLM_MODEL: 'kimi-k2-0711-preview',
    });
    expect(loaded).toEqual({
      apiKey: 'sk-live',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'kimi-k2-0711-preview',
    });
  });
});

describe('OpenAICompatibleChatClient', () => {
  test('成功时返回首个 choice 的内容，并携带认证与 JSON 模式请求体', async () => {
    const { calls, fetchImpl } = captureFetch(() =>
      jsonResponse(200, { choices: [{ message: { content: '{"task":"ENCODE"}' } }] }));
    const client = new OpenAICompatibleChatClient(config, fetchImpl, silentLogger);

    const content = await client.chat(messages, { json: true, temperature: 0.3 });

    expect(content).toBe('{"task":"ENCODE"}');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.deepseek.com/chat/completions');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });
  });

  test('未开启 json 模式时不带 response_format', async () => {
    const { calls, fetchImpl } = captureFetch(() =>
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }));
    const client = new OpenAICompatibleChatClient(config, fetchImpl, silentLogger);

    await client.chat(messages);

    expect(JSON.parse(String(calls[0].init.body))).not.toHaveProperty('response_format');
  });

  test('缺少 API key 时直接报错，不发起请求', async () => {
    const { calls, fetchImpl } = captureFetch(() => jsonResponse(200, {}));
    const client = new OpenAICompatibleChatClient({ ...config, apiKey: '' }, fetchImpl, silentLogger);

    await expect(client.chat(messages)).rejects.toMatchObject({ name: 'AIProviderError' });
    expect(calls).toHaveLength(0);
  });

  test('4xx 错误不重试，原样抛出状态码', async () => {
    const { calls, fetchImpl } = captureFetch(() =>
      jsonResponse(400, { error: { message: 'invalid request' } }));
    const client = new OpenAICompatibleChatClient(config, fetchImpl, silentLogger);

    await expect(client.chat(messages)).rejects.toMatchObject({
      name: 'AIProviderError',
      status: 400,
    });
    expect(calls).toHaveLength(1);
  });

  test('5xx 错误按默认次数重试，成功后返回', async () => {
    const { calls, fetchImpl } = captureFetch((index) => (index === 0
      ? jsonResponse(500, { error: { message: 'server error' } })
      : jsonResponse(200, { choices: [{ message: { content: 'recovered' } }] })));
    const client = new OpenAICompatibleChatClient(config, fetchImpl, silentLogger);

    await expect(client.chat(messages)).resolves.toBe('recovered');
    expect(calls).toHaveLength(2);
  });

  test('网络错误重试到上限后抛出', async () => {
    const { calls, fetchImpl } = captureFetch(() => {
      throw new Error('ECONNRESET');
    });
    const client = new OpenAICompatibleChatClient(config, fetchImpl, silentLogger);

    await expect(client.chat(messages, { maxAttempts: 3 })).rejects.toThrow('ECONNRESET');
    expect(calls).toHaveLength(3);
  });

  test('返回内容为空时报 AIProviderError', async () => {
    const { fetchImpl } = captureFetch(() => jsonResponse(200, { choices: [{ message: { content: '  ' } }] }));
    const client = new OpenAICompatibleChatClient(config, fetchImpl, silentLogger);

    await expect(client.chat(messages, { maxAttempts: 1 })).rejects.toBeInstanceOf(AIProviderError);
  });
});

describe('OpenAICompatibleChatClient 日志', () => {
  test('重试记 warn，最终失败记 error 且带状态码', async () => {
    const entries: LogEntry[] = [];
    const { fetchImpl } = captureFetch(() => jsonResponse(500, { error: { message: 'server error' } }));
    const client = new OpenAICompatibleChatClient(config, fetchImpl, captureLogger(entries));

    await expect(client.chat(messages, { maxAttempts: 2 })).rejects.toMatchObject({ status: 500 });

    expect(entries.filter((entry) => entry.level === 'warn')).toHaveLength(1);
    expect(entries.filter((entry) => entry.level === 'error')).toHaveLength(1);
    expect(entries.at(-1)).toMatchObject({ level: 'error', status: 500, attempt: 2 });
  });

  test('4xx 不重试，只记一条 error', async () => {
    const entries: LogEntry[] = [];
    const { calls, fetchImpl } = captureFetch(() => jsonResponse(400, { error: { message: 'bad request' } }));
    const client = new OpenAICompatibleChatClient(config, fetchImpl, captureLogger(entries));

    await expect(client.chat(messages)).rejects.toMatchObject({ status: 400 });

    expect(calls).toHaveLength(1);
    expect(entries.filter((entry) => entry.level === 'error')).toHaveLength(1);
    expect(entries.find((entry) => entry.level === 'error')).toMatchObject({ status: 400 });
  });

  test('成功路径不产生 error/warn 日志', async () => {
    const entries: LogEntry[] = [];
    const { fetchImpl } = captureFetch(() =>
      jsonResponse(200, { choices: [{ message: { content: 'fine' } }] }));
    const client = new OpenAICompatibleChatClient(config, fetchImpl, captureLogger(entries));

    await expect(client.chat(messages)).resolves.toBe('fine');
    expect(entries.filter((entry) => entry.level === 'error' || entry.level === 'warn')).toHaveLength(0);
  });

  test('成功路径 info 日志记录完整请求消息与响应全文', async () => {
    const entries: LogEntry[] = [];
    const { fetchImpl } = captureFetch(() =>
      jsonResponse(200, { choices: [{ message: { content: '{"ok":true}' } }] }));
    const client = new OpenAICompatibleChatClient(config, fetchImpl, captureLogger(entries));

    await client.chat(messages);

    const sent = entries.find((entry) => entry.msg === 'llm 请求发送');
    expect(sent).toMatchObject({ level: 'info', model: 'deepseek-chat' });
    expect(sent?.messages).toEqual(messages);
    const succeeded = entries.find((entry) => entry.msg === 'llm 请求成功');
    expect(succeeded).toMatchObject({ level: 'info', content: '{"ok":true}' });
  });
});

describe('stripCodeFences', () => {
  test.each([
    ['纯文本原样返回并去首尾空白', '  {"a":1}  ', '{"a":1}'],
    ['剥离 ```json 围栏', '```json\n{"a":1}\n```', '{"a":1}'],
    ['剥离无语言标记围栏', '```\n{"a":1}\n```', '{"a":1}'],
    ['围栏前后带解释文字时取围栏内内容', '这是结果：\n```json\n{"a":1}\n```\n完', '{"a":1}'],
  ])('%s', (_name, input, expected) => {
    expect(stripCodeFences(input)).toBe(expected);
  });
});

describe('buildTaskGenerationMessages', () => {
  const request: TaskGenerationAIRequest = {
    specification: specifications.retrieveUbiquitousChoiceR,
    knowledgePoint: knowledgePoints.find((item) => item.id === 'kp-ubiquitous')!,
    sourceMaterials: [material],
    learnerVocabulary,
  };

  test('系统提示给出五种题型的结构约束', () => {
    const [system] = buildTaskGenerationMessages(request);
    expect(system.role).toBe('system');
    for (const keyword of ['schemaVersion', 'answerKey', 'targetOccurrences', 'gradingRequirements', 'evidence', 'answerOptionId', '80-100词', '至少出现3次']) {
      expect(system.content).toContain(keyword);
    }
  });

  test('FLUENCY-R 短文要求 80-100 词且目标词至少出现 3 次', () => {
    const [system] = buildTaskGenerationMessages(request);
    expect(system.content).toContain('80-100词的英文短文，目标词至少出现3次');
    expect(system.content).toContain('整数且≥3，必须与短文一致');
  });

  test('系统提示要求按学习者词汇水平控制难度', () => {
    const [system] = buildTaskGenerationMessages(request);
    expect(system.content).toContain('学习者词汇水平');
    expect(system.content).toContain('掌握概率');
  });

  test('用户消息携带规格、知识点、学习者水平与来源材料', () => {
    const [, user] = buildTaskGenerationMessages(request);
    expect(user.role).toBe('user');
    expect(user.content).toContain('"stage":"choice"');
    expect(user.content).toContain('ubiquitous');
    expect(user.content).toContain('无处不在的');
    expect(user.content).toContain('How teams adapt');
    expect(user.content).toContain('Contemporary teams work in a world');
    expect(user.content).toContain('bnc-coca-l6 v2.0.0');
    expect(user.content).toContain('5k 词段：掌握概率 0.55');
  });

  test('带反馈时用户消息附带上次失败原因，无反馈则不附带', () => {
    const [, withFeedback] = buildTaskGenerationMessages({ ...request, feedback: '短文词数不足' });
    expect(withFeedback.content).toContain('上次生成未通过校验：短文词数不足');

    const [, withoutFeedback] = buildTaskGenerationMessages(request);
    expect(withoutFeedback.content).not.toContain('上次生成未通过校验');
  });
});

describe('formatLearnerVocabulary', () => {
  test('无测评记录时提示按中等水平出题', () => {
    expect(formatLearnerVocabulary(null)).toContain('尚未完成词汇测评');
  });

  test('按词段列出掌握概率与抽样证据', () => {
    const text = formatLearnerVocabulary(learnerVocabulary);
    expect(text).toContain('1k 词段：掌握概率 0.95，抽样 20 词族认识 19');
    expect(text).toContain('25k 词段：掌握概率 0.1，抽样 20 词族认识 2');
  });
});

describe('OpenAITaskGenerationProvider', () => {
  test('以 JSON 模式调用客户端，并剥离返回内容中的代码块围栏', async () => {
    const chat = jest.fn(async () => '```json\n{"schemaVersion":"1","task":"ENCODE"}\n```');
    const provider = new OpenAITaskGenerationProvider({ chat });

    const raw = await provider.generateTask({
      specification: specifications.encodeResilient,
      knowledgePoint: knowledgePoints.find((item) => item.id === 'kp-resilient')!,
      sourceMaterials: [material],
      learnerVocabulary,
    });

    expect(raw).toBe('{"schemaVersion":"1","task":"ENCODE"}');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledWith(expect.any(Array), { json: true, temperature: 0.7 });
  });
});
