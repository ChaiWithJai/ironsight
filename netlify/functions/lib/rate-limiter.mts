/**
 * In-process token-bucket rate limiter.
 *
 * Netlify's declarative `config.rateLimit` (see `worlds.mts`) is enforced at
 * the edge, ahead of the function, aggregated only by `domain`/`ip`, and
 * applies the same window to every method the function handles. It cannot
 * see the request body, the learner cookie, or which route within the
 * function is being hit, so it cannot tell a cheap `GET` from an expensive
 * `POST` that writes to Postgres and Blobs, and it cannot slow down a single
 * learner who rotates IPs. It also cannot be exercised from a unit test: it
 * only exists once traffic reaches Netlify's infrastructure.
 *
 * This module is the function-level backstop: real, synchronously testable
 * limiting keyed however the caller likes (by IP, by learner cookie, by
 * route), scoped to a single warm function instance. It complements the
 * platform limit; it does not replace it, and it is not a substitute for a
 * shared/distributed limiter if the workload ever needs one across
 * concurrently warm instances.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Tokens left in the bucket after this attempt (never negative). */
  readonly remaining: number;
  /** Milliseconds the caller should wait before retrying. Zero when allowed. */
  readonly retryAfterMs: number;
}

export interface RateLimiterOptions {
  /** Maximum tokens the bucket can hold (i.e. burst size / requests per window). */
  readonly capacity: number;
  /** Milliseconds to fully refill an empty bucket. */
  readonly windowMs: number;
  /** Injectable clock so tests can drive time deterministically. */
  readonly now?: () => number;
  /** Upper bound on tracked keys before idle ones are evicted. */
  readonly maxEntries?: number;
}

export interface RateLimiter {
  consume(key: string): RateLimitDecision;
  reset(): void;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { capacity, windowMs, now = () => Date.now(), maxEntries = 5_000 } = options;
  if (capacity <= 0) throw new Error('rate limiter capacity must be positive');
  if (windowMs <= 0) throw new Error('rate limiter windowMs must be positive');
  const refillPerMs = capacity / windowMs;
  const buckets = new Map<string, Bucket>();

  function evictStale(t: number): void {
    if (buckets.size < maxEntries) return;
    for (const [key, bucket] of buckets) {
      if (bucket.tokens >= capacity && t - bucket.updatedAt >= windowMs) buckets.delete(key);
      if (buckets.size < maxEntries) return;
    }
    // Still over budget: drop the oldest entries outright rather than grow unbounded.
    if (buckets.size >= maxEntries) {
      const oldest = [...buckets.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      for (const [key] of oldest.slice(0, Math.ceil(maxEntries * 0.1))) buckets.delete(key);
    }
  }

  function consume(key: string): RateLimitDecision {
    const t = now();
    let bucket = buckets.get(key);
    if (!bucket) {
      evictStale(t);
      bucket = { tokens: capacity, updatedAt: t };
      buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, t - bucket.updatedAt);
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
      bucket.updatedAt = t;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }
    const missing = 1 - bucket.tokens;
    return { allowed: false, remaining: 0, retryAfterMs: Math.ceil(missing / refillPerMs) };
  }

  function reset(): void {
    buckets.clear();
  }

  return { consume, reset };
}
