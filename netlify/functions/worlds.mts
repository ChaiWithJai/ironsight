import type { Config, Context } from '@netlify/functions';
import {
  applyWorldProfile,
  validateWorldProfile,
  type WorldProfile,
} from '../../src/engine/world-profile.ts';
import { createWorldRepository, type WorldRepository, type WorldRow } from './lib/world-store.mts';
import { createRateLimiter, type RateLimiter, type RateLimiterOptions } from './lib/rate-limiter.mts';

const WORLD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_COOKIE = 'ironsight_learner';
const MAX_BODY_BYTES = 4_096;

/**
 * Function-level backstop rate limiters. `config.rateLimit` below is the
 * platform's edge-level declaration; these are the in-process token buckets
 * that actually run for every invocation of this file, see individual
 * per-route limits, and are exercised by the integration test.
 *
 * `create` (publication) is the expensive path: it writes Postgres and an
 * immutable Blob per request, so it gets its own tight bucket keyed by IP
 * *and* by learner cookie, so a spammer rotating one dimension is still
 * caught by the other. `read` is cheaper but still a database round trip
 * per request, so it gets a more generous, IP-only bucket.
 */
export interface WorldsRateLimiters {
  readonly createByIp: RateLimiter;
  readonly createByLearner: RateLimiter;
  readonly readByIp: RateLimiter;
}

export interface WorldsRateLimiterOverrides {
  readonly now?: () => number;
  readonly createByIp?: Partial<Pick<RateLimiterOptions, 'capacity' | 'windowMs'>>;
  readonly createByLearner?: Partial<Pick<RateLimiterOptions, 'capacity' | 'windowMs'>>;
  readonly readByIp?: Partial<Pick<RateLimiterOptions, 'capacity' | 'windowMs'>>;
}

export function createWorldsRateLimiters(overrides: WorldsRateLimiterOverrides = {}): WorldsRateLimiters {
  const { now } = overrides;
  return {
    createByIp: createRateLimiter({ capacity: 5, windowMs: 60_000, ...overrides.createByIp, now }),
    createByLearner: createRateLimiter({ capacity: 5, windowMs: 300_000, ...overrides.createByLearner, now }),
    readByIp: createRateLimiter({ capacity: 30, windowMs: 60_000, ...overrides.readByIp, now }),
  };
}

const defaultLimiters = createWorldsRateLimiters();

function rateLimited(retryAfterMs: number): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return json(
    {
      code: 'RATE_LIMITED',
      message: 'Too many requests. Please slow down and try again shortly.',
    },
    429,
    { 'retry-after': String(retryAfterSeconds) },
  );
}

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

/**
 * Reads the request body as UTF-8 text, aborting as soon as more than
 * `maxBytes` have arrived on the wire.
 *
 * A `content-length` check alone is not payload-abuse protection: it trusts
 * a header the client controls, and a chunked/streamed body can omit it
 * entirely. Buffering the whole body with `request.text()` before measuring
 * it (the previous behaviour here) means an attacker who lies about — or
 * omits — `content-length` still forces the function to hold an arbitrarily
 * large body in memory before the size check ever runs. Reading the stream
 * incrementally and bailing out mid-request bounds memory to `maxBytes`
 * regardless of what the client claims or how the body is framed.
 */
async function readBoundedText(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; tooLarge: true }> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, tooLarge: true };

  const reader = request.body?.getReader();
  if (!reader) return { ok: true, text: await request.text() };

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, tooLarge: true };
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

async function bodyProfile(request: Request): Promise<
  | { ok: true; profile: WorldProfile }
  | { ok: false; response: Response }
> {
  const bounded = await readBoundedText(request, MAX_BODY_BYTES);
  if (!bounded.ok) {
    return { ok: false, response: json({ code: 'PAYLOAD_TOO_LARGE', message: 'World payload is too large.' }, 413) };
  }
  const raw = bounded.text;
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

export function createWorldsHandler(
  repository: WorldRepository,
  limiters: WorldsRateLimiters = defaultLimiters,
) {
  return async (request: Request, context: Pick<Context, 'params' | 'ip'>): Promise<Response> => {
    try {
      const id = context.params.id;
      const ip = context.ip || 'unknown';

      if (request.method === 'GET' && id) {
        const read = limiters.readByIp.consume(ip);
        if (!read.allowed) return rateLimited(read.retryAfterMs);
        if (!WORLD_ID.test(id)) return json({ code: 'INVALID_WORLD_ID', message: 'World id is invalid.' }, 400);
        const world = await repository.find(id);
        if (!world) return json({ code: 'WORLD_NOT_FOUND', message: 'That world does not exist.' }, 404);
        return json(
          { world, playUrl: playableUrl(request, world) },
          200,
          { 'cache-control': 'public, max-age=60, s-maxage=86400, immutable' },
        );
      }

      if (request.method === 'POST' && !id) {
        const byIp = limiters.createByIp.consume(ip);
        if (!byIp.allowed) return rateLimited(byIp.retryAfterMs);
        const existingLearner = cookieValue(request);
        if (existingLearner) {
          const byLearner = limiters.createByLearner.consume(existingLearner);
          if (!byLearner.allowed) return rateLimited(byLearner.retryAfterMs);
        }

        const parsed = await bodyProfile(request);
        if (!parsed.ok) return parsed.response;
        const learner = learnerSession(request);
        const world = await repository.create(parsed.profile, learner.id);
        const headers: HeadersInit = {};
        if (learner.cookie) headers['set-cookie'] = learner.cookie;
        headers.location = `/api/worlds/${world.id}`;
        return json({ world, playUrl: playableUrl(request, world) }, 201, headers);
      }

      return json({ code: 'METHOD_NOT_ALLOWED', message: 'Use POST /api/worlds or GET /api/worlds/:id.' }, 405, {
        allow: 'GET, POST',
      });
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
  method: ['GET', 'POST'],
  rateLimit: {
    action: 'rate_limit',
    aggregateBy: ['domain', 'ip'],
    windowLimit: 12,
    windowSize: 60,
  },
};
