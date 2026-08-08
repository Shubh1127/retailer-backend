/**
 * Minimal scoped logger.
 *
 * Long-running sync jobs need to say what they are doing without a logging
 * framework being dragged in. Level comes from LOG_LEVEL (debug|info|warn|error|
 * silent), defaulting to info. Structured metadata is appended as JSON so lines
 * stay greppable.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function configuredLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return (raw in RANK ? raw : 'info') as LogLevel;
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

function format(scope: string, message: string, meta?: Record<string, unknown>): string {
  const suffix =
    meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  return `[${scope}] ${message}${suffix}`;
}

export function createLogger(scope: string): Logger {
  const enabled = (level: LogLevel) => RANK[level] >= RANK[configuredLevel()];

  return {
    debug(message, meta) {
      if (enabled('debug')) console.debug(format(scope, message, meta));
    },
    info(message, meta) {
      if (enabled('info')) console.info(format(scope, message, meta));
    },
    warn(message, meta) {
      if (enabled('warn')) console.warn(format(scope, message, meta));
    },
    error(message, meta) {
      if (enabled('error')) console.error(format(scope, message, meta));
    },
    child(childScope) {
      return createLogger(`${scope}:${childScope}`);
    },
  };
}
