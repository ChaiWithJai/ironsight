import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRateLimiter } from '../../netlify/functions/lib/rate-limiter.mts';

test('allows up to capacity requests per key, then blocks with a positive retry-after', () => {
  let clock = 0;
  const limiter = createRateLimiter({ capacity: 3, windowMs: 1000, now: () => clock });

  for (let i = 0; i < 3; i += 1) {
    const decision = limiter.consume('same-ip');
    assert.equal(decision.allowed, true, `request ${i + 1} should be allowed`);
  }

  const blocked = limiter.consume('same-ip');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfterMs > 0, 'retryAfterMs should be positive once blocked');
});

test('refills over time and allows requests again after the window passes', () => {
  let clock = 0;
  const limiter = createRateLimiter({ capacity: 2, windowMs: 1000, now: () => clock });

  assert.equal(limiter.consume('k').allowed, true);
  assert.equal(limiter.consume('k').allowed, true);
  assert.equal(limiter.consume('k').allowed, false);

  clock += 1000; // a full window elapses
  const afterRefill = limiter.consume('k');
  assert.equal(afterRefill.allowed, true, 'bucket should have refilled after a full window');
});

test('tracks independent buckets per key', () => {
  let clock = 0;
  const limiter = createRateLimiter({ capacity: 1, windowMs: 1000, now: () => clock });

  assert.equal(limiter.consume('a').allowed, true);
  assert.equal(limiter.consume('a').allowed, false);
  // A different key has its own untouched bucket.
  assert.equal(limiter.consume('b').allowed, true);
});

test('reset() clears all buckets', () => {
  let clock = 0;
  const limiter = createRateLimiter({ capacity: 1, windowMs: 1000, now: () => clock });
  assert.equal(limiter.consume('a').allowed, true);
  assert.equal(limiter.consume('a').allowed, false);
  limiter.reset();
  assert.equal(limiter.consume('a').allowed, true);
});

test('rejects a non-positive capacity or window', () => {
  assert.throws(() => createRateLimiter({ capacity: 0, windowMs: 1000 }));
  assert.throws(() => createRateLimiter({ capacity: 1, windowMs: 0 }));
});
