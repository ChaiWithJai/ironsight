/**
 * IndexedDB bake cache. OWNER: BAKE.
 *
 * WHAT IS AND IS NOT CACHEABLE, honestly
 * --------------------------------------
 * A baked TEXTURE is a live `WebGLTexture`; it does not survive a reload and
 * there is nothing to store. Rehydrating one would mean a readback of every
 * texture at bake time, which costs more than re-rendering the shader. So the
 * cache covers what is genuinely expensive AND genuinely serialisable: the
 * worker jobs — glyph SDFs, void-and-cluster blue noise, impulse responses,
 * mesh and navmesh buffers. On a warm dev reload that is the multi-second half.
 *
 * The key is `hash(job, payload, profile)` exactly as the architecture
 * specifies, so a profile change or a payload change invalidates without anyone
 * remembering to bump a version.
 *
 * IT NEVER HITS DURING A CAPTURE. Playwright uses a fresh browser profile per
 * run, so `tools/shoot.sh` always cold-bakes — which is deliberate: the capture
 * path, not the dev path, is what the unit ceiling is sized against.
 *
 * FAILURE MODES THIS FILE TREATS AS ROUTINE, NOT EXCEPTIONAL
 * ------------------------------------------------------------
 * A cache miss is never fatal — the bake simply runs the job and, on a
 * genuine miss, tries to persist the result for next time. Every one of the
 * following degrades to "run cold" rather than throwing:
 *
 *  - `indexedDB` missing entirely (Firefox private browsing removes the
 *    global) → `unavailable`.
 *  - `indexedDB.open()` throwing SYNCHRONOUSLY, which is how older Safari
 *    private-browsing windows report the feature is off-limits rather than
 *    failing the request asynchronously → `private-mode`.
 *  - The open request failing with `QuotaExceededError` (storage pressure,
 *    or a Safari private window whose IndexedDB quota is effectively zero)
 *    → `quota-exceeded`.
 *  - The open request failing with an error that indicates the on-disk store
 *    itself is unusable (seen in the wild after a crashed tab) → one-shot
 *    `deleteDatabase` + reopen, reported as `recovered-corrupt` on success or
 *    `unavailable` if even that fails.
 *  - A `put()` transaction aborting on quota → the write is dropped and
 *    further writes are skipped for the rest of this session, so a full
 *    quota costs one failed transaction rather than one per cacheable job.
 */
import { nowMs } from '@/engine/clock';
import type { BakeCacheStatus } from '@/engine/types';

const DB_NAME = 'ironsight-bake';
const DB_VERSION = 1;
const STORE = 'payloads';

/** Error names on an open/transaction request that mean "the store itself is
 * broken", as distinct from `QuotaExceededError` (storage pressure) or a
 * plain missing feature. Recoverable by deleting and recreating the database. */
const CORRUPT_ERROR_NAMES = new Set(['UnknownError', 'InvalidStateError', 'NotFoundError', 'VersionError', 'DataError']);

