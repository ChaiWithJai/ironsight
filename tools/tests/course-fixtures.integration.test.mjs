import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

// Same isolation rationale as worlds-function.integration.test.mjs: force the
// server driver onto an ephemeral Postgres-compatible test server rather than
// whatever production database Netlify's build environment would otherwise
// inject.
process.env.NETLIFY_DB_DRIVER = 'server';
const { NetlifyDB } = await import('@netlify/database-dev');
const { default: pg } = await import('pg');
const { waddler } = await import('waddler/node-postgres');
const { createWorldRepository } = await import('../../netlify/functions/lib/world-store.mts');
const {
  SAMPLE_WORLD_PROFILE,
  createAnonymousLearner,
  createCourseRun,
  createMissionAttempt,
  createPublication,
  createReflection,
} = await import('../fixtures/index.ts');

let localDatabase;
let database;
let repository;

before(async () => {
  localDatabase = new NetlifyDB({ logger: () => {} });
  const localConnection = new URL(await localDatabase.start());
  localConnection.username = 'netlify_test';
  const connectionString = localConnection.href;
  await localDatabase.applyMigrations('./netlify/database/migrations');
  const pool = new pg.Pool({ connectionString });
  database = { driver: 'server', sql: waddler({ client: pool }), pool, connectionString };
  const artifacts = {
    async set() {
      return { modified: true, etag: 'test' };
    },
  };
  repository = createWorldRepository(database, artifacts);
});

after(async () => {
  await database?.pool.end();
  await localDatabase?.stop();
});

// This suite proves the fixtures in tools/fixtures/course-run.ts satisfy the
// actual FK/CHECK/UNIQUE constraints in
// netlify/database/migrations/20260729134500_teaching_platform.sql — the
// tables issue #3 calls out as schema-only today, with no Function or client
// sync yet implementing them. It exercises the schema directly rather than a
// Function, since none exists.
test('course_runs, mission_attempts, reflections and publications accept the shared fixtures', async () => {
  const learner = createAnonymousLearner();
  const world = await repository.create(SAMPLE_WORLD_PROFILE, learner.id);

  const run = createCourseRun({ learnerId: learner.id, worldId: world.id });
  await database.sql`
    INSERT INTO course_runs (id, learner_id, world_id, course_version, status)
    VALUES (${run.id}, ${run.learnerId}, ${run.worldId}, ${run.courseVersion}, ${run.status})
  `;

  const firstAttempt = createMissionAttempt({ runId: run.id, attemptNumber: 1, passed: false });
  const secondAttempt = createMissionAttempt({ runId: run.id, attemptNumber: 2, passed: true });
  for (const attempt of [firstAttempt, secondAttempt]) {
    await database.sql`
      INSERT INTO mission_attempts (run_id, mission_id, attempt_number, evidence, passed, artifact_blob_key)
      VALUES (
        ${attempt.runId}, ${attempt.missionId}, ${attempt.attemptNumber},
        ${JSON.stringify(attempt.evidence)}::jsonb, ${attempt.passed}, ${attempt.artifactBlobKey}
      )
    `;
  }

  const reflection = createReflection({ runId: run.id });
  const rubricJson = reflection.rubric ? JSON.stringify(reflection.rubric) : null;
  await database.sql`
    INSERT INTO reflections (id, run_id, prompt_id, response, rubric)
    VALUES (${reflection.id}, ${reflection.runId}, ${reflection.promptId}, ${reflection.response}, ${rubricJson}::jsonb)
  `;

  const publication = createPublication({ worldId: world.id, learnerId: learner.id });
  await database.sql`
    INSERT INTO publications (id, world_id, learner_id, stable_path, deploy_url, status)
    VALUES (
      ${publication.id}, ${publication.worldId}, ${publication.learnerId},
      ${publication.stablePath}, ${publication.deployUrl}, ${publication.status}
    )
  `;

  const runs = await database.sql`SELECT status FROM course_runs WHERE id = ${run.id}`;
  assert.equal(runs[0].status, 'active');

  const attempts = await database.sql`
    SELECT attempt_number, passed FROM mission_attempts WHERE run_id = ${run.id} ORDER BY attempt_number
  `;
  assert.deepEqual(
    attempts.map((row) => [row.attempt_number, row.passed]),
    [
      [1, false],
      [2, true],
    ],
  );

  const reflections = await database.sql`SELECT response FROM reflections WHERE run_id = ${run.id}`;
  assert.equal(reflections[0].response, reflection.response);

  const publications = await database.sql`
    SELECT status, stable_path FROM publications WHERE id = ${publication.id}
  `;
  assert.equal(publications[0].status, 'published');
  assert.equal(publications[0].stable_path, publication.stablePath);
});

test('mission_attempts rejects a duplicate (run_id, mission_id, attempt_number) as the UNIQUE constraint requires', async () => {
  const learner = createAnonymousLearner();
  const world = await repository.create(SAMPLE_WORLD_PROFILE, learner.id);
  const run = createCourseRun({ learnerId: learner.id, worldId: world.id });
  await database.sql`
    INSERT INTO course_runs (id, learner_id, world_id, course_version, status)
    VALUES (${run.id}, ${run.learnerId}, ${run.worldId}, ${run.courseVersion}, ${run.status})
  `;
  const attempt = createMissionAttempt({ runId: run.id, attemptNumber: 1 });
  await database.sql`
    INSERT INTO mission_attempts (run_id, mission_id, attempt_number, evidence, passed, artifact_blob_key)
    VALUES (
      ${attempt.runId}, ${attempt.missionId}, ${attempt.attemptNumber},
      ${JSON.stringify(attempt.evidence)}::jsonb, ${attempt.passed}, ${attempt.artifactBlobKey}
    )
  `;
  await assert.rejects(async () => {
    await database.sql`
      INSERT INTO mission_attempts (run_id, mission_id, attempt_number, evidence, passed, artifact_blob_key)
      VALUES (
        ${attempt.runId}, ${attempt.missionId}, ${attempt.attemptNumber},
        ${JSON.stringify(attempt.evidence)}::jsonb, ${attempt.passed}, ${attempt.artifactBlobKey}
      )
    `;
  });
});

test('course_runs rejects a status outside the CHECK constraint enum', async () => {
  const learner = createAnonymousLearner();
  const world = await repository.create(SAMPLE_WORLD_PROFILE, learner.id);
  const run = createCourseRun({ learnerId: learner.id, worldId: world.id, status: 'stalled' });
  await assert.rejects(async () => {
    await database.sql`
      INSERT INTO course_runs (id, learner_id, world_id, course_version, status)
      VALUES (${run.id}, ${run.learnerId}, ${run.worldId}, ${run.courseVersion}, ${run.status})
    `;
  });
});
