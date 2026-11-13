import type { AppLogger } from '../../lib/application/logger';

/** 测试默认注入的静默 logger，避免污染 jest 输出。 */
export const silentLogger: AppLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
