/// <reference types="jest" />

/**
 * 词义消歧 HTTP 实现的单元测试：
 * - 用桩 fetch 验证请求体结构与 AI 交互审计日志（请求 prompt / 原始响应 / 失败）。
 * - 校验 parseSenseDisambiguation 对非法输出的拒绝。
 */

import type { AppLogger } from '../lib/application/logger';
import {
  createHttpSenseDisambiguator,
  parseSenseDisambiguation,
} from '../lib/application/sense-disambiguator';
import type { SenseDisambiguationItem } from '../lib/application/ports';
import { silentLogger } from './helpers/silent-logger';

const items: SenseDisambiguationItem[] = [
  {
    key: '0',
    lemma: 'deliberate',
    sentence: 'A deliberate response helped the team.',
    context: [],
    candidates: [
      { id: 'wn31:a:01340892', pos: 'adjective', gloss: 'carefully thought out in advance' },
      { id: 'wn31:v:00814706', pos: 'verb', gloss: 'think about carefully; weigh' },
    ],
  },
];

interface LogEntry { level: string; msg: string; obj: Record<string, unknown> }

function captureLogger(entries: LogEntry[]): AppLogger {
  return {
    debug: (obj, msg) => entries.push({ level: 'debug', msg, obj }),
    info: (obj, msg) => entries.push({ level: 'info', msg, obj }),
    warn: (obj, msg) => entries.push({ level: 'warn', msg, obj }),
    error: (obj, msg) => entries.push({ level: 'error', msg, obj }),
  };
}

function jsonResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('词义消歧 HTTP 实现', () => {
  test('发送 OpenAI 兼容请求，并把请求 prompt 与原始响应写入审计日志', async () => {
    const entries: LogEntry[] = [];
    const captured: {
      body?: {
        model?: unknown;
        temperature?: unknown;
        response_format?: unknown;
        messages?: Array<{ role: string; content: string }>;
      };
    } = {};
    const disambiguator = createHttpSenseDisambiguator({
      apiKey: 'key',
      baseURL: 'https://api.example.com/',
      model: 'test-model',
      logger: silentLogger,
      auditLogger: captureLogger(entries),
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        captured.body = JSON.parse(String(init?.body));
        return jsonResponse('[{ "key": "0", "senseId": "wn31:a:01340892" }]');
      }) as typeof fetch,
    });

    const picks = await disambiguator.disambiguate(items);

    expect(picks).toEqual([{ key: '0', senseId: 'wn31:a:01340892' }]);
    expect(captured.body).toMatchObject({
      model: 'test-model',
      temperature: 0,
      response_format: { type: 'json_object' },
    });
    expect(captured.body?.messages?.[0].role).toBe('system');
    expect(captured.body?.messages?.[1]).toMatchObject({ role: 'user' });
    expect(captured.body?.messages?.[1].content).toContain('A deliberate response helped the team.');
    expect(captured.body?.messages?.[1].content).toContain('wn31:a:01340892');

    const requestEntry = entries.find((entry) => entry.msg === 'AI 交互：词义消歧请求');
    expect(requestEntry).toBeDefined();
    expect(String(requestEntry?.obj.prompt)).toContain('A deliberate response helped the team.');
    expect(requestEntry?.obj).toMatchObject({ call: 'sense-disambiguation', phase: 'request', model: 'test-model' });
    const responseEntry = entries.find((entry) => entry.msg === 'AI 交互：词义消歧响应');
    expect(String(responseEntry?.obj.raw)).toContain('wn31:a:01340892');
  });

  test('AI 请求失败时审计记录错误并原样抛出', async () => {
    const entries: LogEntry[] = [];
    const disambiguator = createHttpSenseDisambiguator({
      apiKey: 'key',
      baseURL: 'https://api.example.com',
      model: 'test-model',
      logger: silentLogger,
      auditLogger: captureLogger(entries),
      fetchImpl: (async () => new Response('boom', { status: 500 })) as typeof fetch,
    });

    await expect(disambiguator.disambiguate(items)).rejects.toThrow('status 500');
    const errorEntry = entries.find((entry) => entry.msg === 'AI 交互：词义消歧失败');
    expect(errorEntry?.level).toBe('error');
    expect(errorEntry?.obj).toMatchObject({ phase: 'request-error', model: 'test-model' });
    expect(String(errorEntry?.obj.error)).toContain('500');
  });
});

describe('parseSenseDisambiguation', () => {
  test('拒绝非 JSON 输出', () => {
    expect(() => parseSenseDisambiguation('not json', items)).toThrow('invalid JSON');
  });

  test('拒绝候选集外的 senseId', () => {
    const content = '[{ "key": "0", "senseId": "wn31:x:99999999" }]';
    expect(() => parseSenseDisambiguation(content, items)).toThrow('outside candidates');
  });

  test('拒绝未知 key', () => {
    const content = '[{ "key": "42", "senseId": "wn31:a:01340892" }]';
    expect(() => parseSenseDisambiguation(content, items)).toThrow('unknown key');
  });
});
