import { timingSafeEqual } from 'node:crypto';
import type { Config, Context } from '@netlify/functions';
import {
  createWorldRepository,
  type DisposalRequest,
  type WorldRepository,
} from './lib/world-store.mts';

const WORLD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 8_192;
const MAX_IDS = 200;

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/** Constant-time token check. A missing/blank server secret disables disposal entirely. */
function authorized(request: Request): boolean {
  const expected = process.env.IRONSIGHT_MAINTENANCE_TOKEN ?? '';
  if (expected.length === 0) return false;
  const presented = bearer(request) ?? '';
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function parseRequest(value: unknown):
  | { ok: true; request: DisposalRequest }
  | { ok: false; message: string } {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  let ids: string[] | undefined;
  if (record.ids !== undefined) {
    if (!Array.isArray(record.ids)) return { ok: false, message: 'ids must be an array of world ids.' };
    if (record.ids.length > MAX_IDS) return { ok: false, message: `ids may not exceed ${MAX_IDS} entries.` };
    ids = [];
    for (const entry of record.ids) {
      if (typeof entry !== 'string' || !WORLD_ID.test(entry)) {
        return { ok: false, message: 'every id must be a valid world id.' };
      }
      ids.push(entry);
    }
  }

  let olderThanHours: number | undefined;
  if (record.olderThanHours !== undefined) {
    const n = Number(record.olderThanHours);
    if (!Number.isFinite(n) || n < 0) return { ok: false, message: 'olderThanHours must be a non-negative number.' };
    olderThanHours = n;
  }

  const dryRun = record.dryRun === true;
  return { ok: true, request: { ids, olderThanHours, dryRun } };
}

export function createMaintenanceHandler(repository: WorldRepository) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      return json({ code: 'METHOD_NOT_ALLOWED', message: 'Use POST /api/maintenance/worlds.' }, 405);
    }
    if (!authorized(request)) {
      // One code for "no secret configured" and "wrong secret" so probing learns nothing.
      return json({ code: 'FORBIDDEN', message: 'Maintenance disposal requires a valid token.' }, 403);
    }
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > MAX_BODY_BYTES) {
      return json({ code: 'PAYLOAD_TOO_LARGE', message: 'Disposal request is too large.' }, 413);
    }
    let value: unknown = {};
    const raw = await request.text();
    if (raw.trim().length > 0) {
      if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
        return json({ code: 'PAYLOAD_TOO_LARGE', message: 'Disposal request is too large.' }, 413);
      }
      try {
        value = JSON.parse(raw);
      } catch {
        return json({ code: 'INVALID_JSON', message: 'Request body must be valid JSON.' }, 400);
      }
    }
    const parsed = parseRequest(value);
    if (!parsed.ok) return json({ code: 'INVALID_REQUEST', message: parsed.message }, 400);

    try {
      const result = await repository.disposeDisposable(parsed.request);
      return json({
        code: result.dryRun ? 'DISPOSAL_PREVIEW' : 'DISPOSED',
        dryRun: result.dryRun,
        count: result.disposed.length,
        disposed: result.disposed,
      });
    } catch (error) {
      console.error('[maintenance] disposal failed', error);
      return json({ code: 'DISPOSAL_FAILED', message: 'Disposal could not complete.' }, 503);
    }
  };
}

export default async (request: Request, _context: Context): Promise<Response> =>
  createMaintenanceHandler(createWorldRepository())(request);

export const config: Config = {
  path: '/api/maintenance/worlds',
  method: ['POST'],
};
