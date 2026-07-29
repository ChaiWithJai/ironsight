/**
 * Structured, privacy-safe logging for the teaching-platform Functions.
 *
 * Every log line is a single JSON object on one line so Netlify's function log
 * viewer (and any downstream log drain) can parse it without a custom grok
 * rule. See docs/OBSERVABILITY.md for the metrics/dashboard decision and the
 * PII policy this module enforces.
 *
 * Two rules this file exists to guarantee:
 *   1. No PII. Cookies, IPs, raw learner ids, authored world text, and request
 *      bodies never reach a log line. `sanitize` redacts known-sensitive keys
 *      as a backstop, callers stay disciplined, and learner identity is only
 *      ever logged as an irreversible `pseudonym()`.
 *   2. One correlation id per request. `requestIdFrom` reuses the platform's
 *      request id when present so a single line in the Netlify log lines up with
 *      the CDN access log, and the same id is echoed back in `x-request-id`.
 */
import { createHash, randomUUID } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
  readonly requestId: string;
  /** Derive a logger that carries additional base fields on every line. */
  child(fields: LogFields): Logger;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /**
   * Time an async operation, emitting one line with `durationMs` on success
   * (default `debug`) and one `error` line if it throws. The original value or
   * error is passed through unchanged.
   */
  time<T>(event: string, fn: () => Promise<T>, fields?: LogFields): Promise<T>;
}

export interface LoggerOptions {
  requestId: string;
  service?: string;
  base?: LogFields;
  /** Override the output sink. Defaults to stdout/stderr by level. */
  sink?: LogSink;
  /** Override the clock. Defaults to `Date.now`. Injected for tests. */
  now?: () => number;
}

export type LogSink = (level: LogLevel, line: string) => void;

/**
 * Keys that must never appear verbatim in a log line, matched case-insensitively
 * at any depth. This is a backstop, not the primary defence — callers are
 * expected not to hand these to the logger in the first place.
 */
const REDACT_KEYS = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'auth',
  'ip',
  'x-forwarded-for',
  'password',
  'token',
  'secret',
  'email',
  'profile',
  'body',
  'payload',
  'response',
]);

const MAX_STRING = 512;
const MAX_DEPTH = 4;
const MAX_ARRAY = 32;

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    // Name + message only. Stacks are noisy and can carry filesystem paths.
    return { name: value.name, message: value.message };
  }
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => sanitize(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACT_KEYS.has(key.toLowerCase()) ? '[redacted]' : sanitize(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

const LEVEL_STREAM: Record<LogLevel, 'stdout' | 'stderr'> = {
  debug: 'stdout',
  info: 'stdout',
  warn: 'stderr',
  error: 'stderr',
};

const defaultSink: LogSink = (level, line) => {
  const stream = LEVEL_STREAM[level] === 'stderr' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};

export function createLogger(options: LoggerOptions): Logger {
  const { requestId, service, base = {}, sink = defaultSink, now = Date.now } = options;

  function emit(level: LogLevel, event: string, fields?: LogFields): void {
    const record: Record<string, unknown> = {
      ts: new Date(now()).toISOString(),
      level,
      event,
      requestId,
    };
    if (service) record.service = service;
    const merged = sanitize({ ...base, ...(fields ?? {}) }) as Record<string, unknown>;
    Object.assign(record, merged);
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: record.ts, level: 'error', event: 'log.serialize_failed', requestId });
    }
    sink(level, line);
  }

  const logger: Logger = {
    requestId,
    child(fields) {
      return createLogger({ requestId, service, base: { ...base, ...fields }, sink, now });
    },
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    async time(event, fn, fields) {
      const startedAt = now();
      try {
        const result = await fn();
        emit('debug', event, { ...fields, ok: true, durationMs: now() - startedAt });
        return result;
      } catch (error) {
        emit('error', event, { ...fields, ok: false, durationMs: now() - startedAt, error });
        throw error;
      }
    },
  };
  return logger;
}

/** A logger that discards everything. Default for un-instrumented callers. */
export function silentLogger(requestId = 'silent'): Logger {
  return createLogger({ requestId, sink: () => {} });
}

const REQUEST_ID_HEADERS = ['x-request-id', 'x-nf-request-id', 'x-correlation-id'];
const REQUEST_ID_SHAPE = /^[\w.:+/=-]{1,200}$/;

/**
 * The correlation id for a request: reuse a caller/platform-supplied id when it
 * is well-formed, otherwise mint one. Untrusted header values are shape-checked
 * so a hostile client cannot inject newlines or huge strings into the logs.
 */
export function requestIdFrom(request: Request): string {
  for (const header of REQUEST_ID_HEADERS) {
    const value = request.headers.get(header);
    if (value && REQUEST_ID_SHAPE.test(value)) return value;
  }
  return randomUUID();
}

/**
 * An irreversible, stable pseudonym for a raw identifier (e.g. the anonymous
 * learner cookie). Lets two log lines be correlated to the same learner within
 * a retention window without ever writing the real id.
 */
export function pseudonym(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
