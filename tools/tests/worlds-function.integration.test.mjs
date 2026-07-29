import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { NetlifyDB } from '@netlify/database-dev';

// Netlify's build environment injects the production serverless driver. Clear
// it before loading the SDK so this suite always uses its isolated local server.
delete process.env.NETLIFY_DB_DRIVER;
const { getDatabase } = await import('@netlify/database');
const { createWorldRepository } = await import('../../netlify/functions/lib/world-store.mts');
const { createWorldsHandler } = await import('../../netlify/functions/worlds.mts');

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
  const connectionString = await localDatabase.start();
  await localDatabase.applyMigrations('./netlify/database/migrations');
  database = getDatabase({ connectionString });
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
