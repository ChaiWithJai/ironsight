import assert from 'node:assert/strict';
import { test } from 'node:test';

const { createLogger, silentLogger, requestIdFrom, pseudonym } = await import(
  '../../netlify/functions/lib/log.mts'
);
const { observeSchema, EXPECTED_TABLES, LATEST_MIGRATION } = await import(
  '../../netlify/functions/lib/migrations.mts'
);

function capture() {
  const lines = [];
  const sink = (level, line) => lines.push({ level, record: JSON.parse(line) });
  return { lines, sink };
}

test('logger emits single-line JSON with correlation id, event, and level', () => {
  const { lines, sink } = capture();
  const log = createLogger({ requestId: 'req-1', service: 'worlds', sink, now: () => 0 });
  log.info('request.complete', { status: 200 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'info');
  assert.deepEqual(lines[0].record, {
    ts: '1970-01-01T00:00:00.000Z',
    level: 'info',
    event: 'request.complete',
    requestId: 'req-1',
    service: 'worlds',
    status: 200,
  });
});

test('logger redacts known-sensitive keys at any depth', () => {
  const { lines, sink } = capture();
  const log = createLogger({ requestId: 'r', sink });
  log.info('probe', {
    cookie: 'ironsight_learner=abc',
    profile: { civilization: 'Secret City' },
    nested: { authorization: 'Bearer xyz', keep: 'ok' },
  });
  const { record } = lines[0];
  assert.equal(record.cookie, '[redacted]');
  assert.equal(record.profile, '[redacted]');
  assert.equal(record.nested.authorization, '[redacted]');
  assert.equal(record.nested.keep, 'ok');
});

test('logger reduces Errors to name and message without a stack', () => {
  const { lines, sink } = capture();
  const log = createLogger({ requestId: 'r', sink });
  log.error('request.exception', { error: new TypeError('boom') });
  assert.deepEqual(lines[0].record.error, { name: 'TypeError', message: 'boom' });
  assert.equal(lines[0].record.error.stack, undefined);
});

test('logger truncates oversize strings', () => {
  const { lines, sink } = capture();
  const log = createLogger({ requestId: 'r', sink });
  log.info('big', { blob: 'x'.repeat(1000) });
  assert.ok(lines[0].record.blob.length <= 513);
  assert.ok(lines[0].record.blob.endsWith('…'));
});

test('time() records durationMs on success and rethrows on failure', async () => {
  const { lines, sink } = capture();
  let clock = 0;
  const log = createLogger({ requestId: 'r', sink, now: () => (clock += 5) });
  const value = await log.time('db.query', async () => 42, { worldId: 'w' });
  assert.equal(value, 42);
  assert.equal(lines[0].record.event, 'db.query');
  assert.equal(lines[0].record.ok, true);
  assert.equal(typeof lines[0].record.durationMs, 'number');

  await assert.rejects(
    () => log.time('db.query', async () => { throw new Error('nope'); }),
    /nope/,
  );
  const errorLine = lines.at(-1).record;
  assert.equal(errorLine.event, 'db.query');
  assert.equal(errorLine.ok, false);
  assert.deepEqual(errorLine.error, { name: 'Error', message: 'nope' });
});

test('silentLogger discards output', () => {
  const log = silentLogger();
  assert.doesNotThrow(() => log.info('ignored', { anything: true }));
});

test('requestIdFrom reuses a well-formed platform id, else mints one', () => {
  const reused = requestIdFrom(new Request('http://x/', { headers: { 'x-nf-request-id': 'nf-123' } }));
  assert.equal(reused, 'nf-123');

  // A legal header value that fails the shape check (too long) is not reused.
  const rejected = requestIdFrom(new Request('http://x/', { headers: { 'x-request-id': 'a'.repeat(500) } }));
  assert.match(rejected, /^[0-9a-f-]{36}$/);

  const minted = requestIdFrom(new Request('http://x/'));
  assert.match(minted, /^[0-9a-f-]{36}$/);
});

test('pseudonym is stable, irreversible-looking, and not the input', () => {
  const a = pseudonym('learner-uuid');
  const b = pseudonym('learner-uuid');
  assert.equal(a, b);
  assert.equal(a.length, 12);
  assert.notEqual(a, 'learner-uuid');
  assert.notEqual(pseudonym('other'), a);
});

test('observeSchema reports ready when every expected table exists', async () => {
  const db = {
    async sql() {
      return EXPECTED_TABLES.map((table) => ({ table_name: table }));
    },
  };
  const observation = await observeSchema(db);
  assert.equal(observation.ready, true);
  assert.equal(observation.latestMigration, LATEST_MIGRATION);
  assert.deepEqual([...observation.missing], []);
});

test('observeSchema reports degraded and names the missing tables', async () => {
  const db = {
    async sql() {
      return [{ table_name: 'anonymous_learners' }, { table_name: 'worlds' }];
    },
  };
  const observation = await observeSchema(db);
  assert.equal(observation.ready, false);
  assert.ok(observation.missing.includes('publications'));
  assert.ok(observation.missing.includes('mission_attempts'));
  assert.deepEqual([...observation.present], ['anonymous_learners', 'worlds']);
});
