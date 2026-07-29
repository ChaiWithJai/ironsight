import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

// Force the isolated Postgres-compatible test server (see worlds-function test).
process.env.NETLIFY_DB_DRIVER = 'server';
process.env.IRONSIGHT_MAINTENANCE_TOKEN = 'test-disposal-secret';

const { NetlifyDB } = await import('@netlify/database-dev');
const { default: pg } = await import('pg');
const { waddler } = await import('waddler/node-postgres');
const { createWorldRepository } = await import('../../netlify/functions/lib/world-store.mts');
const { createWorldsHandler } = await import('../../netlify/functions/worlds.mts');
const { createMaintenanceHandler } = await import('../../netlify/functions/maintenance.mts');

let localDatabase;
let database;
let worlds;
let maintenance;

function baseProfile(civilization) {
  return {
    civilization,
    sigil: '☀',
    era: 'The Dawn Accord',
    places: { ALPHA: 'Sun Assembly', BRAVO: 'Moon Quay', CHARLIE: 'Archive Hill' },
  };
}

function sessionCookie(response) {
  const raw = response.headers.get('set-cookie') ?? '';
  const match = raw.match(/ironsight_learner=([^;]+)/);
  return match ? `ironsight_learner=${match[1]}` : null;
}

async function publish(civilization, { cookie, supersedes, disposable } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (disposable) headers['x-ironsight-disposable'] = '1';
  const body = { profile: baseProfile(civilization) };
  if (supersedes) body.supersedes = supersedes;
  const response = await worlds(
    new Request('http://local.test/api/worlds', { method: 'POST', headers, body: JSON.stringify(body) }),
    { params: {} },
  );
  return response;
}

before(async () => {
  localDatabase = new NetlifyDB({ logger: () => {} });
  const localConnection = new URL(await localDatabase.start());
  localConnection.username = 'netlify_test';
  await localDatabase.applyMigrations('./netlify/database/migrations');
  const pool = new pg.Pool({ connectionString: localConnection.href });
  database = { driver: 'server', sql: waddler({ client: pool }), pool };
  const blobs = new Map();
  const artifacts = {
    async set(key, value, options) {
      assert.equal(options?.onlyIfNew, true);
      if (blobs.has(key)) throw new Error('duplicate immutable blob');
      blobs.set(key, value);
      return { modified: true };
    },
  };
  const repository = createWorldRepository(database, artifacts);
  worlds = createWorldsHandler(repository);
  maintenance = createMaintenanceHandler(repository);
});

after(async () => {
  await database?.pool.end();
  await localDatabase?.stop();
});

test('listing returns only the calling learner’s worlds', async () => {
  const first = await publish('Alpha One');
  const cookieA = sessionCookie(first);
  assert.ok(cookieA, 'first publish issues a session');
  await publish('Alpha Two', { cookie: cookieA });
  const otherPublish = await publish('Bravo One');
  const cookieB = sessionCookie(otherPublish);
  assert.ok(cookieB && cookieB !== cookieA, 'a second caller gets a distinct session');

  const listA = await worlds(new Request('http://local.test/api/worlds', { headers: { cookie: cookieA } }), {
    params: {},
  });
  assert.equal(listA.status, 200);
  const payloadA = await listA.json();
  const namesA = payloadA.worlds.map((w) => w.civilization).sort();
  assert.deepEqual(namesA, ['Alpha One', 'Alpha Two']);

  const listB = await worlds(new Request('http://local.test/api/worlds', { headers: { cookie: cookieB } }), {
    params: {},
  });
  const payloadB = await listB.json();
  assert.deepEqual(payloadB.worlds.map((w) => w.civilization), ['Bravo One']);

  const anon = await worlds(new Request('http://local.test/api/worlds'), { params: {} });
  assert.deepEqual((await anon.json()).worlds, [], 'no session sees nothing, never another learner');
});

test('revision publishes a new immutable world and preserves the original URL', async () => {
  const created = await publish('Origin City');
  const cookie = sessionCookie(created);
  const original = (await created.json()).world;

  const revisedResponse = await publish('Origin City Revised', { cookie, supersedes: original.id });
  assert.equal(revisedResponse.status, 201);
  const revised = (await revisedResponse.json()).world;
  assert.notEqual(revised.id, original.id, 'a revision is a new stable id/URL');
  assert.equal(revised.supersedesId, original.id);

  // The predecessor's stable URL keeps its original meaning.
  const originalRead = await worlds(new Request(`http://local.test/api/worlds/${original.id}`), {
    params: { id: original.id },
  });
  assert.equal(originalRead.status, 200);
  assert.equal((await originalRead.json()).world.profile.civilization, 'Origin City');

  const events = await database.sql`SELECT action FROM world_events WHERE world_id = ${revised.id}`;
  assert.deepEqual(events.map((e) => e.action), ['revised']);

  // A different learner cannot revise a world they do not own.
  const intruder = await publish('Intruder Revised', {
    cookie: 'ironsight_learner=11111111-1111-4111-8111-111111111111',
    supersedes: original.id,
  });
  assert.equal(intruder.status, 403);
  assert.equal((await intruder.json()).code, 'NOT_YOUR_WORLD');
});

