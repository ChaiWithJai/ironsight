import type { Config, Context } from '@netlify/functions';
import {
  createSessionRepository,
  type LearnerRecord,
  type SessionRepository,
} from './lib/session-store.mts';
import {
  hashRecoveryKey,
  isRecoveryKeyShape,
  isSameOriginRequest,
  json,
  newRecoveryKey,
  readLearnerCookie,
  sessionCookie,
} from './lib/session.mts';

// The notice a learner affirms when bootstrapping a durable session before they
// have authored anything to publish (docs/PRIVACY.md §5). Bump when the notice
// text changes so a consent record names the exact notice the learner saw.
const NOTICE_VERSION = 'anon-notice@2026-07-29';
const MAX_BODY_BYTES = 2_048;

function sessionView(learner: LearnerRecord, isNew: boolean): Record<string, unknown> {
  return {
    established: true,
    isNew,
    createdAt: learner.createdAt,
    consentVersion: learner.consentVersion,
    hasRecovery: learner.hasRecovery,
  };
}

async function readJson(
  request: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return { ok: false, response: json({ code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' }, 413) };
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, response: json({ code: 'INVALID_JSON', message: 'Could not read request body.' }, 400) };
  }
  if (raw.length === 0) return { ok: true, value: {} };
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return { ok: false, response: json({ code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' }, 413) };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, response: json({ code: 'INVALID_JSON', message: 'Request body must be valid JSON.' }, 400) };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, response: json({ code: 'INVALID_JSON', message: 'Request body must be a JSON object.' }, 400) };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/** Extracts an affirmed consent version from the request body, or null. */
function consentFrom(body: Record<string, unknown>): string | null {
  const consent = body.consent;
  if (!consent || typeof consent !== 'object') return null;
  const record = consent as Record<string, unknown>;
  if (record.agreed !== true) return null;
  const version = typeof record.version === 'string' && record.version.length > 0 && record.version.length <= 120
    ? record.version
    : NOTICE_VERSION;
  return version;
}

async function bootstrap(request: Request, repo: SessionRepository): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const consent = consentFrom(parsed.value);

  const cookieId = readLearnerCookie(request);
  if (cookieId) {
    const existing = await repo.touch(cookieId, consent ?? undefined);
    if (existing) {
      // Returning learner: idempotent, no duplicate row, cookie refreshed.
      return json({ session: sessionView(existing, false) }, 200, {
        'set-cookie': sessionCookie(existing.id, request),
      });
    }
    // Cookie points at a purged/unknown learner — fall through to fresh create,
    // which is the "cookie loss" recovery path when no recovery key was saved.
  }

  if (!consent) {
    return json(
      {
        code: 'CONSENT_REQUIRED',
        message:
          'Starting a durable session stores an anonymous id. Send { "consent": { "version": "…", "agreed": true } } to proceed. Declining keeps the full URL-only path.',
        noticeVersion: NOTICE_VERSION,
      },
      400,
    );
  }
  const learner = await repo.create(consent);
  return json({ session: sessionView(learner, true) }, 201, {
    'set-cookie': sessionCookie(learner.id, request),
  });
}

async function issueRecoveryKey(request: Request, repo: SessionRepository): Promise<Response> {
  const cookieId = readLearnerCookie(request);
  const learner = cookieId ? await repo.find(cookieId) : null;
  if (!learner) {
    return json(
      { code: 'NO_SESSION', message: 'Bootstrap a session (POST /api/session) before requesting a recovery key.' },
      401,
    );
  }
  const key = newRecoveryKey();
  await repo.setRecoveryHash(learner.id, await hashRecoveryKey(key));
  // Transmitted exactly once. We store only its hash; we cannot show it again.
  return json({
    recoveryKey: key,
    note:
      'Save this key somewhere safe. It is the only way to recover this anonymous learning on another device or after clearing cookies. We store only a hash and cannot recover it for you.',
  });
}

async function recover(request: Request, repo: SessionRepository): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const key = parsed.value.recoveryKey;
  if (!isRecoveryKeyShape(key)) {
    return json({ code: 'INVALID_RECOVERY_KEY', message: 'A recovery key is required.' }, 400);
  }
  const canonical = await repo.findByRecoveryHash(await hashRecoveryKey(key));
  if (!canonical) {
    // Generic: does not distinguish "wrong key" from "no such key". Combined
    // with the endpoint rate limit and 256-bit keys, brute force is infeasible.
    return json({ code: 'RECOVERY_NOT_FOUND', message: 'That recovery key does not match a session.' }, 404);
  }

  // Duplicate/merge: if this device already had a distinct, live anonymous
  // session (an orphan created because the cookie was lost), fold its work into
  // the recovered canonical identity. The caller can only ever merge data they
  // already hold the cookie for, so no cross-learner theft is possible.
  let merged: Awaited<ReturnType<SessionRepository['merge']>> | null = null;
  const cookieId = readLearnerCookie(request);
  if (cookieId && cookieId !== canonical.id) {
    const orphan = await repo.find(cookieId);
    if (orphan) merged = await repo.merge(canonical.id, orphan.id);
  }
  const refreshed = (await repo.touch(canonical.id)) ?? canonical;
  return json(
    {
      recovered: true,
      merged,
      session: sessionView(refreshed, false),
    },
    200,
    { 'set-cookie': sessionCookie(canonical.id, request) },
  );
}

async function whoami(request: Request, repo: SessionRepository): Promise<Response> {
  const cookieId = readLearnerCookie(request);
  const learner = cookieId ? await repo.find(cookieId) : null;
  if (!learner) return json({ session: { established: false } });
  return json({ session: sessionView(learner, false) });
}

export function createSessionHandler(repository: SessionRepository) {
  return async (request: Request): Promise<Response> => {
    try {
      const { pathname } = new URL(request.url);

      if (request.method === 'GET' && pathname === '/api/session') {
        return whoami(request, repository);
      }

      if (request.method === 'POST') {
        // CSRF: refuse cookie-authenticated state changes the browser flags as
        // cross-site (defense in depth behind SameSite=Lax on the cookie).
        if (!isSameOriginRequest(request)) {
          return json({ code: 'CROSS_ORIGIN_BLOCKED', message: 'Cross-site requests are not allowed.' }, 403);
        }
        if (pathname === '/api/session') return bootstrap(request, repository);
        if (pathname === '/api/session/recovery-key') return issueRecoveryKey(request, repository);
        if (pathname === '/api/session/recover') return recover(request, repository);
      }

      return json({ code: 'METHOD_NOT_ALLOWED', message: 'Unsupported session route or method.' }, 405, {
        allow: 'GET, POST',
      });
    } catch (error) {
      console.error('[session] request failed', error);
      return json(
        {
          code: 'SESSION_SERVICE_UNAVAILABLE',
          message: 'Session continuity is unavailable. Your URL-only world still works.',
        },
        503,
      );
    }
  };
}

export default async (request: Request, _context: Context): Promise<Response> =>
  createSessionHandler(createSessionRepository())(request);

export const config: Config = {
  path: ['/api/session', '/api/session/recovery-key', '/api/session/recover'],
  method: ['GET', 'POST'],
  rateLimit: {
    action: 'rate_limit',
    aggregateBy: ['domain', 'ip'],
    windowLimit: 20,
    windowSize: 60,
  },
};
