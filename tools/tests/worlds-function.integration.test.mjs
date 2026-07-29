import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

// Netlify's build environment injects the production serverless driver. Force
// the server driver before loading the SDK so this suite stays on its isolated
// Postgres-compatible test server instead of the provisioned deployment DB.
process.env.NETLIFY_DB_DRIVER = 'server';
const { NetlifyDB } = await import('@netlify/database-dev');
const { default: pg } = await import('pg');
const { waddler } = await import('waddler/node-postgres');
const { createWorldRepository } = await import('../../netlify/functions/lib/world-store.mts');
const { createWorldsHandler, createWorldsRateLimiters } = await import('../../netlify/functions/worlds.mts');

let localDatabase;
let handler;
let database;
const blobs = new Map();

const profile = {
  civilization: 'City of Many Rivers',
  sigil: '☀',
  era: 'The Dawn Accord',
  places: {
    ALPHA: 'Sun Assembly',
    BRAVO: 'Moon Quay',
    CHARLIE: 'Archive Hill',
  },
};

before(async () => {
  localDatabase = new NetlifyDB({ logger: () => {} });
  const localConnection = new URL(await localDatabase.start());
  localConnection.username = 'netlify_test';
  const connectionString = localConnection.href;
  await localDatabase.applyMigrations('./netlify/database/migrations');
  const pool = new pg.Pool({ connectionString });
  database = {
    driver: 'server',
    sql: waddler({ client: pool }),
    pool,
    connectionString,
  };
  const artifacts = {
    async set(key, value, options) {
      assert.equal(options?.onlyIfNew, true);
      if (blobs.has(key)) throw new Error('duplicate immutable blob');
      blobs.set(key, value);
      return { modified: true, etag: 'test' };
    },
  };
  handler = createWorldsHandler(createWorldRepository(database, artifacts));
});

after(async () => {
  await database?.pool.end();
  await localDatabase?.stop();
});

test('POST validates, issues an anonymous session, writes Postgres and exports a Blob', async () => {
  const response = await handler(
    new Request('http://local.test/api/worlds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile }),
    }),
    { params: {} },
  );
  assert.equal(response.status, 201);
  assert.match(response.headers.get('set-cookie') ?? '', /^ironsight_learner=/);
  const payload = await response.json();
  assert.match(payload.world.id, /^[0-9a-f-]{36}$/);
  assert.equal(payload.world.profile.civilization, profile.civilization);
  assert.match(payload.playUrl, new RegExp(`world=${payload.world.id}`));
  assert.match(payload.playUrl, /civ=City(?:\+|%20)of(?:\+|%20)Many(?:\+|%20)Rivers/);

  const rows = await database.sql`SELECT profile, artifact_blob_key FROM worlds WHERE id = ${payload.world.id}`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].profile.places.ALPHA, 'Sun Assembly');
  assert.ok(blobs.has(rows[0].artifact_blob_key));

  const getResponse = await handler(
    new Request(`http://local.test/api/worlds/${payload.world.id}`),
    { params: { id: payload.world.id } },
  );
  assert.equal(getResponse.status, 200);
  const resolved = await getResponse.json();
  assert.deepEqual(resolved.world.profile, profile);
  assert.match(getResponse.headers.get('cache-control') ?? '', /s-maxage=86400/);
});

test('invalid publication is rejected before persistence', async () => {
  const beforeRows = await database.sql`SELECT COUNT(*)::int AS count FROM worlds`;
  const response = await handler(
    new Request('http://local.test/api/worlds', {
      method: 'POST',
      body: JSON.stringify({ profile: { civilization: 'Incomplete' } }),
    }),
    { params: {} },
  );
  assert.equal(response.status, 422);
  const payload = await response.json();
  assert.equal(payload.code, 'INVALID_PROFILE');
  const afterRows = await database.sql`SELECT COUNT(*)::int AS count FROM worlds`;
  assert.equal(afterRows[0].count, beforeRows[0].count);
});

test('unknown durable ids return a truthful 404', async () => {
  const response = await handler(
    new Request('http://local.test/api/worlds/11111111-1111-4111-8111-111111111111'),
    { params: { id: '11111111-1111-4111-8111-111111111111' } },
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, 'WORLD_NOT_FOUND');
});