test('withdraw retires the durable record with an audit trail and 410 read', async () => {
  const created = await publish('Retire Me');
  const cookie = sessionCookie(created);
  const world = (await created.json()).world;

  // A different owner cannot withdraw it, and the response does not leak existence.
  const foreign = await worlds(
    new Request(`http://local.test/api/worlds/${world.id}`, {
      method: 'DELETE',
      headers: { cookie: 'ironsight_learner=22222222-2222-4222-8222-222222222222' },
    }),
    { params: { id: world.id } },
  );
  assert.equal(foreign.status, 404);

  const withdrawal = await worlds(
    new Request(`http://local.test/api/worlds/${world.id}?reason=test`, {
      method: 'DELETE',
      headers: { cookie },
    }),
    { params: { id: world.id } },
  );
  assert.equal(withdrawal.status, 200);
  assert.equal((await withdrawal.json()).status, 'withdrawn');

  const read = await worlds(new Request(`http://local.test/api/worlds/${world.id}`), { params: { id: world.id } });
  assert.equal(read.status, 410);
  assert.equal((await read.json()).code, 'WORLD_WITHDRAWN');

  const events = await database.sql`
    SELECT action, reason FROM world_events WHERE world_id = ${world.id} AND action = 'withdrawn'
  `;
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'test');

  // Idempotent: a second withdrawal is reported as already-withdrawn, not an error.
  const again = await worlds(
    new Request(`http://local.test/api/worlds/${world.id}`, { method: 'DELETE', headers: { cookie } }),
    { params: { id: world.id } },
  );
  assert.equal(again.status, 200);
  assert.equal((await again.json()).code, 'ALREADY_WITHDRAWN');
});

test('disposal only removes flagged rows, requires the token, and keeps the audit', async () => {
  const disposableRes = await publish('CANARY World', { disposable: true });
  const disposable = (await disposableRes.json()).world;
  const keeperRes = await publish('Durable Keeper');
  const keeper = (await keeperRes.json()).world;

  // No token → forbidden, nothing removed.
  const noToken = await maintenance(
    new Request('http://local.test/api/maintenance/worlds', { method: 'POST', body: '{}' }),
  );
  assert.equal(noToken.status, 403);

  // Dry run reports the disposable row without deleting it.
  const preview = await maintenance(
    new Request('http://local.test/api/maintenance/worlds', {
      method: 'POST',
      headers: { authorization: 'Bearer test-disposal-secret' },
      body: JSON.stringify({ dryRun: true }),
    }),
  );
  const previewBody = await preview.json();
  assert.equal(previewBody.dryRun, true);
  assert.ok(previewBody.disposed.includes(disposable.id));
  assert.ok(!previewBody.disposed.includes(keeper.id), 'a non-disposable world is never a candidate');
  const stillThere = await database.sql`SELECT COUNT(*)::int AS c FROM worlds WHERE id = ${disposable.id}`;
  assert.equal(stillThere[0].c, 1, 'dry run deletes nothing');

  // Explicit id list including a non-disposable id: the keeper is protected.
  const real = await maintenance(
    new Request('http://local.test/api/maintenance/worlds', {
      method: 'POST',
      headers: { authorization: 'Bearer test-disposal-secret' },
      body: JSON.stringify({ ids: [disposable.id, keeper.id] }),
    }),
  );
  const realBody = await real.json();
  assert.deepEqual(realBody.disposed, [disposable.id]);

  const gone = await database.sql`SELECT COUNT(*)::int AS c FROM worlds WHERE id = ${disposable.id}`;
  assert.equal(gone[0].c, 0, 'disposable row hard-deleted');
  const kept = await database.sql`SELECT COUNT(*)::int AS c FROM worlds WHERE id = ${keeper.id}`;
  assert.equal(kept[0].c, 1, 'non-disposable row survives even when named explicitly');

  // The disposal audit outlives the hard-deleted world row.
  const audit = await database.sql`
    SELECT action, actor_kind FROM world_events WHERE world_id = ${disposable.id} AND action = 'disposed'
  `;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_kind, 'maintenance');
});
