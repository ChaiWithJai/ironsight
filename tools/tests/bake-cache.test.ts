/**
 * Unit tests for `src/bake/cache.ts` (OWNER: BAKE).
 *
 * These exercise the IndexedDB failure modes that a real browser only shows
 * up rarely and non-deterministically — quota exhaustion, a corrupt store,
 * private-browsing's synchronous throw — by standing in a small fake
 * `indexedDB` per test. Every scenario asserts the cache degrades to "run
 * cold" rather than throwing, and that the hit/miss timing counters this
 * ticket adds are actually populated.
 *
 * Compiled by `tools/tests/compile.mjs` (via Vite/esbuild, not `tsc`) before
 * `node --test` runs it, so real TypeScript syntax — enums, parameter
 * properties, path aliases — is fair game here, unlike the plain-`.ts`
 * tests elsewhere in this directory that Node's built-in type-stripper
 * must be able to parse unassisted.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { BakeCache, hashKey } from '@/bake/cache';

/** Fires its outcome on a microtask, matching real IndexedDB's async contract. */
class FakeRequest {
  onsuccess: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  result: unknown;
  error: { name: string } | null = null;

  succeed(result: unknown): void {
    this.result = result;
    queueMicrotask(() => this.onsuccess?.({ target: this }));
  }

  /** Sets `.error` SYNCHRONOUSLY (real IDBRequest does this immediately too),
   * so a caller inspecting the request right after calling `get`/`put` sees
   * the outcome before the async callback fires. */
  fail(name: string): void {
    this.error = { name };
    queueMicrotask(() => this.onerror?.({ target: this }));
  }
}

class FakeOpenRequest extends FakeRequest {
  onupgradeneeded: ((ev: unknown) => void) | null = null;
  onblocked: ((ev: unknown) => void) | null = null;
}

type OnPut = (key: string, value: unknown) => 'ok' | 'quota';

/** A fake `IDBTransaction` whose `objectStore()` wires a `put`'s outcome
 * through to `oncomplete`/`onerror`/`onabort`, the level `BakeCache` actually
 * listens on. */
class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onabort: ((ev: unknown) => void) | null = null;
  error: { name: string } | null = null;

  constructor(
    private readonly map: Map<string, unknown>,
    private readonly onPut: OnPut | null,
  ) {}

  objectStore(_name: string) {
    const tx = this;
    return {
      get(key: string): FakeRequest {
        const req = new FakeRequest();
        req.succeed(tx.map.get(key));
        return req;
      },
      put(value: unknown, key: string): FakeRequest {
        const req = new FakeRequest();
        const outcome = tx.onPut?.(key, value) ?? 'ok';
        if (outcome === 'quota') {
          req.fail('QuotaExceededError');
          tx.error = req.error;
          queueMicrotask(() => {
            tx.onerror?.({ target: tx });
            tx.onabort?.({ target: tx });
          });
        } else {
          tx.map.set(key, value);
          req.succeed(undefined);
          queueMicrotask(() => tx.oncomplete?.());
        }
        return req;
      },
    };
  }
}

// A minimal DOMException stand-in — the two-arg `new DOMException(msg, name)`
// form exists in Node, but a plain named Error is simpler to construct and
// `BakeCache` only ever reads `.name`.
class DOMExceptionLike extends Error {
  constructor(public readonly name: string) {
    super(name);
  }
}

interface FakeDbOptions {
  /** 'ok' opens cleanly. 'corrupt-once' fails the FIRST open with a
   * recoverable error name, then succeeds after `deleteDatabase`. */
  openBehavior?: 'ok' | 'corrupt-once' | 'throw-sync';
  onPut?: OnPut;
}

/** A fake `indexedDB` global backing one logical database across opens. */
function makeFakeIndexedDb(opts: FakeDbOptions = {}) {
  const map = new Map<string, unknown>();
  let openAttempts = 0;
  let deleteCalls = 0;
  let transactionsCreated = 0;

  return {
    get transactionsCreated() {
      return transactionsCreated;
    },
    get deleteCalls() {
      return deleteCalls;
    },
    open(_name: string, _version: number): FakeOpenRequest {
      openAttempts++;
      const req = new FakeOpenRequest();
      if (opts.openBehavior === 'throw-sync') {
        throw new DOMExceptionLike('SecurityError');
      }
      if (opts.openBehavior === 'corrupt-once' && openAttempts === 1) {
        req.fail('InvalidStateError');
        return req;
      }
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => undefined,
        onversionchange: null as (() => void) | null,
        close: () => undefined,
        transaction: (_stores: string, _mode: string) => {
          transactionsCreated++;
          return new FakeTransaction(map, opts.onPut ?? null);
        },
      };
      queueMicrotask(() => req.succeed(db));
      return req;
    },
    deleteDatabase(_name: string): FakeRequest {
      deleteCalls++;
      map.clear();
      const req = new FakeRequest();
      req.succeed(undefined);
      return req;
    },
  };
}

