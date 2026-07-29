import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

// Force the local server driver before the SDK loads so this suite runs against
// its isolated Postgres-compatible test server, never a provisioned deployment.
process.env.NETLIFY_DB_DRIVER = 'server';
const { NetlifyDB } = await import('@netlify/database-dev');
const { default: pg } = await import('pg');
const { waddler } = await import('waddler/node-postgres');
const { createRunRepository } = await import('../../netlify/functions/lib/run-store.mts');
const { createRunsHandler } = await import('../../netlify/functions/runs.mts');

let localDatabase;
let handler;
let database;
const blobs = new Map();

const COURSE_VERSION = 'chronicle-test-1';

before(async () => {
  localDatabase = new NetlifyDB({ logger: () => {} });
  const localConnection = new URL(await localDatabase.start());
  localConnection.username = 'netlify_test';
  const connectionString = localConnection.href;
  await localDatabase.applyMigrations('./netlify/database/migrations');
  const pool = new pg.Pool({ connectionString });
  database = { driver: 'server', sql: waddler({ client: pool }), pool, connectionString };
  const evidenceStore = {
    async set(key, value, options) {
      assert.equal(options?.onlyIfNew, true);
      if (blobs.has(key)) throw new Error('duplicate immutable blob');
      blobs.set(key, value);
      return { modified: true, etag: 'test' };
    },
  };
  handler = createRunsHandler(createRunRepository(database, evidenceStore));
});

after(async () => {
  await database?.pool.end();
  await localDatabase?.stop();
});

/** Drives the handler, threading the learner cookie the way a browser would. */
function client() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    set cookie(value) {
      cookie = value;
    },
    async call(method, path, body, params = {}) {
      const headers = { 'content-type': 'application/json' };
      if (cookie) headers.cookie = cookie;
      const init = { method, headers };
      if (body !== undefined) init.body = JSON.stringify(body);
      const response = await handler(new Request(`http://local.test${path}`, init), { params });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return response;
    },
  };
}

test('start mints a session and creates a run; a second start resumes it', async () => {
  const c = client();
  const created = await c.call('POST', '/api/v1/runs', { courseVersion: COURSE_VERSION });
  assert.equal(created.status, 201);
  assert.match(c.cookie, /^ironsight_learner=/);
  const first = (await created.json()).run;
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.equal(first.status, 'active');
  assert.equal(first.resumed, false);

  const resumed = await c.call('POST', '/api/v1/runs', { courseVersion: COURSE_VERSION });
  assert.equal(resumed.status, 200);
  const second = (await resumed.json()).run;
  assert.equal(second.id, first.id, 'resume returns the same active run, never a fork');
  assert.equal(second.resumed, true);
});

test('attempts are ordered, idempotent, and export immutable evidence', async () => {
  const c = client();
  const run = (await (await c.call('POST', '/api/v1/runs', { courseVersion: COURSE_VERSION })).json()).run;
  const idem = crypto.randomUUID();
  const payload = {
    missionId: 'seed',
    idempotencyKey: idem,
    evaluatorVersion: 'seed@2026-07-29',
    passed: true,
    evidence: { seedChanged: true, pixelDiff: 0 },
  };

  const first = await c.call('POST', `/api/v1/runs/${run.id}/attempts`, payload, { id: run.id });
  assert.equal(first.status, 201);
  const a1 = (await first.json()).attempt;
  assert.equal(a1.attemptNumber, 1);
  assert.equal(a1.passed, true);
  assert.equal(a1.evaluatorVersion, 'seed@2026-07-29');
  assert.equal(a1.evidenceStatus, 'stored');
  assert.ok(a1.evidenceBytes > 0 && a1.evidenceSha256.length === 64);
  assert.ok(blobs.has(a1.evidenceBlobKey), 'evidence exported to an immutable Blob');

  // Replaying the same idempotency key returns the original, not a duplicate.
  const replay = await c.call('POST', `/api/v1/runs/${run.id}/attempts`, payload, { id: run.id });
  assert.equal(replay.status, 200);
  const replayed = (await replay.json()).attempt;
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.id, a1.id);

  // A genuinely new submit for the same mission increments the attempt number.
  const second = await c.call(
    'POST',
    `/api/v1/runs/${run.id}/attempts`,
    { ...payload, idempotencyKey: crypto.randomUUID(), passed: false, evidence: { seedChanged: false } },
    { id: run.id },
  );
  assert.equal(second.status, 201);
  assert.equal((await second.json()).attempt.attemptNumber, 2);

  const rows = await database.sql`SELECT COUNT(*)::int AS n FROM mission_attempts WHERE run_id = ${run.id}`;
  assert.equal(rows[0].n, 2, 'exactly two rows despite three POSTs');
});

