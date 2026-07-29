/**
 * Offline-first course-progress sync — the browser half of the course-runs API.
 *
 * This is a deliberate, named network seam, exactly like `world-publication.ts`:
 * the academy is a zero-backend JAMStack app by default, and durable progress
 * must *enhance* it, never gate it. Every method here is fire-and-forget. The
 * academy's own `localStorage` remains the source of truth for what a learner
 * has completed; this layer mirrors that progress to the server when it can and
 * silently defers when it cannot.
 *
 * Guarantees:
 *  - Nothing here ever throws into the caller. A dead network, a 5xx, a cold
 *    database — the academy is unaffected.
 *  - Work survives reloads. Runs and a queue of unsynced attempts/reflections
 *    live in `localStorage`, each tagged with a stable idempotency key, so a
 *    flush after a crash or offline spell replays without creating duplicates.
 *  - No wall-clock reads and no work at all in `?frozen` capture mode, so the
 *    academy's deterministic shots never touch the network.
 */

const RUN_KEY = 'ironsight-course-run-v1';
const QUEUE_KEY = 'ironsight-course-queue-v1';
const MAX_QUEUE = 200; // a hard cap so a permanently-offline tab cannot grow without bound

export type ProgressEvidence = Record<string, number | string | boolean>;

export interface AttemptRecord {
  readonly missionId: string;
  readonly evaluatorVersion: string;
  readonly passed: boolean;
  readonly evidence: ProgressEvidence;
}

export interface ReflectionRecord {
  readonly promptId: string;
  readonly promptVersion: string;
  readonly rubricVersion?: string;
  readonly evaluatorVersion?: string;
  readonly response: string;
  readonly rubric?: unknown;
}

interface QueuedAttempt extends AttemptRecord {
  readonly kind: 'attempt';
  readonly idempotencyKey: string;
}
interface QueuedReflection extends ReflectionRecord {
  readonly kind: 'reflection';
  readonly idempotencyKey: string;
}
type Queued = QueuedAttempt | QueuedReflection;

export interface ProgressProbe {
  enabled: boolean;
  runId: string | null;
  queued: number;
  syncing: boolean;
  lastError: string | null;
}

export interface CourseProgressSync {
  /** Start or resume the learner's run. Safe to call repeatedly. */
  ensureRun(): void;
  recordAttempt(attempt: AttemptRecord): void;
  recordReflection(reflection: ReflectionRecord): void;
  /** Best-effort drain of the queue. Never rejects. */
  flush(): Promise<void>;
  readonly probe: ProgressProbe;
}

export interface CourseProgressOptions {
  readonly courseVersion: string;
  /** Optional durable world id to attribute this run to. */
  readonly worldId?: string | null;
  /** Disable all networking (capture/frozen mode, SSR, tests). */
  readonly disabled?: boolean;
  readonly fetcher?: typeof fetch;
  readonly storage?: Storage;
}

function readJson<T>(storage: Storage, key: string, fallback: T): T {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(storage: Storage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable — progress simply stays un-mirrored */
  }
}

/**
 * A no-op sync for when persistence is disabled. Keeps call sites branch-free.
 */
function inertSync(): CourseProgressSync {
  const probe: ProgressProbe = { enabled: false, runId: null, queued: 0, syncing: false, lastError: null };
  return {
    ensureRun() {},
    recordAttempt() {},
    recordReflection() {},
    async flush() {},
    probe,
  };
}

export function createCourseProgressSync(options: CourseProgressOptions): CourseProgressSync {
  const hasWindow = typeof window !== 'undefined' && typeof localStorage !== 'undefined';
  if (options.disabled || !hasWindow) return inertSync();

  const fetcher = options.fetcher ?? fetch;
  const storage = options.storage ?? localStorage;
  const { courseVersion } = options;
  const worldId = options.worldId ?? null;

  const stored = readJson<{ runId: string | null; courseVersion: string }>(storage, RUN_KEY, {
    runId: null,
    courseVersion,
  });
  // A run id is only valid for the course version that created it.
  let runId = stored.courseVersion === courseVersion ? stored.runId : null;
  let queue = readJson<Queued[]>(storage, QUEUE_KEY, []);
  let syncing = false;
  let starting: Promise<void> | null = null;

  const probe: ProgressProbe = {
    enabled: true,
    runId,
    queued: queue.length,
    syncing: false,
    lastError: null,
  };

  function persistRun(): void {
    writeJson(storage, RUN_KEY, { runId, courseVersion });
    probe.runId = runId;
  }
  function persistQueue(): void {
    if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE);
    writeJson(storage, QUEUE_KEY, queue);
    probe.queued = queue.length;
  }

  async function startRun(): Promise<void> {
    if (runId) return;
    if (starting) return starting;
    starting = (async () => {
      try {
        const response = await fetcher('/api/v1/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(worldId ? { courseVersion, worldId } : { courseVersion }),
        });
        if (!response.ok) throw new Error(`start failed (${response.status})`);
        const payload: unknown = await response.json().catch(() => null);
        const id = (payload as { run?: { id?: unknown } } | null)?.run?.id;
        if (typeof id === 'string') {
          runId = id;
          persistRun();
          probe.lastError = null;
        }
      } catch (error) {
        probe.lastError = error instanceof Error ? error.message : String(error);
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  async function send(item: Queued): Promise<'done' | 'drop' | 'retry'> {
    const base = `/api/v1/runs/${encodeURIComponent(runId as string)}`;
    const url = item.kind === 'attempt' ? `${base}/attempts` : `${base}/reflections`;
    const body =
      item.kind === 'attempt'
        ? {
            missionId: item.missionId,
            idempotencyKey: item.idempotencyKey,
            evaluatorVersion: item.evaluatorVersion,
            passed: item.passed,
            evidence: item.evidence,
          }
        : {
            promptId: item.promptId,
            promptVersion: item.promptVersion,
            rubricVersion: item.rubricVersion,
            evaluatorVersion: item.evaluatorVersion,
            response: item.response,
            rubric: item.rubric,
          };
    try {
      const response = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.ok) return 'done';
      // 4xx (except 429) means the item can never succeed as-is — drop it so it
      // does not wedge the queue. 401/403/404/429/5xx are transient here.
      if (response.status >= 400 && response.status < 500 && ![401, 403, 404, 429].includes(response.status)) {
        return 'drop';
      }
      return 'retry';
    } catch {
      return 'retry';
    }
  }

  async function flush(): Promise<void> {
    if (syncing) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    syncing = true;
    probe.syncing = true;
    try {
      if (!runId) await startRun();
      if (!runId) return; // still no run — try again on the next trigger
      while (queue.length > 0) {
        const item = queue[0];
        const outcome = await send(item);
        if (outcome === 'retry') break; // stop on the first transient failure, preserve order
        queue = queue.slice(1);
        persistQueue();
        if (outcome === 'drop') probe.lastError = `dropped un-sendable ${item.kind}`;
        else probe.lastError = null;
      }
    } finally {
      syncing = false;
      probe.syncing = false;
    }
  }

  function enqueue(item: Queued): void {
    queue = [...queue, item];
    persistQueue();
    void flush();
  }

  // Retry whenever connectivity returns.
  window.addEventListener('online', () => void flush());

  return {
    ensureRun() {
      void startRun().then(() => flush());
    },
    recordAttempt(attempt) {
      enqueue({ kind: 'attempt', idempotencyKey: crypto.randomUUID(), ...attempt });
    },
    recordReflection(reflection) {
      enqueue({ kind: 'reflection', idempotencyKey: crypto.randomUUID(), ...reflection });
    },
    flush,
    probe,
  };
}
