import type { Config, Context } from '@netlify/functions';
import {
  applyWorldProfile,
  validateWorldProfile,
  type WorldProfile,
} from '../../src/engine/world-profile.ts';
import { createWorldRepository, type WorldRepository, type WorldRow } from './lib/world-store.mts';

const WORLD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_COOKIE = 'ironsight_learner';
const MAX_BODY_BYTES = 4_096;
const MAX_REASON_LENGTH = 280;

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': status >= 400 ? 'no-store' : 'private, no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

function cookieValue(request: Request): string | null {
  const cookie = request.headers.get('cookie') ?? '';
  for (const item of cookie.split(';')) {
    const [name, ...rest] = item.trim().split('=');
    if (name === SESSION_COOKIE) {
      const value = decodeURIComponent(rest.join('='));
      return WORLD_ID.test(value) ? value : null;
    }
  }
  return null;
}

function learnerSession(request: Request): { id: string; cookie?: string } {
  const existing = cookieValue(request);
  if (existing) return { id: existing };
  const id = crypto.randomUUID();
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return {
    id,
    cookie:
      `${SESSION_COOKIE}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax; ` +
      `Max-Age=31536000${secure}`,
  };
}

function playableUrl(request: Request, world: WorldRow): string {
  const url = applyWorldProfile(new URL('/', request.url), world.profile);
  url.searchParams.set('world', world.id);
  return `${url.pathname}${url.search}`;
}

// Publishers may self-mark a world disposable. This is intentionally harmless on
// its own: nothing acts on the flag except the token-guarded maintenance sweep,
// so a learner flagging their own world only offers it up for canary cleanup.
function isDisposableRequest(request: Request): boolean {
  return request.headers.get('x-ironsight-disposable') === '1';
}

interface ParsedBody {
  readonly profile: WorldProfile;
  readonly supersedes: string | null;
  readonly reason: string | null;
}

async function readBody(request: Request): Promise<
  { ok: true; body: ParsedBody } | { ok: false; response: Response }
> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return { ok: false, response: json({ code: 'PAYLOAD_TOO_LARGE', message: 'World payload is too large.' }, 413) };
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, response: json({ code: 'INVALID_JSON', message: 'Could not read request body.' }, 400) };
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return { ok: false, response: json({ code: 'PAYLOAD_TOO_LARGE', message: 'World payload is too large.' }, 413) };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, response: json({ code: 'INVALID_JSON', message: 'Request body must be valid JSON.' }, 400) };
  }
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const checked = validateWorldProfile(record.profile);
  if (!checked.ok || !checked.profile) {
    return {
      ok: false,
      response: json(
        {
          code: 'INVALID_PROFILE',
          message: 'The civilization contract is incomplete.',
          issues: checked.issues,
        },
        422,
      ),
    };
  }
  const supersedesRaw = typeof record.supersedes === 'string' ? record.supersedes : null;
  if (supersedesRaw !== null && !WORLD_ID.test(supersedesRaw)) {
    return { ok: false, response: json({ code: 'INVALID_WORLD_ID', message: 'supersedes must be a world id.' }, 400) };
  }
  const reason = typeof record.reason === 'string' ? record.reason.slice(0, MAX_REASON_LENGTH) : null;
  return { ok: true, body: { profile: checked.profile, supersedes: supersedesRaw, reason } };
}

