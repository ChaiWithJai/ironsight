/**
 * Anonymous learner session.
 *
 * Identity is a server-issued, HttpOnly, SameSite=Lax UUID cookie — the same
 * `ironsight_learner` cookie the world-publication slice issues, so a learner
 * who published a world and a learner who started a course run are the same
 * anonymous person. No PII, no login: the cookie IS the account.
 */
const SESSION_COOKIE = 'ironsight_learner';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ONE_YEAR_SECONDS = 31_536_000;

export interface LearnerSession {
  /** The learner's stable anonymous id. */
  readonly id: string;
  /** A Set-Cookie value present only when a NEW identity was minted. */
  readonly setCookie?: string;
  /** True when this request arrived with no valid identity cookie. */
  readonly bootstrapped: boolean;
}

/** Reads and validates the learner id already carried by the request, if any. */
export function existingLearnerId(request: Request): string | null {
  const cookie = request.headers.get('cookie') ?? '';
  for (const item of cookie.split(';')) {
    const [name, ...rest] = item.trim().split('=');
    if (name === SESSION_COOKIE) {
      const value = decodeURIComponent(rest.join('='));
      return UUID.test(value) ? value : null;
    }
  }
  return null;
}

/**
 * Resolves the learner for a request, minting a fresh anonymous identity when
 * none is present. Callers that must NOT create identity (pure reads) should
 * use {@link existingLearnerId} instead and 401 on null.
 */
export function resolveLearner(request: Request): LearnerSession {
  const existing = existingLearnerId(request);
  if (existing) return { id: existing, bootstrapped: false };
  const id = crypto.randomUUID();
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return {
    id,
    bootstrapped: true,
    setCookie:
      `${SESSION_COOKIE}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax; ` +
      `Max-Age=${ONE_YEAR_SECONDS}${secure}`,
  };
}
