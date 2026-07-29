# DATA_RETENTION.md — retention schedule, export, and deletion

**Owner:** Jai Bhagat · DharmicData.org
**Companion to:** [`docs/PRIVACY.md`](./PRIVACY.md) (data classification, consent, child safety).
**Status:** policy of record. The **schedule** below is binding intent; the **jobs and endpoints**
that enforce it are follow-up code (see [`PRIVACY.md`](./PRIVACY.md) §9) and are flagged here.

Principle: **short retention by default, durable only where the learner asked for durability.** A
learner who never publishes leaves no server record at all (the URL fallback holds their world).
Everything we do store expires on a clock, and the learner can shorten that clock to zero by
exporting and deleting.

---

## 1. Retention schedule

Periods are measured from the trigger column. All stores referenced exist in
`netlify/database/migrations/20260729134500_teaching_platform.sql`; classes (C0–C4) are defined in
[`PRIVACY.md`](./PRIVACY.md) §3.

| Data | Store | Class | Retention | Trigger | Rationale |
|---|---|---|---|---|---|
| Anonymous learner identity | `anonymous_learners` | C1 | **180 days** | `last_seen_at` | Continuity for a returning learner without indefinite pseudonymous tracking. Inactive identities age out. |
| Unpublished world | `worlds` (no `publications` row) | C2 | **180 days** | `created_at` | Working content. If never published it is scratch; the learner still holds the URL copy. |
| Published world | `worlds` with a `published` publication | C0/C2 | **Durable** while published | — | The learner deliberately made it public and durable. Ends at withdraw/delete (§3). |
| Publication record | `publications` | C0/C1 | Durable while `published`; **90 days** as a `withdrawn` tombstone, then purge | `status` change | Keep the stable-URL "withdrawn" answer briefly, then remove. |
| Course run | `course_runs` | C3 | **180 days** active/completed; **30 days** if `abandoned` | `started_at` (or `completed_at` if set) | Enough to revisit recent learning; abandoned runs are noise. |
| Mission attempts | `mission_attempts` | C3 | Follows parent run (`ON DELETE CASCADE`) | run deletion | Assessment evidence has no value once the run is gone. |
| Reflections (free text) | `reflections` | C2 | Follows parent run (`ON DELETE CASCADE`); **hard cap 180 days** | run deletion / `created_at` | Highest-sensitivity learner writing — never outlives its run. |
| Blob artifacts (world export, replay, screenshots) | Netlify Blobs | C2/C3 | Match their owning row; **90 days** for replay/screenshot evidence | referencing row deletion | Immutable artifacts are scoped-deleted when their DB row goes. |
| Operational logs (IP, UA, rate-limit counters) | platform logs | C4 | **≤ 30 days**, privacy-scrubbed | log write | Debugging and abuse defense only; never joined to a learner. |
| Staging / canary / test records | staging + production canaries | C4 | **Delete within 7 days**; canaries same-release | creation | Prevent synthetic data lingering; canaries use an unmistakable `CANARY` civilization name (`docs/NETLIFY_RUNBOOK.md`). |

**Notes**
- "Durable" is not "forever": it lasts only while the learner keeps the world published and only
  until an export+delete request. There is no permanent, unrevocable learner data.
- Deleting a `course_runs` row cascades to its `mission_attempts` and `reflections` in the schema
  already. The purge job must additionally scoped-delete the corresponding Blob keys, which the
  database cascade does not reach.
- A learner action (export, delete, withdraw) always overrides the schedule immediately.

---

## 2. Export (learner access / portability)

**Scope:** the caller's own `ironsight_learner` cookie only. No cross-learner access.

**Intended shape** *(follow-up endpoint — not yet built; see [`PRIVACY.md`](./PRIVACY.md) §9):*

```
GET /api/me/export      # cookie-authenticated; 200 → application/json bundle, private, no-store
```

The bundle contains everything keyed to the learner UUID:

