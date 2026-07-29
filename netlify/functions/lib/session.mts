/**
 * Shared identity/session primitives for the teaching platform Functions.
 *
 * This is the single source of truth for the one functional cookie mandated by
 * docs/PRIVACY.md §4. `worlds.mts` and `session.mts` both import from here so the
 * cookie name, attributes, and CSRF posture can never drift apart.
 *
 * Design invariants (docs/PRIVACY.md, docs/adr/0002-anonymous-session-recovery.md):
 *   - Exactly one cookie: `ironsight_learner`, HttpOnly, SameSite=Lax, Secure on
 *     HTTPS, opaque v4 UUID value, one-year max age.
 *   - The learner id is derived ONLY from that server-set HttpOnly cookie, never
 *     from a client-supplied body field. This is the ownership primitive every
 *     mutation depends on.
 *   - Recovery is a learner-held secret; the server stores only its hash.
 */

export const SESSION_COOKIE = 'ironsight_learner';
export const SESSION_MAX_AGE = 31_536_000; // one year, in seconds

/** RFC 4122 v1–8 UUID. crypto.randomUUID() emits v4, which this accepts. */
export const LEARNER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isHttps(request: Request): boolean {
  // Behind Netlify's edge the Function sees the terminated origin; trust the
  // forwarded proto when present, else the request URL's own scheme.
  const forwarded = request.headers.get('x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0].trim() === 'https';
  return new URL(request.url).protocol === 'https:';
}

/** Reads the learner id from the session cookie, or null if absent/malformed. */
export function readLearnerCookie(request: Request): string | null {
  const cookie = request.headers.get('cookie') ?? '';
  for (const item of cookie.split(';')) {
    const [name, ...rest] = item.trim().split('=');
    if (name === SESSION_COOKIE) {
      const value = decodeURIComponent(rest.join('='));
      return LEARNER_ID.test(value) ? value : null;
    }
  }
  return null;
}

/** Serializes the Set-Cookie value that establishes/refreshes a session. */
export function sessionCookie(id: string, request: Request): string {
  const secure = isHttps(request) ? '; Secure' : '';
  return (
    `${SESSION_COOKIE}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${SESSION_MAX_AGE}${secure}`
  );
}

/** Serializes the Set-Cookie value that clears the session (for future delete). */
export function clearSessionCookie(request: Request): string {
  const secure = isHttps(request) ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

/**
 * CSRF defense-in-depth for cookie-authenticated state changes.
 *
 * SameSite=Lax already blocks cross-site POST/DELETE from carrying the cookie.
 * This is the belt to that suspenders: if the browser tells us the request is
 * cross-site (via Sec-Fetch-Site, or a mismatched Origin), we refuse. When
 * neither signal is present — server-to-server calls, same-origin top-level
 * navigation, the integration test harness — we allow, because the cookie's
 * SameSite attribute is doing the work and there is nothing to contradict.
 */
export function isSameOriginRequest(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'same-site' || site === 'none';

  const origin = request.headers.get('origin');
  if (origin) {
    try {
      return new URL(origin).host === new URL(request.url).host;
    } catch {
      return false;
    }
  }
  return true; // no cross-site signal to act on
}

/** JSON response with the platform's learner-data cache/security headers. */
export function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': status >= 400 ? 'no-store' : 'private, no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

const RECOVERY_KEY_BYTES = 32; // 256 bits — brute force is infeasible

/** Mints a fresh, URL-safe recovery secret for the learner to hold. */
export function newRecoveryKey(): string {
  const bytes = new Uint8Array(RECOVERY_KEY_BYTES);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** Accepts a plausibly-shaped recovery key; rejects obvious garbage cheaply. */
export function isRecoveryKeyShape(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 40 && value.length <= 100 && /^[A-Za-z0-9_-]+$/.test(value);
}

/** SHA-256 hex of a recovery key. Only the hash is ever persisted. */
export async function hashRecoveryKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
