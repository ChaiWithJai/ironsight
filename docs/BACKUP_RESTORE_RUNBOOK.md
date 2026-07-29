# Backup, restore, and rollback runbook

Operational contract for recovering the teaching platform's durable state:
the Netlify **Database** (relational learner/world records) and the Netlify
**Blobs** store (immutable world/evidence artifacts). It also covers
application rollback and migration forward-correction.

This document satisfies the P0 operations item in issue #3
("Rehearse database backup/restore and application rollback; document RPO/RTO
and forward-correction for migrations"). It is a companion to
[`NETLIFY_RUNBOOK.md`](./NETLIFY_RUNBOOK.md) — read that first for the
environment contract and release gates.

Never put a Netlify token, account ID, site ID, database URL, connection
string, or learner record in this repository or in a backup committed to it.

---

## Safety contract for rehearsals

- **Never rehearse restore or rollback against production.** Every step below is
  performed against **local** or **staging** only. Production restore is
  described for the on-call operator but is deliberately not exercised by the
  automated rehearsal.
- The rehearsal script (`ops/backup-restore-rehearsal.sh`) **refuses to run**
  unless `IRONSIGHT_REHEARSAL_ROLE` is `local` or `staging`, fails closed on any
  non-loopback / production-looking host, and only ever drops databases it
  created in that run.
- Rehearsals use **synthetic data only** (deterministic UUIDs, a `CANARY`
  world). No production learner data is ever copied into local, staging, or a
  preview — this restates the runbook rule "never restore a production database
  into staging or a public preview."
- Do not touch billing or auto-recharge while rehearsing. Provisioning a
  throwaway local database uses no metered production compute.

---

## What we are protecting

| Store | Contents | Failure modes it must survive |
| --- | --- | --- |
| Database (Postgres) | `anonymous_learners`, `worlds`, `course_runs`, `mission_attempts`, `reflections`, `publications` | accidental delete/update, bad migration, dropped table, region/instance loss |
| Blobs | immutable `worlds/<id>/profile.json` (and future replay/evidence exports) | accidental key overwrite (guarded by `onlyIfNew`), store loss |

The Database is the **system of record for metadata and status**; Blobs hold the
**immutable artifact bytes**. A world row references its artifact by
`artifact_blob_key`. Recovery must keep those two consistent: a restored row
whose blob is missing is a `failed`/degraded publication, and the URL fallback
(`?world=…&civ=…`) keeps the artifact meaningful to the learner even then.

---

## RPO / RTO targets

RPO = maximum acceptable **data loss** (how far back the recovery point may be).
RTO = maximum acceptable **time to recover** service.

The first durable slice carries **low-value, reconstructable synthetic and
early-learner data**, and the URL-encoded `WorldProfile` means a learner's core
artifact survives even total Database loss. Targets are set accordingly and
should be tightened before real moderated learner studies collect evidence that
cannot be reconstructed.

| Environment | RPO target | RTO target | Backup mechanism |
| --- | --- | --- | --- |
| Production | ≤ 24 h (platform history window / PITR) | ≤ 1 h to a known-good recovery point | Netlify Database point-in-time / history-based restore, plus a scheduled logical `pg_dump` retained off-platform |
| Staging | ≤ 24 h; loss acceptable (synthetic only) | ≤ 30 min, or rebuild from migrations + reseed | logical dump on demand |
| Local | none (ephemeral) | rebuild from migrations any time | not applicable |

Blobs are immutable and written with `onlyIfNew`, so their effective RPO is 0 for
already-written keys (they cannot be silently mutated); the exposure is store
loss, mitigated by the relational metadata plus the URL fallback and, later, a
periodic export of the blob store.

**These are targets, not guarantees.** They must be re-validated whenever the
schema, data volume, or platform plan changes, and lowered before the platform
holds hard-to-reconstruct human-learner evidence.

---

## Backup strategy

1. **Platform-native (production line of defense).** Netlify's managed Postgres
   retains history and supports restoring to a point in time / a branch. This is
   the primary production recovery path: it needs no application involvement and
   captures every committed transaction inside the retention window. Confirm the
   retention window in the Netlify dashboard and record it next to the RPO above.
2. **Portable logical backup (second line of defense, and what we rehearse).** A
   `pg_dump -Fc` custom-format dump is engine-portable, restores into any
   Postgres, and can be retained off-platform. This is the mechanism the
   rehearsal exercises end to end because it is the one we can run and verify
   ourselves without touching production. For staging, take one on demand before
   any risky migration; for production, schedule it and store it outside source
   control with the same secrecy as credentials.
3. **Blobs.** Rely on immutability (`onlyIfNew`) plus relational metadata for
   integrity. Add a periodic enumerate-and-copy export of the blob store to a
   separate bucket before real evidence uploads begin (issue #3, P0 evidence
   uploads).

---

## Restore procedure

### Local / staging (rehearsable — safe)

Run the automated rehearsal, which provisions a disposable database, seeds it,
backs it up, simulates a data-loss incident, restores, and verifies:

```sh
# Requires local Postgres client tools (psql, pg_dump, pg_restore) and a
# reachable local/Netlify-dev Postgres on 127.0.0.1:5432 (override with PGHOST/PGPORT).
IRONSIGHT_REHEARSAL_ROLE=local ops/backup-restore-rehearsal.sh
```

To restore a real staging database from a logical dump by hand:

```sh
# 1. Take the recovery-point backup BEFORE the risky change.
pg_dump -Fc -d "$STAGING_DATABASE_URL" -f staging_$(date +%Y%m%d_%H%M%S).dump

# 2. Restore into a FRESH database, verify, then cut over. Never restore over a
#    live database in place if you can stand up a new one and re-point instead.
createdb ironsight_staging_restore
pg_restore --no-owner --no-privileges -d ironsight_staging_restore staging_*.dump

# 3. Verify row counts / fingerprints match the recovery point, then update the
#    staging site's database binding to the restored database.
```

### Production (operator guidance — do NOT rehearse in prod)

1. Freeze writes if the incident is ongoing corruption (pause the site or the
   offending Function) so the damage does not extend past the recovery point.
2. Prefer the platform point-in-time / history restore to a timestamp just
   before the incident. Restore to a **new** database/branch first; never
   overwrite the live database blind.
3. Verify the restored copy (counts, a fingerprint of key tables, a smoke read
   through `GET /api/worlds/:id`) before repointing production traffic.
4. Reconcile Blobs: any `worlds.artifact_blob_key` present in the restored rows
   whose blob is missing becomes a `failed` publication to re-export; the URL
   fallback keeps those worlds playable meanwhile.
5. Record timing against the RTO and the recovery point against the RPO; file
   the gap as a follow-up if either target was missed.

---

## Application rollback

A publish rollback **does not roll the database back** (runbook, "Rollback").
Traffic and schema move on independent clocks, so:

- Use Netlify's published deploy history to identify the previous known-good
  artifact before changing traffic; before each production release verify that
  the prior deploy is still available (runbook release gate).
- Keep every migration **backwards compatible with both the current and the
  immediately previous application** so restoring the prior deploy leaves the
  expanded schema in place and still working.
- If application behavior regresses: **restore the prior published deploy and
  leave the compatible expanded schema in place.** Do not "roll back" the schema
  to match the old app — forward-correct instead (below).
- If a migration fails: **stop publication** rather than forcing it. A failed
  migration blocks the release by design.

### Rehearsing rollback compatibility (local/staging)

We cannot flip production traffic during a rehearsal, so we rehearse the
*invariant that makes rollback safe*: that the previous app version still runs
against the new (expanded) schema. Concretely — apply the new migration to a
disposable database, then run the previous commit's Function↔Database
integration tests against it. Green means a deploy rollback is safe to perform
without a schema change. This dovetails with issue #3's "automate
expand/migrate/contract compatibility checks across current and previous app
versions."

---

## Forward-correction for migrations (expand / migrate / contract)

Migrations move forward, never backward, in production. A bad migration is fixed
by a **new** migration, not by a down-migration that could destroy data.

- **Expand.** Add new structures additively and nullable/defaulted: new tables,
  new *nullable* columns, new indexes. Both app versions keep working.
- **Migrate data.** Backfill in the background; dual-write from the new app if a
  column is being populated. Never gate the release on a long backfill.
- **Contract.** Only after every running app version no longer needs the old
  shape, and in a **later** release, drop the obsolete column/table.

Rules that keep this safe, each rehearsed or enforced:

- Never add a `NOT NULL` column without a default to a populated table in one
  step — it fails closed (the rehearsal proves this: PostgreSQL rejects it with
  "column … contains null values"). Add it nullable, backfill, then set
  `NOT NULL` in a later migration.
- Every production migration must ship with a **documented forward correction**:
  the specific follow-up migration that fixes the most likely failure, written
  before release (runbook release gate).
- A failed migration stops the publish; the app on the previous deploy keeps
  serving because the schema was still compatible (that is why expand comes
  first).

---

## Rehearsal results (real run, local)

Executed on this branch against a disposable local Postgres 14 database using
`ops/backup-restore-rehearsal.sh`. The script seeds synthetic data, takes a
`pg_dump` recovery point, performs a destructive delete + corrupting mass
update, restores into a fresh database, and verifies the restore is identical to
the recovery point via an order-independent per-table fingerprint. It then
rehearses the expand step, proves a `NOT NULL`-without-default migration fails
closed, and applies a forward correction.

| Step | Result |
| --- | --- |
| Apply repository migration to fresh DB | pass |
| Seed synthetic baseline (2 learners, 2 worlds, 1 run, 2 attempts, 1 reflection, 1 publication) | pass |
| `pg_dump -Fc` backup | ~14 KB, ~90–170 ms |
| Simulate disaster (delete + mass corrupt update) | data diverged from recovery point, confirmed |
| `pg_restore` into fresh DB | ~120–640 ms |
| Restored row counts == baseline | `2\|2\|1\|2\|1\|1` == `2\|2\|1\|2\|1\|1` |
| Restored content fingerprint == recovery point | **match** |
| `BIGSERIAL` sequence healthy after restore (fresh insert works) | pass |
| Broken migration (`NOT NULL` no default on populated table) | rejected: "column … contains null values" |
| Forward correction (nullable + defaulted columns) | applied without destructive rollback |
| Cleanup (all rehearsal databases dropped) | no leftovers |

Timings are for the tiny synthetic slice and only establish that the mechanism
works and is fast at current volume; they are **not** the production RTO. RTO at
production data volume must be measured against a staging copy sized to
production before the targets above are treated as validated.

### Reproduce

```sh
IRONSIGHT_REHEARSAL_ROLE=local ops/backup-restore-rehearsal.sh
# Expected tail:
#   === REHEARSAL COMPLETE — all checks passed
#   fingerprint_match=yes
```

---

## Open follow-ups (tracked in issue #3)

- Confirm and record the production Netlify Database history/PITR retention
  window; schedule the off-platform logical dump and define its retention.
- Add a blob-store export before real evidence uploads begin.
- Size a staging copy to production and measure real RTO to validate the targets.
- Automate the expand/migrate/contract previous-vs-current compatibility check in
  CI (currently rehearsed by hand).
- Tighten RPO/RTO before moderated human-learner studies collect
  non-reconstructable evidence.
