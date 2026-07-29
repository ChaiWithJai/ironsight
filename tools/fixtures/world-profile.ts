/**
 * Canonical WorldProfile fixture, shared by every test tier: unit tests
 * (tools/tests/*.test.mjs), local integration tests (against the ephemeral
 * NetlifyDB), teach:smoke (Deploy Preview's full-game browser proof), and
 * netlify-smoke (staging/production canary).
 *
 * One authored civilization, one shape, everywhere it is asserted against —
 * so a schema or validation change surfaces as one failing fixture instead of
 * four places quietly drifting out of sync with each other.
 */
import type { WorldProfile } from '../../src/engine/world-profile.ts';

/** The reference authored civilization used across the whole test surface. */
export const SAMPLE_WORLD_PROFILE: WorldProfile = Object.freeze({
  civilization: 'City of Many Rivers',
  sigil: '☀',
  era: 'The Dawn Accord',
  places: Object.freeze({
    ALPHA: 'Sun Assembly',
    BRAVO: 'Moon Quay',
    CHARLIE: 'Archive Hill',
  }),
});

export interface WorldProfilePlacesOverrides {
  ALPHA?: string;
  BRAVO?: string;
  CHARLIE?: string;
}

export interface WorldProfileOverrides {
  civilization?: string;
  sigil?: string;
  era?: string;
  places?: WorldProfilePlacesOverrides;
}

/** A fresh WorldProfile built from the canonical sample plus overrides. */
export function createWorldProfile(overrides: WorldProfileOverrides = {}): WorldProfile {
  return {
    civilization: overrides.civilization ?? SAMPLE_WORLD_PROFILE.civilization,
    sigil: overrides.sigil ?? SAMPLE_WORLD_PROFILE.sigil,
    era: overrides.era ?? SAMPLE_WORLD_PROFILE.era,
    places: {
      ALPHA: overrides.places?.ALPHA ?? SAMPLE_WORLD_PROFILE.places.ALPHA,
      BRAVO: overrides.places?.BRAVO ?? SAMPLE_WORLD_PROFILE.places.BRAVO,
      CHARLIE: overrides.places?.CHARLIE ?? SAMPLE_WORLD_PROFILE.places.CHARLIE,
    },
  };
}

/**
 * A profile carrying a marker in its civilization name, so a shared
 * environment (Deploy Preview, staging) can prove which rows/worlds were
 * created by an automated run and clean them up without out-of-band
 * bookkeeping. `civilization` is capped at 24 characters by
 * `validateWorldProfile`, so the marker is prefixed and the combined string
 * is truncated to stay valid.
 */
export function createMarkedWorldProfile(marker: string, overrides: WorldProfileOverrides = {}): WorldProfile {
  return createWorldProfile({
    ...overrides,
    civilization: `${marker} Many Rivers`.slice(0, 24),
  });
}

/** Deliberately invalid input: too-long civilization, empty sigil, incomplete places. */
export const INVALID_WORLD_PROFILE_INPUT = Object.freeze({
  civilization: 'x'.repeat(25),
  sigil: '',
  era: 'Era',
  places: Object.freeze({ ALPHA: 'One' }),
});
