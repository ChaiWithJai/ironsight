# ADR 0002: World publication lifecycle

- Status: accepted
- Date: 2026-07-29
- Decision owner: Loop Factory (p0-publication-lifecycle)

## Context

ADR 0001 shipped a create/read-only world API: `POST /api/worlds` and
`GET /api/worlds/:id`, backed by Netlify Database, an immutable Blob export, and
an anonymous HttpOnly learner cookie. Issue #3 (P0 · Publication lifecycle) then
asks for the rest of the loop a learner needs to own their work:

- List a learner's own worlds without exposing anyone else's.
- Decide immutable versioning vs edit-in-place, preserving every stable URL's
  original meaning.
- Add withdraw/unpublish with audit records.
- Add safe disposal of staging/canary/test records that cannot degrade into a
  broad unauthenticated delete surface.

The non-negotiable inherited invariant: the URL-encoded `WorldProfile` is the
portable, offline, shareable contract. A shared link must keep booting the same
civilization even when the durable copy is unavailable or gone.

## Decision

### 1. Ownership listing — `GET /api/worlds`

The listing is scoped **server-side** to the anonymous session cookie
(`creator_id = <cookie learner id>`). No learner id is ever accepted from the
client, so the endpoint cannot be pointed at another learner. No cookie means an
empty list — never a fallthrough to someone else's data. The list returns
lightweight summaries (civilization, sigil, era, status, lineage, timestamps),
not full profiles.

### 2. Immutable versioning, not edit-in-place (default kept)

A world is **immutable**. "Editing" is republishing: `POST /api/worlds` with a
`supersedes` id creates a **new** world with its own stable id/URL and records
lineage via `worlds.supersedes_id`. The predecessor stays `published` and fully
readable forever.

This is the only option that satisfies "preserve every stable URL's original
meaning" literally: an in-place edit would silently change what an already-shared
link resolves to. With immutable versioning, `.../worlds/<old>` always returns
the bytes it always returned, and `.../worlds/<new>` is a distinct address.
Revision is authorization-checked: only the owner of the predecessor may
supersede it (a non-owner gets `403 NOT_YOUR_WORLD`).

Cost accepted: no server-side "canonical latest" pointer yet. The learner's
portfolio shows the lineage (`supersedesId`), which is enough for the current
single-author teaching loop; a published alias can be added later without
breaking any existing URL.

### 3. Withdraw / unpublish — `DELETE /api/worlds/:id`

Withdrawal is the **only** status transition on an existing world
(`published → withdrawn`), owner-scoped in the same query so a wrong learner can
never withdraw another's world (and the response never reveals whether the world
exists under a different owner). A withdrawn world reads as `410 Gone`.

Crucially this does **not** break the URL contract: the `410` body says so, and
the client's existing offline fallback boots the civilization straight from the
URL parameters. So withdrawal retires the *durable record* while the *meaning* of
any link already shared is preserved. Withdrawal is idempotent
(`ALREADY_WITHDRAWN`, not an error). Every withdrawal writes an audit event with
an optional reason.

### 4. Safe disposal of canary/test records — `POST /api/maintenance/worlds`

Disposal is a **hard delete** (junk records should not linger), but three guards
make it safe:

1. It only ever touches rows explicitly flagged `disposable = true`. That
   predicate is never omitted — even an explicit id list is intersected with it —
   so the endpoint cannot become a broad delete surface even if the token leaks.
2. It requires a server-only bearer token (`IRONSIGHT_MAINTENANCE_TOKEN`),
   constant-time compared. A missing/blank secret disables disposal entirely.
3. It supports `dryRun` and an age floor (`olderThanHours`) so operators can
   preview before deleting.

A world is flagged disposable at publish time via the `x-ironsight-disposable`
header. Self-flagging is intentionally harmless: nothing acts on the flag except
the token-guarded sweep, so a learner marking their own world only offers it up
for canary cleanup.

### 5. Durable audit trail — `world_events`

Every lifecycle action (`published`, `revised`, `withdrawn`, `disposed`) writes
to an append-only `world_events` log capturing actor, actor kind
(`learner` / `maintenance`), reason, and JSON detail. The table is deliberately
**not** foreign-keyed to `worlds`: a disposal hard-deletes the world row, but the
record that it happened — with a civilization snapshot — must survive.

## Out of scope (explicitly deferred)

Discoverability, public/private defaults, sharing previews, moderation, and abuse
reporting are named in issue #3 but deferred: they need opt-in identity and a
teacher workflow that does not exist yet. Billing/auto-recharge is untouched.
Publication retry after a Blob failure is partially covered (the audit records
`artifactExported: false`); a full retry queue is a follow-up.

## Consequences

- A learner can list, revise (immutably), and withdraw their own worlds, and
  every shared URL keeps its meaning.
- Operators can dispose canary/test rows safely and audibly.
- Schema grows by four `worlds` columns and one `world_events` table; all
  additive. The create/read slice from ADR 0001 is unchanged in behaviour.