function withFakeIdb<T>(fake: ReturnType<typeof makeFakeIndexedDb>, run: () => Promise<T>): Promise<T> {
  const previous = (globalThis as { indexedDB?: unknown }).indexedDB;
  (globalThis as { indexedDB?: unknown }).indexedDB = fake;
  return run().finally(() => {
    (globalThis as { indexedDB?: unknown }).indexedDB = previous;
  });
}

test('hashKey is stable for identical input and changes when the payload changes', () => {
  const a = hashKey(['job', { x: 1 }, 'profile']);
  const b = hashKey(['job', { x: 1 }, 'profile']);
  const c = hashKey(['job', { x: 2 }, 'profile']);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('a disabled cache reports status "disabled" and never touches indexedDB', async () => {
  const fake = makeFakeIndexedDb();
  await withFakeIdb(fake, async () => {
    const cache = new BakeCache(false);
    const value = await cache.get('k');
    assert.equal(value, undefined);
    assert.equal(cache.stats.status, 'disabled');
    assert.equal(fake.transactionsCreated, 0);
  });
});

test('a missing indexedDB global reports "unavailable" (Firefox private browsing)', async () => {
  const previous = (globalThis as { indexedDB?: unknown }).indexedDB;
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
  try {
    const cache = new BakeCache(true);
    const value = await cache.get('k');
    assert.equal(value, undefined);
    assert.equal(cache.stats.status, 'unavailable');
  } finally {
    (globalThis as { indexedDB?: unknown }).indexedDB = previous;
  }
});

test('indexedDB.open() throwing synchronously reports "private-mode" (older Safari private tabs)', async () => {
  const fake = makeFakeIndexedDb({ openBehavior: 'throw-sync' });
  await withFakeIdb(fake, async () => {
    const cache = new BakeCache(true);
    const value = await cache.get('k');
    assert.equal(value, undefined);
    assert.equal(cache.stats.status, 'private-mode');
  });
});

test('a clean round trip is a miss then a hit, and records hit/miss timing', async () => {
  const fake = makeFakeIndexedDb();
  await withFakeIdb(fake, async () => {
    const cache = new BakeCache(true);
    const first = await cache.get<number>('k');
    assert.equal(first, undefined);
    await cache.put('k', 42);
    const second = await cache.get<number>('k');
    assert.equal(second, 42);

    const stats = cache.stats;
    assert.equal(stats.status, 'ok');
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
    assert.ok(stats.hitMs >= 0, 'hitMs should be a non-negative measured duration');
    assert.ok(stats.missMs >= 0, 'missMs should be a non-negative measured duration');
    assert.equal(cache.hits, 1);
  });
});

test('a quota-exceeded write fails once, is reported, and disables further writes this session', async () => {
  const fake = makeFakeIndexedDb({ onPut: () => 'quota' });
  await withFakeIdb(fake, async () => {
    const cache = new BakeCache(true);
    await cache.put('a', 1);
    await cache.put('b', 2); // should be skipped — writesDisabled after the first failure

    const stats = cache.stats;
    assert.equal(stats.status, 'quota-exceeded');
    assert.equal(stats.putFailures, 1, 'only the first put should reach the failing transaction');

    // Reads still work — quota affects writes, not the ability to serve
    // whatever is already cached.
    const value = await cache.get('k');
    assert.equal(value, undefined);
  });
});

test('a corrupt store recovers via one-shot delete + reopen and reports "recovered-corrupt"', async () => {
  const fake = makeFakeIndexedDb({ openBehavior: 'corrupt-once' });
  await withFakeIdb(fake, async () => {
    const cache = new BakeCache(true);
    const value = await cache.get('k');
    assert.equal(value, undefined);
    assert.equal(cache.stats.status, 'recovered-corrupt');
    assert.equal(fake.deleteCalls, 1);

    // The recovered database is fully usable afterwards.
    await cache.put('k', 'v');
    const hit = await cache.get<string>('k');
    assert.equal(hit, 'v');
    assert.equal(cache.stats.status, 'recovered-corrupt');
  });
});