test('reflections carry prompt/rubric versions, edit in place, and cap size', async () => {
  const c = client();
  const run = (await (await c.call('POST', '/api/v1/runs', { courseVersion: COURSE_VERSION })).json()).run;

  const saved = await c.call(
    'POST',
    `/api/v1/runs/${run.id}/reflections`,
    {
      promptId: 'gate',
      promptVersion: 'gate-prompt@1',
      rubricVersion: 'gate-rubric@1',
      evaluatorVersion: 'gate@2026-07-29',
      response: 'The gate proves the world stays reproducible.',
      rubric: { criteria: ['reproducibility'] },
    },
    { id: run.id },
  );
  assert.equal(saved.status, 201);
  const r1 = (await saved.json()).reflection;
  assert.equal(r1.promptVersion, 'gate-prompt@1');
  assert.equal(r1.rubricVersion, 'gate-rubric@1');

  const edited = await c.call(
    'POST',
    `/api/v1/runs/${run.id}/reflections`,
    { promptId: 'gate', promptVersion: 'gate-prompt@2', response: 'A refined explanation.' },
    { id: run.id },
  );
  assert.equal(edited.status, 201);
  assert.equal((await edited.json()).reflection.promptVersion, 'gate-prompt@2');

  const rows = await database.sql`SELECT COUNT(*)::int AS n FROM reflections WHERE run_id = ${run.id}`;
  assert.equal(rows[0].n, 1, 'edit-in-place keeps one row per prompt');

  const tooLong = await c.call(
    'POST',
    `/api/v1/runs/${run.id}/reflections`,
    { promptId: 'seed', promptVersion: 'p@1', response: 'x'.repeat(5000) },
    { id: run.id },
  );
  assert.equal(tooLong.status, 422);
  assert.equal((await tooLong.json()).code, 'INVALID_REFLECTION');
});

test('GET returns full run state and enforces ownership', async () => {
  const c = client();
  const run = (await (await c.call('POST', '/api/v1/runs', { courseVersion: COURSE_VERSION })).json()).run;
  await c.call(
    'POST',
    `/api/v1/runs/${run.id}/attempts`,
    { missionId: 'land', idempotencyKey: crypto.randomUUID(), evaluatorVersion: 'land@1', passed: true, evidence: { interacted: true } },
    { id: run.id },
  );

  const owner = await c.call('GET', `/api/v1/runs/${run.id}`, undefined, { id: run.id });
  assert.equal(owner.status, 200);
  const detail = (await owner.json()).run;
  assert.equal(detail.attempts.length, 1);
  assert.equal(detail.attempts[0].missionId, 'land');

  // A different valid session may not read this run.
  const intruder = client();
  intruder.cookie = `ironsight_learner=${crypto.randomUUID()}`;
  const forbidden = await intruder.call('GET', `/api/v1/runs/${run.id}`, undefined, { id: run.id });
  assert.equal(forbidden.status, 403);

  // No session at all is unauthorized, not merely forbidden.
  const anon = await handler(new Request(`http://local.test/api/v1/runs/${run.id}`), { params: { id: run.id } });
  assert.equal(anon.status, 401);
});

test('a run can be completed and rejects malformed attempts', async () => {
  const c = client();
  const run = (await (await c.call('POST', '/api/v1/runs', { courseVersion: COURSE_VERSION })).json()).run;

  const bad = await c.call('POST', `/api/v1/runs/${run.id}/attempts`, { missionId: 'seed' }, { id: run.id });
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).code, 'INVALID_ATTEMPT');

  const done = await c.call('POST', `/api/v1/runs/${run.id}/complete`, {}, { id: run.id });
  assert.equal(done.status, 200);
  assert.equal((await done.json()).run.status, 'completed');

  // After completing, starting again forks a fresh active run (the old one is
  // no longer active, so the partial unique index does not block it).
  const restart = await c.call('POST', '/api/v1/runs', { courseVersion: COURSE_VERSION });
  assert.equal(restart.status, 201);
  assert.notEqual((await restart.json()).run.id, run.id);
});