/** FNV-1a over the canonical JSON of the key parts. Stable across reloads. */
export function hashKey(parts: readonly unknown[]): string {
  const text = JSON.stringify(parts, (_k, v: unknown) => {
    if (v instanceof ArrayBuffer) return `ab:${v.byteLength}`;
    if (ArrayBuffer.isView(v)) {
      const view = v as ArrayBufferView;
      // Hash the CONTENT of small views and only the length of large ones: a
      // 4 MB payload would cost more to stringify than the job costs to run.
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      if (bytes.length <= 4096) return Array.from(bytes).join(',');
      let acc = 0;
      for (let i = 0; i < bytes.length; i += 97) acc = (acc * 31 + bytes[i]) >>> 0;
      return `tv:${bytes.length}:${acc}`;
    }
    return v;
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}-${text.length.toString(16)}`;
}

export interface BakeCacheStats {
  readonly status: BakeCacheStatus;
  readonly hits: number;
  readonly misses: number;
  /** Total ms spent in `get()` lookups that resolved as hits (IDB read latency). */
  readonly hitMs: number;
  /** Total ms spent in `get()` lookups that resolved as misses. */
  readonly missMs: number;
  readonly putFailures: number;
}

export class BakeCache {
  private db: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase | null> | null = null;
  private hitCount = 0;
  private missCount = 0;
  private hitMsTotal = 0;
  private missMsTotal = 0;
  private putFailureCount = 0;
  private recoveryAttempted = false;
  /** Set once a write aborts on quota — no point retrying a doomed put on
   * every subsequent cacheable job in the same session. */
  private writesDisabled = false;
  private statusValue: BakeCacheStatus;

  constructor(private readonly enabled: boolean) {
    this.statusValue = enabled ? 'ok' : 'disabled';
  }

  get hits(): number {
    return this.hitCount;
  }

  get stats(): BakeCacheStats {
    return {
      status: this.statusValue,
      hits: this.hitCount,
      misses: this.missCount,
      hitMs: this.hitMsTotal,
      missMs: this.missMsTotal,
      putFailures: this.putFailureCount,
    };
  }

  private open(allowRecovery = true): Promise<IDBDatabase | null> {
    if (!this.enabled) return Promise.resolve(null);
    if (typeof indexedDB === 'undefined') {
      this.statusValue = 'unavailable';
      return Promise.resolve(null);
    }
    if (this.db) return Promise.resolve(this.db);
    if (this.opening) return this.opening;
    this.opening = new Promise<IDBDatabase | null>((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch {
        // The synchronous-throw case: older Safari private-browsing windows
        // report "no IndexedDB for you" this way instead of failing the
        // request, which is the one signal reliable enough to label
        // `private-mode` rather than the catch-all `unavailable`.
        this.statusValue = 'private-mode';
        this.opening = null;
        resolve(null);
        return;
      }
      request.onupgradeneeded = (): void => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = (): void => {
        this.db = request.result;
        // Another tab/version upgrading out from under us invalidates the
        // handle; drop it so the next open() call gets a fresh one instead
        // of transacting against a closed connection.
        this.db.onversionchange = (): void => {
          this.db?.close();
          this.db = null;
        };
        if (this.statusValue !== 'recovered-corrupt') this.statusValue = 'ok';
        this.opening = null;
        resolve(this.db);
      };
      request.onerror = (): void => {
        const name = request.error?.name;
        this.opening = null;
        if (name === 'QuotaExceededError') {
          this.statusValue = 'quota-exceeded';
          resolve(null);
          return;
        }
        if (allowRecovery && !this.recoveryAttempted && name !== undefined && CORRUPT_ERROR_NAMES.has(name)) {
          this.recoveryAttempted = true;
          resolve(this.recover());
          return;
        }
        this.statusValue = 'unavailable';
        resolve(null);
      };
      request.onblocked = (): void => {
        this.opening = null;
        this.statusValue = 'unavailable';
        resolve(null);
      };
    });
    return this.opening;
  }

  /**
   * One-shot repair: delete the database and open it fresh. A store that
   * opens (or upgrades) but then errors on every access is rare but not
   * hypothetical — it is the shape a crashed tab or a corrupted profile
   * leaves behind. Deleting turns "this cache fails forever" into "this
   * cache is empty and works again," which costs one cold bake, not every
   * bake from here on.
   */
  private recover(): Promise<IDBDatabase | null> {
    return new Promise<IDBDatabase | null>((resolve) => {
      let del: IDBOpenDBRequest;
      try {
        del = indexedDB.deleteDatabase(DB_NAME);
      } catch {
        this.statusValue = 'unavailable';
        resolve(null);
        return;
      }
      const retry = (): void => {
        this.open(false).then((db) => {
          this.statusValue = db ? 'recovered-corrupt' : 'unavailable';
          resolve(db);
        });
      };
      del.onsuccess = retry;
      del.onerror = retry;
      del.onblocked = retry;
    });
  }

  async get<T>(key: string): Promise<T | undefined> {
    const t0 = nowMs();
    const db = await this.open();
    if (!db) return undefined;
    return new Promise<T | undefined>((resolve) => {
      const recordMiss = (): void => {
        this.missCount++;
        this.missMsTotal += nowMs() - t0;
      };
      try {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = (): void => {
          if (req.result !== undefined) {
            this.hitCount++;
            this.hitMsTotal += nowMs() - t0;
          } else {
            recordMiss();
          }
          resolve(req.result as T | undefined);
        };
        req.onerror = (): void => {
          recordMiss();
          resolve(undefined);
        };
      } catch {
        recordMiss();
        resolve(undefined);
      }
    });
  }

  async put(key: string, value: unknown): Promise<void> {
    if (this.writesDisabled) return;
    const db = await this.open();
    if (!db) return;
    return new Promise<void>((resolve) => {
      // A failing request fires BOTH `transaction.onerror` (the request's
      // error propagating unhandled) AND the `abort` that follows it — a
      // `settled` guard is what keeps one real failure from being counted,
      // and `resolve()`d, twice.
      let settled = false;
      const fail = (name: string | undefined): void => {
        if (settled) return;
        settled = true;
        this.onPutFailure(name);
        resolve();
      };
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value as never, key);
        tx.oncomplete = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        tx.onerror = (): void => fail(tx.error?.name);
        tx.onabort = (): void => fail(tx.error?.name);
      } catch {
        fail(undefined);
      }
    });
  }

  private onPutFailure(name: string | undefined): void {
    this.putFailureCount++;
    if (name === 'QuotaExceededError') {
      this.statusValue = 'quota-exceeded';
      this.writesDisabled = true;
    }
  }
}
