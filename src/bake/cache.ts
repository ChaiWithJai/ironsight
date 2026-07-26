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
 */

const DB_NAME = 'ironsight-bake';
const DB_VERSION = 1;
const STORE = 'payloads';

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

export class BakeCache {
  private db: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase | null> | null = null;
  private hitCount = 0;

  constructor(private readonly enabled: boolean) {}

  get hits(): number {
    return this.hitCount;
  }

  private open(): Promise<IDBDatabase | null> {
    if (!this.enabled || typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (this.db) return Promise.resolve(this.db);
    if (this.opening) return this.opening;
    this.opening = new Promise<IDBDatabase | null>((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch {
        resolve(null);
        return;
      }
      request.onupgradeneeded = (): void => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = (): void => {
        this.db = request.result;
        resolve(this.db);
      };
      // A cache miss is never fatal: private browsing, a full quota and a
      // corrupt database all resolve to null and the bake simply runs.
      request.onerror = (): void => resolve(null);
      request.onblocked = (): void => resolve(null);
    });
    return this.opening;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const db = await this.open();
    if (!db) return undefined;
    return new Promise<T | undefined>((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = (): void => {
          if (req.result !== undefined) this.hitCount++;
          resolve(req.result as T | undefined);
        };
        req.onerror = (): void => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  }

  async put(key: string, value: unknown): Promise<void> {
    const db = await this.open();
    if (!db) return;
    return new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value as never, key);
        tx.oncomplete = (): void => resolve();
        tx.onerror = (): void => resolve();
        tx.onabort = (): void => resolve();
      } catch {
        resolve();
      }
    });
  }
}
