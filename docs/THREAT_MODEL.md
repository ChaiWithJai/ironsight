# THREAT_MODEL.md — teaching-platform identity & persistence

**Scope:** the Netlify Functions boundary for anonymous identity and durable
worlds — `netlify/functions/session.mts`, `worlds.mts`, and their shared libs.
**Companions:** `docs/PRIVACY.md` (data classification, consent, child safety),
`docs/adr/0002-anonymous-session-recovery.md` (the identity decisions),
`docs/NETLIFY_RUNBOOK.md` (environment isolation).

This is a short, honest note: what an attacker could try, and what is **actually
implemented** versus **planned**. It covers the threats issue #3 named — CSRF,
forged evidence, replay, abusive content, ownership — plus recovery-key theft and
merge abuse, which the recovery feature introduces.

## Trust model

- The only identity is the opaque `ironsight_learner` cookie (a v4 UUID). It is
  `HttpOnly`, so page scripts cannot read it; `SameSite=Lax`; `Secure` on HTTPS.
- The **learner id is derived only from that server-set cookie**, never from a
  request body. This single rule is the foundation of every ownership check.
- The recovery key is a 256-bit secret the learner holds; the server stores only
  its SHA-256 hash. Losing the key is unrecoverable by design.
- IP/user-agent are transient C4 operational data (rate limiting), never written
  to a learner record (`docs/PRIVACY.md` §8).

## Threats and mitigations

### 1. CSRF (cross-site state change on a cookie-authenticated endpoint)
A malicious page tries to make the learner's browser POST to `/api/worlds` or
`/api/session/*` with the cookie attached.
- **Implemented:** `SameSite=Lax` on the cookie already stops cross-site POST from
  carrying it. Defence-in-depth `isSameOriginRequest()` additionally **rejects**
  any POST the browser flags cross-site via `Sec-Fetch-Site`, or whose `Origin`
  host mismatches the request host → `403 CROSS_ORIGIN_BLOCKED`. Applied to every
  state-changing route (`session.mts`, `worlds.mts`). Absent both signals
  (server-to-server, same-origin navigation, tests) the request is allowed and the
  cookie's SameSite attribute is the control.
- **Planned:** a formal `Content-Security-Policy` / `Referrer-Policy` /
  `Permissions-Policy` header set (issue #3 "security headers") hardens the origin
  further.

### 2. Ownership / horizontal privilege escalation (acting as another learner)
An attacker tries to read or mutate a learner's records they do not own.
- **Implemented:** all learner scoping derives from the HttpOnly cookie; no
  endpoint trusts a body-supplied learner id. `GET /api/worlds/:id` is
  deliberately public (published worlds are C0 public-by-intent) and exposes no
  `creator_id`. Merge only ever reassigns records the caller already holds the
  **orphan cookie** for, so it cannot pull in a stranger's work.
- **Planned:** cookie-scoped list/export/delete endpoints (`docs/DATA_RETENTION.md`)
  must each re-derive the learner from the cookie and filter by it — noted so they
  are not written to accept a learner id parameter.

### 3. Recovery-key theft / brute force
The recovery key is a bearer credential; whoever holds it controls the identity.
- **Implemented:** 256 bits of CSPRNG entropy (`crypto.getRandomValues`) makes
  guessing infeasible; only a SHA-256 **hash** is stored, so a DB read does not
  yield usable keys; the key is transmitted exactly once and never logged; the
  endpoint is rate-limited (20 req / 60 s / IP) and returns a **generic** 404 that
  does not distinguish "wrong key" from "no such key" (no enumeration oracle);
  transport is HTTPS-only in staging/production.
- **Accepted residual:** a learner who leaks their own saved key can be
  impersonated — the same trade as any recovery code. Mitigated operationally:
  re-issuing a key overwrites the old hash, invalidating the leaked one.

### 4. Replay
Capturing and re-sending a request.
- **Implemented:** the mutating identity endpoints are naturally
  replay-idempotent — re-bootstrap returns the same session, re-recover re-sets the
  same cookie, a repeated merge finds nothing left to move. So replay yields no new
  effect. HTTPS prevents on-path capture in deployed environments.
- **Planned (evidence path, not owned here):** mission-attempt writes must use
  **idempotency keys** + monotonic `attempt_number` (the schema's
  `UNIQUE (run_id, mission_id, attempt_number)` already enforces the latter) so a
  replayed submission cannot inflate attempts. Called out for the course-runs API.

### 5. Forged evidence
`mission_attempts.evidence` is client-submitted and therefore forgeable.
- **Implemented (identity layer):** whatever writes evidence must attach it to the
  server-derived learner and run, so forged evidence can at least never be attributed
  to *another* learner. That ownership primitive exists here.
- **Planned / honest limitation:** the identity layer cannot prove a machine-generated
  replay is genuine. Real anti-forgery requires the evaluator to **re-simulate**
  server-side (or verify a signed, seeded transcript) and to stamp its own
  `evaluator_version` rather than trust a client-sent `passed`. This is the
  course-runs API's responsibility; documented so it is not skipped. Until then,
  automated evidence is "software evidence only" (issue #3), not proof of learning.

### 6. Abusive / harmful content
Learner-authored C2 free text (civilization/place names, reflections) could carry
abuse, PII, or harmful content.
- **Implemented:** strict size caps at the Function boundary (world payload ≤ 4 KB,
  session body ≤ 2 KB); responses carrying learner data are `private, no-store`;
  the forge escapes markup before rendering; published worlds default **private**
  (no discoverability feature exists), so nothing is broadcast.
- **Planned:** a moderation/abuse-reporting policy and point-of-entry "don't type
  anything private" warnings must land **before** any public discoverability ships
  (`docs/PRIVACY.md` §3/§7, issue #3 "moderation, abuse reporting").

### 7. Merge abuse / data destruction
Could a merge be weaponised to destroy or steal data?
- **Implemented:** merge is union-only — it reassigns ownership and deletes only the
  now-empty orphan learner row; no world, run, or publication is ever deleted by a
  merge. The direction is fixed (orphan → canonical) and both sides must be proven
  by possession (orphan cookie + canonical recovery key). A counts-only
  `identity_merges` audit row records that it happened without retaining content.

### 8. Denial of service / resource abuse
- **Implemented:** per-IP rate limits declared on both Functions (`worlds` 12/60 s,
  `session` 20/60 s); tight body-size caps; the game bundle makes zero runtime
  network calls, so the API is not on the hot path and an outage degrades to the
  URL-only fallback rather than breaking play.
- **Planned:** load/abuse testing of the declared limits and protection for any
  future expensive endpoints (issue #3 "test the declared rate limit").

## Summary: implemented here vs. deferred

**Implemented now:** cookie-derived ownership everywhere; SameSite=Lax + explicit
same-origin CSRF checks on all state changes; hashed high-entropy recovery secrets
with generic errors and rate limits; idempotent, non-enumerable, audited merge;
size caps and no-store caching on learner data; anonymous-only with no new
identifiers.

**Deferred (owned by other issue-#3 items, flagged so they are not forgotten):**
CSP/security-header set; server-side evidence re-simulation + evaluator versioning;
idempotency keys on evidence writes; content moderation before discoverability;
cookie-scoped export/delete + retention purge; rate-limit load testing.
