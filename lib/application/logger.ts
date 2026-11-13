import pino from 'pino';

/**
 * 应用层统一日志约定。
 * 业务代码只依赖 AppLogger 接口，测试可注入静默或捕获型 logger；
 * 运行时使用 pino，同时输出到 stdout 和本地文件。
 *
 * 两个预置实例：
 * - logger：应用编排日志 → logs/app.log
 * - aiLogger：AI 链路日志（LLM 客户端、AI Provider）→ logs/ai.log
 *
 * 环境变量：
 * - LOG_LEVEL：级别，默认 info。
 * - LOG_FILE / AI_LOG_FILE：各自文件路径，设为空字符串禁用文件输出。
 */

export interface AppLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface CreateAppLoggerOptions {
  level?: string;
  name?: string;
  /** 显式指定文件路径；空字符串禁用文件输出。 */
  logFile?: string;
  /** 未显式指定时读取该环境变量；再缺省用 logFileDefault。 */
  logFileEnvKey?: string;
  logFileDefault?: string;
}

function resolveLogFile(options: CreateAppLoggerOptions): string {
  if (options.logFile !== undefined) return options.logFile;
  const envValue = options.logFileEnvKey ? process.env[options.logFileEnvKey] : undefined;
  if (typeof envValue === 'string') return envValue;
  return options.logFileDefault ?? 'logs/app.log';
}

export function createAppLogger(options: CreateAppLoggerOptions = {}): AppLogger {
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info';
  const logFile = resolveLogFile(options);
  const streams = [
    { stream: process.stdout },
    // sync 写入保证短生命周期进程（jest、脚本）退出前落盘；原型阶段不需要滚动。
    ...(logFile ? [{ stream: pino.destination({ dest: logFile, mkdir: true, sync: true }) }] : []),
  ];
  return pino({ name: options.name ?? 'flow', level }, pino.multistream(streams));
}

/** 进程级默认 logger（应用编排）；需要静默的调用方（测试）应显式注入。 */
export const logger: AppLogger = createAppLogger();

/** AI 链路默认 logger：LLM 客户端与 AI Provider 使用，与编排日志分文件。 */
export const aiLogger: AppLogger = createAppLogger({
  name: 'flow:ai',
  logFileEnvKey: 'AI_LOG_FILE',
  logFileDefault: 'logs/ai.log',
});