```jsonc
{
  "learner": { "id": "...", "created_at": "...", "last_seen_at": "..." },
  "worlds":        [ /* full profile + place names + blob refs */ ],
  "course_runs":   [ /* status + timestamps */ ],
  "mission_attempts": [ /* mission_id, attempt_number, evidence, passed */ ],
  "reflections":   [ /* prompt_id, response, rubric */ ],
  "publications":  [ /* stable_path, deploy_url, status */ ],
  "blobs":         [ /* keys + a short-lived download reference per artifact */ ]
}
```

Rules: machine-readable JSON, no other learner's data, cache headers `private, no-store`, and the
same rate limiting posture as the worlds Function. If the learner has no server record (URL-only
path), the endpoint returns an empty-but-valid bundle, not an error.

---

## 3. Deletion and withdrawal

**Scope:** the caller's own cookie only, plus a guardian/school administrator acting for a student
in cohort use ([`PRIVACY.md`](./PRIVACY.md) §7).

**Intended endpoints** *(follow-up — not yet built):*

```
DELETE /api/me            # erase the learner and all owned records (cascade + Blob scoped-delete)
POST   /api/worlds/:id/withdraw   # publication → 'withdrawn'; purge the C2 content behind it
```

**`DELETE /api/me` performs:**
1. Delete `reflections`, `mission_attempts` (via run cascade), `course_runs`, `worlds`, and
   `publications` owned by the learner.
2. Scoped-delete every referenced Blob key (`artifact_blob_key` on `worlds` and
   `mission_attempts`).
3. Delete the `anonymous_learners` row.
4. Clear the `ironsight_learner` cookie (`Max-Age=0`).
5. Write a minimal, non-identifying **audit record** (timestamp, action, count of rows removed —
   no learner content) so deletions are provable without re-collecting what was deleted
   (issue #3: "deletion/retention workflows with audit records").

**Reconciling deletion with the stable-URL contract.** A published world's URL may have been
shared. Deletion/withdrawal therefore:
- **purges** the learner-authored C2 content and C3 evidence outright, and
- leaves the `publications.stable_path` resolving to an explicit **withdrawn** response
  (HTTP 410 Gone semantics), never a dangling or misleading link, and never the original content.

The URL may persist as a tombstone; the learner's data behind it does not. This is the balance
between "every stable URL keeps its meaning" (issue #3) and the right to erasure.

**Failure handling.** If the Blob scoped-delete fails after the DB rows are gone, the operation is
still a success from the learner's standpoint (their identifiable relational data is gone); the
orphaned immutable Blob is swept by the retention purge job and recorded for retry (issue #3:
"publication status/retry behavior when immutable Blob export fails").

---

## 4. Enforcement — the purge job

*(Follow-up — not yet built; [`PRIVACY.md`](./PRIVACY.md) §9.)*

A scheduled Netlify Function runs the schedule in §1: it selects rows past their retention trigger,
deletes them with the same cascade + Blob scoped-delete path as §3, and emits privacy-safe metrics
(counts only, no content). It must be:

- **idempotent** (safe to run repeatedly; a partial run resumes cleanly),
- **environment-scoped** (never touches production data from staging, per
  `docs/NETLIFY_RUNBOOK.md`),
- **bounded** (batch size limited so it cannot become an unthrottled mass-delete surface), and
- **not a general delete API** — it acts only on the fixed schedule, closing the issue #3 concern
  that canary/test cleanup "cannot become a broad unauthenticated delete surface."

Until the purge job exists, retention is enforced manually by a database administrator following
this schedule, and staging/canary cleanup follows the runbook's manual step.

---

## 5. Review

Revisit these periods after the first moderated learner sessions (issue #3, "Prove learning").
Real usage may justify shorter defaults, not longer ones — the bias is toward less retention. Any
lengthening of a period is a policy change requiring an ADR and a matching edit to
[`PRIVACY.md`](./PRIVACY.md). When the schema changes, §1 changes in the same pull request.
