import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWorldProfile } from '../../src/engine/world-profile.ts';
import {
  INVALID_WORLD_PROFILE_INPUT,
  SAMPLE_WORLD_PROFILE,
  createAnonymousLearner,
  createCourseRun,
  createMarkedWorldProfile,
  createMissionAttempt,
  createPublication,
  createReflection,
  createWorldProfile,
} from '../fixtures/index.ts';

test('createWorldProfile defaults to the canonical sample and validates', () => {
  const profile = createWorldProfile();
  assert.deepEqual(profile, SAMPLE_WORLD_PROFILE);
  const result = validateWorldProfile(profile);
  assert.equal(result.ok, true);
});

test('createWorldProfile overrides individual fields without mutating the sample', () => {
  const profile = createWorldProfile({ era: 'The Second Founding', places: { ALPHA: 'New Assembly' } });
  assert.equal(profile.era, 'The Second Founding');
  assert.equal(profile.places.ALPHA, 'New Assembly');
  assert.equal(profile.places.BRAVO, SAMPLE_WORLD_PROFILE.places.BRAVO);
  assert.equal(SAMPLE_WORLD_PROFILE.era, 'The Dawn Accord');
});

test('createMarkedWorldProfile stays within the 24-character civilization limit and validates', () => {
  for (const marker of ['STAGING', 'CANARY', 'PREVIEW-4821']) {
    const profile = createMarkedWorldProfile(marker);
    assert.ok(profile.civilization.length <= 24, profile.civilization);
    assert.ok(profile.civilization.startsWith(marker));
    const result = validateWorldProfile(profile);
    assert.equal(result.ok, true, result.issues.join(', '));
  }
});

test('INVALID_WORLD_PROFILE_INPUT fails strict validation the same way for every consumer', () => {
  const result = validateWorldProfile(INVALID_WORLD_PROFILE_INPUT);
  assert.equal(result.ok, false);
  assert.ok(result.issues.length > 0);
});

test('createAnonymousLearner produces a fresh uuid unless overridden', () => {
  const a = createAnonymousLearner();
  const b = createAnonymousLearner();
  assert.notEqual(a.id, b.id);
  const fixed = createAnonymousLearner({ id: '11111111-1111-4111-8111-111111111111' });
  assert.equal(fixed.id, '11111111-1111-4111-8111-111111111111');
});

test('createCourseRun defaults match the course_runs schema contract', () => {
  const run = createCourseRun();
  assert.equal(run.status, 'active');
  assert.equal(run.worldId, null);
  assert.equal(run.completedAt, null);
  assert.match(run.courseVersion, /^academy-v1$/);
  for (const status of ['active', 'completed', 'abandoned']) {
    assert.equal(createCourseRun({ status }).status, status);
  }
});

test('createMissionAttempt defaults are a positive attempt number with JSON-safe evidence', () => {
  const attempt = createMissionAttempt();
  assert.ok(Number.isInteger(attempt.attemptNumber) && attempt.attemptNumber > 0);
  assert.doesNotThrow(() => JSON.stringify(attempt.evidence));
  assert.equal(attempt.passed, true);
  const second = createMissionAttempt({ runId: attempt.runId, attemptNumber: 2, passed: false });
  assert.equal(second.runId, attempt.runId);
  assert.equal(second.attemptNumber, 2);
  assert.equal(second.passed, false);
});

test('createReflection defaults to a non-empty response and no rubric', () => {
  const reflection = createReflection();
  assert.ok(reflection.response.length > 0);
  assert.equal(reflection.rubric, null);
});

test('createPublication produces unique stable paths across repeated calls', () => {
  const first = createPublication();
  const second = createPublication();
  assert.notEqual(first.stablePath, second.stablePath);
  assert.equal(first.status, 'published');
  for (const status of ['published', 'withdrawn', 'failed']) {
    assert.equal(createPublication({ status }).status, status);
  }
});
