import type { Config, Context } from '@netlify/functions';
import {
  applyWorldProfile,
  validateWorldProfile,
  type WorldProfile,
} from '../../src/engine/world-profile.ts';
import { createWorldRepository, type WorldRepository, type WorldRow } from './lib/world-store.mts';
import { markInvocation, newStoreTiming, recordRequestMetric } from './lib/metrics.mts';

const WORLD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_COOKIE = 'ironsight_learner';
const MAX_BODY_BYTES = 4_096;

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

async function bodyProfile(request: Request): Promise<
  | { ok: true; profile: WorldProfile }
  | { ok: false; response: Response }
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
  const input =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).profile
      : undefined;
  const checked = validateWorldProfile(input);
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
  return { ok: true, profile: checked.profile };
}

export function createWorldsHandler(repository: WorldRepository) {
  return async (request: Request, context: Pick<Context, 'params'>): Promise<Response> => {
    const startedAt = performance.now();
    const { cold, instanceInvocation } = markInvocation();
    const id = context.params.id;
    // Route shape only — never the id/uuid value itself — so the metric line
    // can't be joined back to a specific learner's world.
    const route = id ? '/api/worlds/:id' : '/api/worlds';
    const timing = newStoreTiming();
    let response: Response;
    try {
      if (request.method === 'GET' && id) {
        if (!WORLD_ID.test(id)) {
          response = json({ code: 'INVALID_WORLD_ID', message: 'World id is invalid.' }, 400);
        } else {
          const world = await repository.find(id, timing);
          response = !world
            ? json({ code: 'WORLD_NOT_FOUND', message: 'That world does not exist.' }, 404)
            : json(
                { world, playUrl: playableUrl(request, world) },
                200,
                { 'cache-control': 'public, max-age=60, s-maxage=86400, immutable' },
              );
        }
      } else if (request.method === 'POST' && !id) {
        const parsed = await bodyProfile(request);
        if (!parsed.ok) {
          response = parsed.response;
        } else {
          const learner = learnerSession(request);
          const world = await repository.create(parsed.profile, learner.id, timing);
          const headers: HeadersInit = {};
          if (learner.cookie) headers['set-cookie'] = learner.cookie;
          headers.location = `/api/worlds/${world.id}`;
          response = json({ world, playUrl: playableUrl(request, world) }, 201, headers);
        }
      } else {
        response = json({ code: 'METHOD_NOT_ALLOWED', message: 'Use POST /api/worlds or GET /api/worlds/:id.' }, 405, {
          allow: 'GET, POST',
        });
      }
    } catch (error) {
      console.error('[worlds] request failed', error);
      response = json(
        {
          code: 'WORLD_SERVICE_UNAVAILABLE',
          message: 'Durable publishing is unavailable. Your complete URL world still works.',
        },
        503,
      );
    }
    recordRequestMetric(
      {
        route,
        method: request.method,
        status: response.status,
        cold,
        totalMs: performance.now() - startedAt,
        dbMs: timing.dbMs,
        blobMs: timing.blobMs,
        blobAttempted: timing.blobAttempted,
        blobFailed: timing.blobFailed,
      },
      instanceInvocation,
    );
    return response;
  };
}

export default async (request: Request, context: Context): Promise<Response> =>
  createWorldsHandler(createWorldRepository())(request, context);

export const config: Config = {
  path: ['/api/worlds', '/api/worlds/:id'],
  method: ['GET', 'POST'],
  rateLimit: {
    action: 'rate_limit',
    aggregateBy: ['domain', 'ip'],
    windowLimit: 12,
    windowSize: 60,
  },
};