test('a request body over the byte cap is rejected without buffering it whole, even with no content-length', async () => {
  // Simulate a chunked/streamed body that never declares its size, so the
  // only thing standing between this and an unbounded in-memory buffer is
  // the incremental byte-counting read in readBoundedText().
  const oversized = 'x'.repeat(5_000); // over MAX_BODY_BYTES (4096)
  const stream = new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(JSON.stringify({ profile: { civilization: oversized } }));
      // Deliver it in small chunks, the way a real streamed request would.
      for (let i = 0; i < bytes.length; i += 256) {
        controller.enqueue(bytes.slice(i, i + 256));
      }
      controller.close();
    },
  });
  const request = new Request('http://local.test/api/worlds', {
    method: 'POST',
    // @ts-expect-error duplex is required by undici for streaming bodies but
    // is missing from the DOM RequestInit type this project targets.
    duplex: 'half',
    body: stream,
  });
  assert.equal(request.headers.get('content-length'), null, 'body must arrive without a declared length');

  const response = await handler(request, { params: {}, ip: 'oversized-payload-ip' });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'PAYLOAD_TOO_LARGE');
});

test('publication is rate limited per IP once its bucket is exhausted', async () => {
  const rateLimitedHandler = createWorldsHandler(
    createWorldRepository(database, { async set() { return { modified: true, etag: 'test' }; } }),
    createWorldsRateLimiters({ createByIp: { capacity: 3, windowMs: 60_000 } }),
  );
  const ip = 'spam-ip-1';
  // Deliberately invalid so nothing is persisted; only the rate gate itself
  // is under test here.
  const attempt = () =>
    rateLimitedHandler(
      new Request('http://local.test/api/worlds', {
        method: 'POST',
        body: JSON.stringify({ profile: { civilization: 'Incomplete' } }),
      }),
      { params: {}, ip },
    );

  for (let i = 0; i < 3; i += 1) {
    const response = await attempt();
    assert.equal(response.status, 422, `request ${i + 1} should reach validation, not the rate gate`);
  }

  const limited = await attempt();
  assert.equal(limited.status, 429);
  const body = await limited.json();
  assert.equal(body.code, 'RATE_LIMITED');
  assert.ok(Number(limited.headers.get('retry-after')) > 0, 'retry-after must be a positive number of seconds');
});

test('publication spam from one learner cookie is rejected even when the IP changes every request', async () => {
  const rateLimitedHandler = createWorldsHandler(
    createWorldRepository(database, { async set() { return { modified: true, etag: 'test' }; } }),
    createWorldsRateLimiters({
      createByIp: { capacity: 1_000, windowMs: 60_000 }, // effectively unlimited: isolate the per-learner gate
      createByLearner: { capacity: 3, windowMs: 60_000 },
    }),
  );
  const learnerCookie = '22222222-2222-4222-8222-222222222222';
  const attempt = (ip) =>
    rateLimitedHandler(
      new Request('http://local.test/api/worlds', {
        method: 'POST',
        headers: { cookie: `ironsight_learner=${learnerCookie}` },
        body: JSON.stringify({ profile: { civilization: 'Incomplete' } }),
      }),
      { params: {}, ip },
    );

  for (let i = 0; i < 3; i += 1) {
    const response = await attempt(`spam-ip-rotating-${i}`);
    assert.equal(response.status, 422, `request ${i + 1} should reach validation, not the rate gate`);
  }

  const limited = await attempt('spam-ip-rotating-final');
  assert.equal(limited.status, 429, 'a new IP does not reset the per-learner bucket');
  assert.equal((await limited.json()).code, 'RATE_LIMITED');
});

test('reads are rate limited per IP independently of the publication bucket', async () => {
  const artifacts = { async set() { return { modified: true, etag: 'test' }; } };
  const rateLimitedHandler = createWorldsHandler(
    createWorldRepository(database, artifacts),
    createWorldsRateLimiters({ readByIp: { capacity: 2, windowMs: 60_000 } }),
  );
  const ip = 'read-spam-ip';
  const created = await rateLimitedHandler(
    new Request('http://local.test/api/worlds', { method: 'POST', body: JSON.stringify({ profile }) }),
    { params: {}, ip },
  );
  assert.equal(created.status, 201);
  const { world } = await created.json();

  for (let i = 0; i < 2; i += 1) {
    const response = await rateLimitedHandler(
      new Request(`http://local.test/api/worlds/${world.id}`),
      { params: { id: world.id }, ip },
    );
    assert.equal(response.status, 200, `read ${i + 1} should be allowed`);
  }

  const limited = await rateLimitedHandler(
    new Request(`http://local.test/api/worlds/${world.id}`),
    { params: { id: world.id }, ip },
  );
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, 'RATE_LIMITED');
});
