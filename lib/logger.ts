import pino from 'pino';
import path from 'node:path';

const logFile = process.env.LOG_FILE ?? path.join(process.cwd(), 'logs', 'app.log');

/** Structured application logger. Writes newline-delimited JSON to stdout and logs/app.log. */
export const logger = pino({
  name: 'flow',
  level: process.env.LOG_LEVEL ?? 'info',
}, pino.destination({ dest: logFile, sync: false, mkdir: true }));
