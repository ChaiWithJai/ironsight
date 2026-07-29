import {
  applyWorldProfile,
  readWorldProfile,
  validateWorldProfile,
  type WorldProfile,
} from '@/engine/world-profile';

const WORLD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PublishedWorld {
  readonly id: string;
  readonly profile: WorldProfile;
  readonly createdAt: string;
  readonly playUrl: string;
}

export interface WorldPublicationProbe {
  state: 'portable' | 'resolving' | 'resolved' | 'fallback';
  worldId: string | null;
  source: 'url' | 'database';
  error?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __WORLD__: WorldPublicationProbe | undefined;
}

function responseWorld(value: unknown): PublishedWorld | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const world = record.world;
  if (!world || typeof world !== 'object') return null;
  const candidate = world as Record<string, unknown>;
  const checked = validateWorldProfile(candidate.profile);
  if (
    typeof candidate.id !== 'string' ||
    !WORLD_ID.test(candidate.id) ||
    typeof candidate.createdAt !== 'string' ||
    typeof record.playUrl !== 'string' ||
    !checked.ok ||
    !checked.profile
  ) {
    return null;
  }
  return {
    id: candidate.id,
    profile: checked.profile,
    createdAt: candidate.createdAt,
    playUrl: record.playUrl,
  };
}

export async function publishWorld(
  profile: WorldProfile,
  fetcher: typeof fetch = fetch,
): Promise<PublishedWorld> {
  const response = await fetcher('/api/worlds', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile }),
  });
  const payload: unknown = await response.json().catch(() => null);
  const world = response.ok ? responseWorld(payload) : null;
  if (!world) {
    const message =
      payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).message === 'string'
        ? String((payload as Record<string, unknown>).message)
        : `publication failed (${response.status})`;
    throw new Error(message);
  }
  return world;
}

/**
 * Resolves a stable `world` id before the engine is constructed. Failure is
 * intentionally non-fatal: the complete URL profile remains playable offline.
 */
export async function hydratePublishedWorld(
  current: URL = new URL(location.href),
  fetcher: typeof fetch = fetch,
): Promise<WorldProfile> {
  const fallback = readWorldProfile(current.search);
  const id = current.searchParams.get('world');
  if (!id || !WORLD_ID.test(id)) {
    globalThis.__WORLD__ = { state: 'portable', worldId: null, source: 'url' };
    return fallback;
  }

  globalThis.__WORLD__ = { state: 'resolving', worldId: id, source: 'url' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_500);
  try {
    const response = await fetcher(`/api/worlds/${encodeURIComponent(id)}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    const published = response.ok ? responseWorld(payload) : null;
    if (!published) throw new Error(`world resolution failed (${response.status})`);

    const hydrated = applyWorldProfile(current, published.profile);
    hydrated.searchParams.set('world', published.id);
    history.replaceState(null, '', hydrated);
    globalThis.__WORLD__ = { state: 'resolved', worldId: id, source: 'database' };
    return published.profile;
  } catch (error) {
    globalThis.__WORLD__ = {
      state: 'fallback',
      worldId: id,
      source: 'url',
      error: error instanceof Error ? error.message : String(error),
    };
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
