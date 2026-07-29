# ADR 0002: Anonymous session bootstrap, recovery, merge, and consent

- Status: accepted
- Date: 2026-07-29
- Decision owner: Jai Bhagat
- Issue: #3 "Identity and continuity"
- Supersedes nothing; refines the identity paragraph of `docs/PRIVACY.md` §4.

## Context

Before this change the only identity was a server-issued anonymous HttpOnly
cookie (`ironsight_learner`) minted **at world publication** (`worlds.mts`). Issue
#3 asks for four things the create/read slice did not have:

1. an anonymous session/bootstrap endpoint **before** a learner publishes,
2. defined and implemented cookie loss / expiry / cross-device **recovery**,
3. **duplicate/merge** behaviour when a learner ends up with two anonymous ids,
4. **consent** handling.

`docs/PRIVACY.md` (policy of record) constrains the solution hard: anonymous-first,
**exactly one functional cookie**, minimal collection, no tracking, and — §4 —
"loss of the cookie means loss of continuity … there is no recovery mechanism that
could re-link an anonymous learner, because we hold nothing else about them."

That last sentence is the tension: #3 wants recovery; the privacy stance says the
*server* holds nothing that can re-link a learner. This ADR resolves it without
re-deciding the anonymous-first, single-cookie policy.

## Decisions

**1. Anonymous-only. No accounts.** No email/password/OAuth is added. Issue #3
lists optional opt-in accounts; we decline them. The pseudonymous UUID plus a
learner-held recovery secret covers continuity without collecting any identifier
the privacy and child-safety policy (`docs/PRIVACY.md` §7) is built around *not*
holding. Accounts remain a future ADR if a concrete need appears.

**2. Session lifetime = one year, sliding.** The cookie keeps its existing
`Max-Age=31536000`, refreshed on every session touch. The server-side learner row
ages out per `docs/DATA_RETENTION.md` (180 days from `last_seen_at`). A returning
learner slides both forward; an abandoned identity ages out. No change to the
established numbers.

**3. Recovery is a learner-held secret, not server-side re-linking.** This is the
reconciliation with PRIVACY §4. The server never builds an identity graph and
still cannot *unilaterally* re-link anyone. Recovery works only when the learner
presents a secret **they** hold:

- `POST /api/session/recovery-key` (authenticated by the current cookie) mints a
  256-bit key, stores only its **SHA-256 hash**, and returns the plaintext
  **once**. The learner saves it — the same class of deliberately-held state as
  the shareable URL that PRIVACY §2.3 already treats as learner-owned continuity.
- `POST /api/session/recover` accepts that key, hashes it, finds the matching
  learner, and re-issues the cookie. This covers cookie expiry, cleared cookies,
  and a different device.

Why a separate hashed secret rather than exposing the learner UUID to JavaScript:
the UUID is the cookie value and every foreign key; keeping it `HttpOnly` is what
stops an XSS from stealing an identity. A distinct, hashed recovery secret gives
portability **without** ever handing page scripts the raw identity. Storing a hash
is a deliberate, learner-gated re-link capability — flagged here because it nuances
PRIVACY §4's absolute phrasing. **Follow-up:** PRIVACY §4 should gain one sentence
pointing at this ADR; that doc is owned by the privacy-policy change and is edited
there, not here.

**4. Merge = union, canonical wins, nothing destroyed.** If a learner recovers a
canonical identity from a device that had already started a fresh (orphan)
anonymous session, `recover` reassigns the orphan's `worlds`, `course_runs`, and
`publications` to the canonical learner, writes a counts-only `identity_merges`
audit row, and deletes the orphan learner. A caller can only ever merge data they
already hold the orphan cookie for, so merge cannot steal another learner's work.
The steps are ordered (reassign owned rows, then delete the orphan) and idempotent,
so a partially-applied merge completes cleanly on retry — chosen over a transaction
because the serverless DB access is pooled and a resumable merge is more robust
than a cross-statement transaction here.

**5. Consent = notice + affirmative action, recorded server-side.** Operationalises
PRIVACY §5. The consent version the learner affirmed is stored on the learner row
(`consent_version`, `consent_at`).
- The dedicated bootstrap (`POST /api/session`) creates a durable row *before* any
  authored content exists, so it **requires** an explicit
  `{ consent: { version, agreed: true } }`; without it, it returns `CONSENT_REQUIRED`
  and creates nothing. Declining keeps the learner on the zero-collection URL path.
- Publishing (`POST /api/worlds`) is itself the affirmative act, so it records an
  *implicit* `implicit-publish@…` consent version without adding a required field —
  keeping the existing publish flow and its tests unchanged.

**6. One cookie, one source of truth.** No second cookie is introduced (PRIVACY §4
change-control). The cookie name and attributes now live once in
`netlify/functions/lib/session.mts`; `worlds.mts` was refactored to import them so
the two Functions can never disagree on the session contract.

## Endpoints

| Method + path | Purpose | Auth |
|---|---|---|
| `POST /api/session` | Bootstrap/refresh a session (idempotent). | cookie if present; else consent |
| `GET /api/session` | Whoami — does the cookie map to a live learner? | cookie (optional) |
| `POST /api/session/recovery-key` | Mint a learner-held recovery key (returned once). | cookie |
| `POST /api/session/recover` | Re-establish a session from a recovery key; merge orphan. | recovery key (+ optional orphan cookie) |

## Consequences

Continuity now survives cookie loss and crosses devices, and duplicate identities
can be merged — all without an account, a second cookie, a tracked identifier, or
any server-side ability to re-link a learner who has not chosen to save a key. The
cost is one nullable hashed-secret column and a counts-only audit table. Deletion
of a learner and their data (`DELETE /api/me`) and the retention purge job remain
follow-ups owned by `docs/DATA_RETENTION.md`; this ADR does not build them.
Threat model: `docs/THREAT_MODEL.md`.
