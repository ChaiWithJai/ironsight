import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

// Force the isolated server driver before loading the Netlify SDK, exactly as
// the worlds integration suite does, so this runs against a throwaway Postgres.
process.env.NETLIFY_DB_DRIVER = 'server';
const { NetlifyDB } = await import('@netlify/database-dev');
const { default: pg } = await import('pg');
const { waddler } = await import('waddler/node-postgres');
const { createSessionRepository } = await import('../../netlify/functions/lib/session-store.mts');
const { createSessionHandler } = await import('../../netlify/functions/session.mts');

let localDatabase;
let database;
let handler;

const CONSENT = { consent: { version: 'test-notice@1', agreed: true } };

function cookieHeaderFrom(response) {
  const setCookie = response.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/ironsight_learner=([^;]+)/);
  return match ? `ironsight_learner=${match[1]}` : null;
}

function post(path, { cookie, body, headers } = {}) {
  return handler(
    new Request(`http://local.test${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(headers ?? {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

function get(path, { cookie } = {}) {
  return handler(
    new Request(`http://local.test${path}`, { headers: cookie ? { cookie } : {} }),
  );
}

before(async () => {
  localDatabase = new NetlifyDB({ logger: () => {} });
  const localConnection = new URL(await localDatabase.start());
  localConnection.username = 'netlify_test';
  const connectionString = localConnection.href;
  await localDatabase.applyMigrations('./netlify/database/migrations');
  const pool = new pg.Pool({ connectionString });
  database = { driver: 'server', sql: waddler({ client: pool }), pool, connectionString };
  handler = createSessionHandler(createSessionRepository(database));
});

after(async () => {
  await database?.pool.end();
  await localDatabase?.stop();
});

test('bootstrap without consent is refused; with consent it issues one session', async () => {
  const refused = await post('/api/session', { body: {} });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).code, 'CONSENT_REQUIRED');

  const created = await post('/api/session', { body: CONSENT });
  assert.equal(created.status, 201);
  const cookie = cookieHeaderFrom(created);
  assert.ok(cookie, 'a session cookie is set');
  const payload = await created.json();
  assert.equal(payload.session.established, true);
  assert.equal(payload.session.isNew, true);
  assert.equal(payload.session.consentVersion, 'test-notice@1');

  // Idempotent: the same cookie returns the same learner, no duplicate row.
  const before = await database.sql`SELECT COUNT(*)::int AS count FROM anonymous_learners`;
  const again = await post('/api/session', { cookie, body: CONSENT });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).session.isNew, false);
  const afterCount = await database.sql`SELECT COUNT(*)::int AS count FROM anonymous_learners`;
  assert.equal(afterCount[0].count, before[0].count);
});

test('whoami reflects cookie presence', async () => {
  const anon = await get('/api/session');
  assert.equal((await anon.json()).session.established, false);

  const created = await post('/api/session', { body: CONSENT });
  const cookie = cookieHeaderFrom(created);
  const known = await get('/api/session', { cookie });
  assert.equal((await known.json()).session.established, true);
});

test('recovery key requires a session and enables cross-device recovery', async () => {
  const noSession = await post('/api/session/recovery-key', { body: {} });
  assert.equal(noSession.status, 401);

  const created = await post('/api/session', { body: CONSENT });
  const cookie = cookieHeaderFrom(created);
  const learnerId = (await get('/api/session', { cookie })) && cookie.split('=')[1];

  const keyResponse = await post('/api/session/recovery-key', { cookie, body: {} });
  assert.equal(keyResponse.status, 200);
  const { recoveryKey } = await keyResponse.json();
  assert.match(recoveryKey, /^[A-Za-z0-9_-]{40,100}$/);

  // Cookie loss on a fresh device: recover with only the key, no cookie.
  const recovered = await post('/api/session/recover', { body: { recoveryKey } });
  assert.equal(recovered.status, 200);
  const recoveredCookie = cookieHeaderFrom(recovered);
  assert.equal(recoveredCookie, `ironsight_learner=${learnerId}`);
  const body = await recovered.json();
  assert.equal(body.recovered, true);
  assert.equal(body.merged, null);

  const bad = await post('/api/session/recover', { body: { recoveryKey: 'x'.repeat(43) } });
  assert.equal(bad.status, 404);
});

test('recover merges an orphan anonymous session into the canonical identity', async () => {
  // Canonical learner A with a saved recovery key.
  const a = await post('/api/session', { body: CONSENT });
  const aCookie = cookieHeaderFrom(a);
  const aId = aCookie.split('=')[1];
  const { recoveryKey } = await (await post('/api/session/recovery-key', { cookie: aCookie, body: {} })).json();

  // Orphan learner B (cookie lost → new session) that authored a world.
  const b = await post('/api/session', { body: CONSENT });
  const bCookie = cookieHeaderFrom(b);
  const bId = bCookie.split('=')[1];
  const worldId = crypto.randomUUID();
  await database.sql`
    INSERT INTO worlds (id, creator_id, profile, civilization, sigil, era, alpha_name, bravo_name, charlie_name)
    VALUES (${worldId}, ${bId}, ${JSON.stringify({ x: 1 })}::jsonb, 'C', 'S', 'E', 'a', 'b', 'c')
  `;

  // B recovers A: B's world folds into A, B row disappears, cookie becomes A.
  const merged = await post('/api/session/recover', { cookie: bCookie, body: { recoveryKey } });
  assert.equal(merged.status, 200);
  assert.equal(cookieHeaderFrom(merged), `ironsight_learner=${aId}`);
  const body = await merged.json();
  assert.equal(body.merged.worlds, 1);

  const owner = await database.sql`SELECT creator_id FROM worlds WHERE id = ${worldId}`;
  assert.equal(owner[0].creator_id, aId);
  const orphan = await database.sql`SELECT COUNT(*)::int AS count FROM anonymous_learners WHERE id = ${bId}`;
  assert.equal(orphan[0].count, 0);
  const audit = await database.sql`SELECT merged_worlds FROM identity_merges WHERE canonical_id = ${aId}`;
  assert.equal(audit[0].merged_worlds, 1);
});

test('cross-site POST is blocked (CSRF defense in depth)', async () => {
  const blocked = await post('/api/session', {
    body: CONSENT,
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).code, 'CROSS_ORIGIN_BLOCKED');
});
