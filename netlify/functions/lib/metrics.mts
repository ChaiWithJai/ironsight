/**
 * Learner-payload-free operational metrics for the `/api/worlds` Function.
 *
 * Emits one structured JSON log line per request (Netlify captures function
 * stdout and makes it queryable/exportable via log drains). The line records
 * *shape and timing*, never *content*: no profile fields, no cookie/session
 * id, no request body, no IP. That is a deliberate, load-bearing property —
 * do not add learner-identifying or learner-authored fields to `RequestMetric`.
 *
 * Fields:
 *  - `cold`      true on the first invocation this Function instance serves;
 *                a cheap, honest proxy for cold-start latency without needing
 *                any external timing source.
 *  - `totalMs`   wall time for the whole handler, cold or warm.
 *  - `dbMs`      time spent inside Postgres round-trips (0 if none happened,
 *                e.g. a validation error returned before persistence).
 *  - `blobMs`    time spent on the immutable Blob export attempt.
 *  - `blobAttempted` / `blobFailed` — the export is best-effort (see
 *                world-store.mts); a failed export must not fail the request,
 *                so failures are recorded here rather than surfaced as 5xx.
 *  - `instanceInvocation` — a per-container counter. It is not a global
 *                request-volume figure (each warm container has its own),
 *                but summed/counted across the structured log lines it is
 *                exactly the request-volume signal the perf ticket asks for.
 */

export interface RequestMetric {
  readonly route: '/api/worlds' | '/api/worlds/:id';
  readonly method: string;
  readonly status: number;
  readonly cold: boolean;
  readonly totalMs: number;
  readonly dbMs: number;
  readonly blobMs: number;
  readonly blobAttempted: boolean;
  readonly blobFailed: boolean;
}

export interface StoreTiming {
  dbMs: number;
  blobMs: number;
  blobAttempted: boolean;
  blobFailed: boolean;
}

export function newStoreTiming(): StoreTiming {
  return { dbMs: 0, blobMs: 0, blobAttempted: false, blobFailed: false };
}

let coldStart = true;
let instanceInvocations = 0;

/**
 * Call once per incoming request, before any work happens. Returns whether
 * this is the first request this Function instance has served (cold start)
 * and bumps the instance-scoped invocation counter.
 */
export function markInvocation(): { cold: boolean; instanceInvocation: number } {
  const cold = coldStart;
  coldStart = false;
  instanceInvocations += 1;
  return { cold, instanceInvocation: instanceInvocations };
}

/** Times an async unit of work without changing its resolved value or error. */
export async function timeAsync<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

export function recordRequestMetric(metric: RequestMetric, instanceInvocation: number): void {
  console.log(
    JSON.stringify({
      kind: 'api_request_metric',
      ts: new Date().toISOString(),
      instanceInvocation,
      route: metric.route,
      method: metric.method,
      status: metric.status,
      cold: metric.cold,
      totalMs: Math.round(metric.totalMs),
      dbMs: Math.round(metric.dbMs),
      blobMs: Math.round(metric.blobMs),
      blobAttempted: metric.blobAttempted,
      blobFailed: metric.blobFailed,
    }),
  );
}