export function createWorldsHandler(repository: WorldRepository) {
  return async (request: Request, context: Pick<Context, 'params'>): Promise<Response> => {
    try {
      const id = context.params.id;

      // GET /api/worlds/:id — read one durable world.
      if (request.method === 'GET' && id) {
        if (!WORLD_ID.test(id)) return json({ code: 'INVALID_WORLD_ID', message: 'World id is invalid.' }, 400);
        const world = await repository.find(id);
        if (!world) return json({ code: 'WORLD_NOT_FOUND', message: 'That world does not exist.' }, 404);
        if (world.status === 'withdrawn') {
          // The durable copy is gone by the author's choice, but the URL contract still
          // encodes the civilization: clients fall back to it, so the link keeps working.
          return json(
            {
              code: 'WORLD_WITHDRAWN',
              message: 'The author withdrew this world. Its complete URL still boots the same civilization.',
            },
            410,
          );
        }
        return json(
          { world, playUrl: playableUrl(request, world) },
          200,
          { 'cache-control': 'public, max-age=60, s-maxage=86400, immutable' },
        );
      }

      // GET /api/worlds — list only the calling learner's own worlds.
      if (request.method === 'GET' && !id) {
        const learnerId = cookieValue(request);
        // No session cookie means no worlds could exist for this caller yet. Never
        // fabricate a session here, and never fall through to another learner's data.
        const worlds = learnerId ? await repository.listByCreator(learnerId) : [];
        return json({ worlds });
      }

      // POST /api/worlds — publish a new world, or an immutable revision of an owned one.
      if (request.method === 'POST' && !id) {
        const parsed = await readBody(request);
        if (!parsed.ok) return parsed.response;
        const learner = learnerSession(request);
        const disposable = isDisposableRequest(request);
        const headers: HeadersInit = {};
        if (learner.cookie) headers['set-cookie'] = learner.cookie;

        if (parsed.body.supersedes) {
          const revised = await repository.revise(
            parsed.body.supersedes,
            parsed.body.profile,
            learner.id,
            { disposable },
          );
          if (!revised) {
            return json(
              { code: 'NOT_YOUR_WORLD', message: 'You can only revise a world you published.' },
              403,
              headers,
            );
          }
          headers.location = `/api/worlds/${revised.id}`;
          return json({ world: revised, playUrl: playableUrl(request, revised) }, 201, headers);
        }

        const world = await repository.create(parsed.body.profile, learner.id, { disposable });
        headers.location = `/api/worlds/${world.id}`;
        return json({ world, playUrl: playableUrl(request, world) }, 201, headers);
      }

      // DELETE /api/worlds/:id — withdraw (unpublish) a world the learner owns.
      if (request.method === 'DELETE' && id) {
        if (!WORLD_ID.test(id)) return json({ code: 'INVALID_WORLD_ID', message: 'World id is invalid.' }, 400);
        const learnerId = cookieValue(request);
        if (!learnerId) {
          return json({ code: 'NO_SESSION', message: 'No learner session to authorize withdrawal.' }, 401);
        }
        const reasonParam = new URL(request.url).searchParams.get('reason');
        const reason = reasonParam ? reasonParam.slice(0, MAX_REASON_LENGTH) : undefined;
        const result = await repository.withdraw(id, learnerId, reason);
        if (result.outcome === 'not_found') {
          // Do not leak whether the world exists under a different owner.
          return json({ code: 'WORLD_NOT_FOUND', message: 'No world of yours matches that id.' }, 404);
        }
        if (result.outcome === 'already') {
          return json({ code: 'ALREADY_WITHDRAWN', message: 'That world was already withdrawn.', status: 'withdrawn' });
        }
        return json({ code: 'WITHDRAWN', message: 'World withdrawn. Shared URLs still boot the civilization.', status: 'withdrawn' });
      }

      return json(
        { code: 'METHOD_NOT_ALLOWED', message: 'Use GET/POST /api/worlds, GET/DELETE /api/worlds/:id.' },
        405,
        { allow: 'GET, POST, DELETE' },
      );
    } catch (error) {
      console.error('[worlds] request failed', error);
      return json(
        {
          code: 'WORLD_SERVICE_UNAVAILABLE',
          message: 'Durable publishing is unavailable. Your complete URL world still works.',
        },
        503,
      );
    }
  };
}

export default async (request: Request, context: Context): Promise<Response> =>
  createWorldsHandler(createWorldRepository())(request, context);

export const config: Config = {
  path: ['/api/worlds', '/api/worlds/:id'],
  method: ['GET', 'POST', 'DELETE'],
  rateLimit: {
    action: 'rate_limit',
    aggregateBy: ['domain', 'ip'],
    windowLimit: 12,
    windowSize: 60,
  },
};
