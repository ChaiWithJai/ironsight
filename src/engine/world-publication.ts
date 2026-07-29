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

export interface PublishOptions {
  /** Publish an immutable revision of an owned world; the old URL keeps its meaning. */
  readonly supersedes?: string;
  /** Mark this world for canary/test disposal (harmless without the maintenance token). */
  readonly disposable?: boolean;
}

/** A learner's own world as returned by the ownership listing. */
export interface OwnedWorld {
  readonly id: string;
  readonly civilization: string;
  readonly sigil: string;
  readonly era: string;
  readonly status: 'published' | 'withdrawn';
  readonly supersedesId: string | null;
  readonly createdAt: string;
  readonly withdrawnAt: string | null;
}

function errorMessage(payload: unknown, status: number, fallback: string): string {
  return payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).message === 'string'
    ? String((payload as Record<string, unknown>).message)
    : `${fallback} (${status})`;
}

export async function publishWorld(
  profile: WorldProfile,
  options: PublishOptions = {},
  fetcher: typeof fetch = fetch,
): Promise<PublishedWorld> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.disposable) headers['x-ironsight-disposable'] = '1';
  const body: Record<string, unknown> = { profile };
  if (options.supersedes) body.supersedes = options.supersedes;
  const response = await fetcher('/api/worlds', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  const world = response.ok ? responseWorld(payload) : null;
  if (!world) throw new Error(errorMessage(payload, response.status, 'publication failed'));
  return world;
}

/**
 * Lists only the calling learner's own worlds. The server scopes the query to the
 * anonymous session cookie, so this can never surface another learner's work.
 */
export async function listMyWorlds(fetcher: typeof fetch = fetch): Promise<OwnedWorld[]> {
  const response = await fetcher('/api/worlds', { headers: { accept: 'application/json' } });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== 'object') return [];
  const worlds = (payload as Record<string, unknown>).worlds;
  return Array.isArray(worlds) ? (worlds as OwnedWorld[]) : [];
}

/**
 * Withdraws (unpublishes) a world the learner owns. Shared URLs still boot the
 * civilization from the URL contract; only the durable record is retired.
 */
export async function withdrawWorld(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: boolean; status: string; message: string }> {
  const response = await fetcher(`/api/worlds/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const payload: unknown = await response.json().catch(() => null);
  const message = errorMessage(payload, response.status, 'withdrawal failed');
  const status =
    payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).status === 'string'
      ? String((payload as Record<string, unknown>).status)
      : response.ok
        ? 'withdrawn'
        : 'error';
  return { ok: response.ok, status, message };
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
