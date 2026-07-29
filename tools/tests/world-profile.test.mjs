import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WORLD_PROFILE,
  applyWorldProfile,
  readWorldProfile,
  validateWorldProfile,
  worldAuthorshipChecks,
} from '../../src/engine/world-profile.ts';
import { INVALID_WORLD_PROFILE_INPUT, SAMPLE_WORLD_PROFILE } from '../fixtures/index.ts';

// Same canonical fixture the integration test, teach:smoke and
// netlify-smoke consume — plus stray whitespace, to prove `clean()`
// normalizes untrusted input down to that exact shared shape.
const authored = {
  ...SAMPLE_WORLD_PROFILE,
  civilization: `  ${SAMPLE_WORLD_PROFILE.civilization}  `.replace('City', 'City   '),
};

test('strict publication validation normalizes a complete profile', () => {
  const result = validateWorldProfile(authored);
  assert.equal(result.ok, true);
  assert.equal(result.profile?.civilization, SAMPLE_WORLD_PROFILE.civilization);
  assert.deepEqual(worldAuthorshipChecks(result.profile), {
    civilization: true,
    symbol: true,
    era: true,
    place: true,
  });
});

test('strict validation rejects missing and oversized fields', () => {
  const result = validateWorldProfile(INVALID_WORLD_PROFILE_INPUT);
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('civilization must be 24 characters or fewer'));
  assert.ok(result.issues.includes('sigil is required'));
  assert.ok(result.issues.includes('places.BRAVO must be a string'));
});

test('URL contract remains complete and playable without an API', () => {
  const checked = validateWorldProfile(authored);
  assert.ok(checked.ok && checked.profile);
  const url = applyWorldProfile(new URL('https://example.test/'), checked.profile);
  const restored = readWorldProfile(url.search);
  assert.deepEqual(restored, checked.profile);
  assert.equal(url.searchParams.get('teach'), '1');
});

test('forgiving URL reads retain Harbour Reach defaults', () => {
  assert.deepEqual(readWorldProfile(''), DEFAULT_WORLD_PROFILE);
});
