import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WORLD_PROFILE,
  applyWorldProfile,
  readWorldProfile,
  validateWorldProfile,
  worldAuthorshipChecks,
} from '../../src/engine/world-profile.ts';

const authored = {
  civilization: '  City   of Many Rivers ',
  sigil: '☀',
  era: 'The Dawn Accord',
  places: {
    ALPHA: 'Sun Assembly',
    BRAVO: 'Moon Quay',
    CHARLIE: 'Archive Hill',
  },
};

test('strict publication validation normalizes a complete profile', () => {
  const result = validateWorldProfile(authored);
  assert.equal(result.ok, true);
  assert.equal(result.profile?.civilization, 'City of Many Rivers');
  assert.deepEqual(worldAuthorshipChecks(result.profile), {
    civilization: true,
    symbol: true,
    era: true,
    place: true,
  });
});

test('strict validation rejects missing and oversized fields', () => {
  const result = validateWorldProfile({
    civilization: 'x'.repeat(25),
    sigil: '',
    era: 'Era',
    places: { ALPHA: 'One' },
  });
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
