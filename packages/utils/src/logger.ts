/**
 * Structured logging built on Pino.
 *
 * One logger per process, child loggers per module. Everything is JSON by
 * default; set SOLADMIN_LOG_PRETTY=1 for local development.
 * @module
 */

import pino from 'pino';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

/** Pino logger with typed child support. */
export type ToolkitLogger = pino.Logger;

function levelFromEnv(): LogLevel {
  const v = (process.env['SOLADMIN_LOG_LEVEL'] ?? '').toLowerCase();
  if (['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(v)) {
    return v as LogLevel;
  }
  return process.env['NODE_ENV'] === 'test' ? 'silent' : 'info';
}

const pretty = process.env['SOLADMIN_LOG_PRETTY'] === '1';

const root = pino({
  level: levelFromEnv(),
  base: { app: 'soladmin' },
  formatters: { level: (label: string) => ({ level: label }) },
  ...(pretty
    ? {
        transport: {
          target: 'pino/file',
          options: { destination: 1, colorize: true, translateTime: 'SYS:HH:MM:ss' },
        },
      }
    : {}),
});

/**
 * Returns the process-wide toolkit logger.
 */
export function logger(): ToolkitLogger {
  return root;
}

/**
 * Creates a child logger scoped to a module (e.g. `moduleLogger('pumpfun')`).
 */
export function moduleLogger(module: string, extra: Record<string, unknown> = {}): ToolkitLogger {
  return root.child({ module, ...extra });
}
