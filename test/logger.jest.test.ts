/// <reference types="jest" />

/**
 * logger 模块测试：文件持久化与级别过滤。
 * 写到临时目录，避免污染仓库；默认 logs/app.log 行为由 Live 运行人工确认。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppLogger } from '../lib/application/logger';

function readLines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('createAppLogger 文件持久化', () => {
  const dirs: string[] = [];
  function tempLogFile(name: string) {
    const dir = mkdtempSync(join(tmpdir(), 'flow-logger-'));
    dirs.push(dir);
    return join(dir, name);
  }

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  test('日志行以 JSON 写入指定文件并包含业务字段', () => {
    const file = tempLogFile('app.log');
    const logger = createAppLogger({ logFile: file, level: 'info' });

    logger.info({ taskId: 'task-1', durationMs: 5 }, '任务生成：任务已生成');

    expect(existsSync(file)).toBe(true);
    expect(readLines(file)).toEqual([
      expect.objectContaining({
        level: 30,
        msg: '任务生成：任务已生成',
        taskId: 'task-1',
        durationMs: 5,
      }),
    ]);
  });

  test('级别过滤：warn 时不写入 info 行', () => {
    const file = tempLogFile('warn.log');
    const logger = createAppLogger({ logFile: file, level: 'warn' });

    logger.info({ taskId: 'task-2' }, '任务生成：任务已生成');
    logger.warn({ goalId: 'g-1' }, '任务生成：目标知识点不存在');

    expect(readLines(file)).toEqual([
      expect.objectContaining({ level: 40, msg: '任务生成：目标知识点不存在' }),
    ]);
  });

  test('logFile 为空字符串时不创建任何文件，logger 仍可用', () => {
    const logger = createAppLogger({ logFile: '', level: 'info' });

    expect(() => logger.info({ ok: true }, '无文件输出')).not.toThrow();
  });

  test('可用环境变量指定文件路径（AI_LOG_FILE 场景）', () => {
    const file = tempLogFile('ai.log');
    process.env.AI_LOG_FILE = file;
    try {
      const logger = createAppLogger({
        logFileEnvKey: 'AI_LOG_FILE',
        logFileDefault: 'logs/ai.log',
        level: 'info',
      });
      logger.info({ model: 'deepseek-chat' }, 'llm 请求成功');

      expect(readLines(file)).toEqual([
        expect.objectContaining({ level: 30, msg: 'llm 请求成功', model: 'deepseek-chat' }),
      ]);
    } finally {
      delete process.env.AI_LOG_FILE;
    }
  });
});
