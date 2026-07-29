/**
 * A tiny, public content contract for an authored IRONSIGHT civilization.
 *
 * It is intentionally URL-shaped: a static JAMStack deployment can publish a
 * new world without a database, account, server action, or runtime request.
 * The full game and the lightweight forge both consume this same pure seam.
 */
export interface WorldProfile {
  readonly civilization: string;
  readonly sigil: string;
  readonly era: string;
  readonly places: Readonly<{
    ALPHA: string;
    BRAVO: string;
    CHARLIE: string;
  }>;
}

export interface WorldProfileValidation {
  readonly ok: boolean;
  readonly profile?: WorldProfile;
  readonly issues: readonly string[];
}

export const DEFAULT_WORLD_PROFILE: WorldProfile = Object.freeze({
  civilization: 'Harbour Reach',
  sigil: '⚑',
  era: 'The Contest',
  places: Object.freeze({
    ALPHA: 'Market Square',
    BRAVO: 'Harbour Cranes',
    CHARLIE: 'Old Fort',
  }),
});

const PARAMS = Object.freeze({
  civilization: 'civ',
  sigil: 'sigil',
  era: 'era',
  ALPHA: 'alpha',
  BRAVO: 'bravo',
  CHARLIE: 'charlie',
});

function clean(raw: string | null, fallback: string, maxLength: number): string {
  if (raw === null) return fallback;
  const value = raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  return value || fallback;
}

function validatedText(
  value: unknown,
  path: string,
  maxLength: number,
  issues: string[],
): string {
  if (typeof value !== 'string') {
    issues.push(`${path} must be a string`);
    return '';
  }
  const normalized = clean(value, '', maxLength + 1);
  if (!normalized) issues.push(`${path} is required`);
  if (normalized.length > maxLength) issues.push(`${path} must be ${maxLength} characters or fewer`);
  return normalized.slice(0, maxLength);
}

/** Strict server/client validation for durable publication. URL reads remain forgiving. */
export function validateWorldProfile(input: unknown): WorldProfileValidation {
  const issues: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, issues: ['profile must be an object'] };
  }
  const record = input as Record<string, unknown>;
  const places =
    record.places && typeof record.places === 'object' && !Array.isArray(record.places)
      ? (record.places as Record<string, unknown>)
      : {};
  if (!record.places || Object.keys(places).length === 0) issues.push('places must be an object');

  const profile: WorldProfile = {
    civilization: validatedText(record.civilization, 'civilization', 24, issues),
    sigil: validatedText(record.sigil, 'sigil', 8, issues),
    era: validatedText(record.era, 'era', 48, issues),
    places: {
      ALPHA: validatedText(places.ALPHA, 'places.ALPHA', 32, issues),
      BRAVO: validatedText(places.BRAVO, 'places.BRAVO', 32, issues),
      CHARLIE: validatedText(places.CHARLIE, 'places.CHARLIE', 32, issues),
    },
  };
  return issues.length > 0 ? { ok: false, issues } : { ok: true, profile, issues: [] };
}

export function readWorldProfile(search: string | URLSearchParams): WorldProfile {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  return {
    civilization: clean(params.get(PARAMS.civilization), DEFAULT_WORLD_PROFILE.civilization, 24),
    sigil: clean(params.get(PARAMS.sigil), DEFAULT_WORLD_PROFILE.sigil, 8),
    era: clean(params.get(PARAMS.era), DEFAULT_WORLD_PROFILE.era, 48),
    places: {
      ALPHA: clean(params.get(PARAMS.ALPHA), DEFAULT_WORLD_PROFILE.places.ALPHA, 32),
      BRAVO: clean(params.get(PARAMS.BRAVO), DEFAULT_WORLD_PROFILE.places.BRAVO, 32),
      CHARLIE: clean(params.get(PARAMS.CHARLIE), DEFAULT_WORLD_PROFILE.places.CHARLIE, 32),
    },
  };
}

export interface WorldAuthorshipChecks {
  readonly civilization: boolean;
  readonly symbol: boolean;
  readonly era: boolean;
  readonly place: boolean;
}

export function worldAuthorshipChecks(profile: WorldProfile): WorldAuthorshipChecks {
  return {
    civilization: profile.civilization !== DEFAULT_WORLD_PROFILE.civilization,
    symbol: profile.sigil !== DEFAULT_WORLD_PROFILE.sigil,
    era: profile.era !== DEFAULT_WORLD_PROFILE.era,
    place:
      profile.places.ALPHA !== DEFAULT_WORLD_PROFILE.places.ALPHA ||
      profile.places.BRAVO !== DEFAULT_WORLD_PROFILE.places.BRAVO ||
      profile.places.CHARLIE !== DEFAULT_WORLD_PROFILE.places.CHARLIE,
  };
}

export function isAuthoredWorld(profile: WorldProfile): boolean {
  return Object.values(worldAuthorshipChecks(profile)).every(Boolean);
}

export function applyWorldProfile(url: URL, profile: WorldProfile): URL {
  const next = new URL(url.href);
  next.searchParams.set('teach', '1');
  next.searchParams.set(PARAMS.civilization, profile.civilization);
  next.searchParams.set(PARAMS.sigil, profile.sigil);
  next.searchParams.set(PARAMS.era, profile.era);
  next.searchParams.set(PARAMS.ALPHA, profile.places.ALPHA);
  next.searchParams.set(PARAMS.BRAVO, profile.places.BRAVO);
  next.searchParams.set(PARAMS.CHARLIE, profile.places.CHARLIE);
  return next;
}
