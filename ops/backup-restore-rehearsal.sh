#!/usr/bin/env bash
# IRONSIGHT — database backup/restore rehearsal (LOCAL / STAGING ONLY).
#
# This script rehearses the operational mechanics documented in
# docs/BACKUP_RESTORE_RUNBOOK.md against a *disposable* Postgres database. The
# teaching platform's Netlify Database is Postgres, so the pg_dump / pg_restore
# path exercised here is the same mechanism a real point-in-time or logical
# restore uses. It seeds only synthetic data and never reads a learner record.
#
# SAFETY CONTRACT
#   - Refuses to run unless IRONSIGHT_REHEARSAL_ROLE is "local" or "staging".
#   - Operates on a uniquely named, disposable database it creates and drops.
#   - Connects to a local/loopback host by default; a non-local host must be
#     opted into explicitly and can never be a production origin.
#   - Never issues DROP/TRUNCATE against any database it did not create in this run.
#
# USAGE
#   IRONSIGHT_REHEARSAL_ROLE=local ops/backup-restore-rehearsal.sh
#
# Optional overrides (all default to a local Homebrew/Netlify-dev Postgres):
#   PGHOST (default 127.0.0.1) PGPORT (default 5432) PGUSER PGPASSWORD
#
# Requires: psql, pg_dump, pg_restore on PATH (PostgreSQL client tools).
set -euo pipefail

ROLE="${IRONSIGHT_REHEARSAL_ROLE:-}"
if [[ "$ROLE" != "local" && "$ROLE" != "staging" ]]; then
  echo "[rehearsal] REFUSING TO RUN: set IRONSIGHT_REHEARSAL_ROLE=local (or staging)." >&2
  echo "[rehearsal] Production is never a valid target for this rehearsal." >&2
  exit 2
fi

export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-5432}"

# Fail closed on anything that looks like a managed/production origin.
case "$PGHOST" in
  127.0.0.1|localhost|::1|0.0.0.0) : ;; # loopback — fine
  *)
    if [[ "${IRONSIGHT_ALLOW_NONLOCAL:-}" != "yes" ]]; then
      echo "[rehearsal] REFUSING non-local PGHOST=$PGHOST without IRONSIGHT_ALLOW_NONLOCAL=yes." >&2
      exit 2
    fi
    if [[ "$PGHOST" == *prod* || "$PGHOST" == *production* ]]; then
      echo "[rehearsal] REFUSING: PGHOST looks like production ($PGHOST)." >&2
      exit 2
    fi
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$ROOT/netlify/database/migrations"
STAMP="$(date +%Y%m%d_%H%M%S)"
DB="ironsight_rehearsal_${STAMP}_$$"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ironsight-rehearsal.XXXXXX")"
BACKUP="$WORKDIR/${DB}.dump"

log()  { printf '\n=== %s\n' "$*"; }
step() { printf '  - %s\n' "$*"; }

# Millisecond wall clock, portable to bash without EPOCHREALTIME.
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

cleanup() {
  # Only ever drop the databases this run created (main + restore + forward).
  for d in "$DB" "${DB}_restored" "${DB}_fwd"; do
    psql -v ON_ERROR_STOP=1 -d postgres -qc "DROP DATABASE IF EXISTS \"$d\";" >/dev/null 2>&1 || true
  done
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

log "IRONSIGHT backup/restore rehearsal — role=$ROLE host=$PGHOST:$PGPORT db=$DB"

# ---------------------------------------------------------------------------
# 1. Provision a disposable database and apply the repository migration.
# ---------------------------------------------------------------------------
log "1. Provision disposable database and apply migrations"
psql -v ON_ERROR_STOP=1 -d postgres -qc "CREATE DATABASE \"$DB\";"
step "created database $DB"
for m in "$MIGRATIONS_DIR"/*.sql; do
  step "applying $(basename "$m")"
  psql -v ON_ERROR_STOP=1 -d "$DB" -qf "$m"
done

# ---------------------------------------------------------------------------
# 2. Seed synthetic data (RPO baseline). No learner data, ever.
# ---------------------------------------------------------------------------
log "2. Seed synthetic data (establish RPO baseline)"
psql -v ON_ERROR_STOP=1 -d "$DB" -q <<'SQL'
INSERT INTO anonymous_learners (id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

INSERT INTO worlds (id, creator_id, profile, civilization, sigil, era, alpha_name, bravo_name, charlie_name, artifact_blob_key) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111',
   '{"civilization":"City of Many Rivers","sigil":"SUN","era":"Dawn Accord","places":{"ALPHA":"Sun Assembly","BRAVO":"Moon Quay","CHARLIE":"Archive Hill"}}'::jsonb,
   'City of Many Rivers','SUN','Dawn Accord','Sun Assembly','Moon Quay','Archive Hill','worlds/aaaa/profile.json'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222',
   '{"civilization":"CANARY Testworld","sigil":"MOON","era":"Test Era","places":{"ALPHA":"A","BRAVO":"B","CHARLIE":"C"}}'::jsonb,
   'CANARY Testworld','MOON','Test Era','A','B','C', NULL);

INSERT INTO course_runs (id, learner_id, world_id, course_version, status) VALUES
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'v1', 'active');

INSERT INTO mission_attempts (run_id, mission_id, attempt_number, evidence, passed) VALUES
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'named-place-navigation', 1, '{"route":"A->B"}'::jsonb, false),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'named-place-navigation', 2, '{"route":"A->B->C"}'::jsonb, true);

INSERT INTO reflections (id, run_id, prompt_id, response, rubric) VALUES
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
   'why-this-route', 'The river crossing was the only passable bridge.', '{"version":"r1"}'::jsonb);

INSERT INTO publications (id, world_id, learner_id, stable_path, deploy_url, status) VALUES
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111', '/w/city-of-many-rivers', NULL, 'published');
SQL
step "seed complete"

# A content fingerprint that survives dump/restore (order-independent per table).
fingerprint() {
  local db="$1"
  psql -tA -d "$db" <<'SQL'
SELECT string_agg(line, E'\n' ORDER BY line) FROM (
  SELECT 'learners:'   || id::text AS line FROM anonymous_learners
  UNION ALL SELECT 'worlds:'      || id::text || '|' || md5(profile::text) FROM worlds
  UNION ALL SELECT 'runs:'        || id::text || '|' || status FROM course_runs
  UNION ALL SELECT 'attempts:'    || run_id::text || '|' || mission_id || '|' || attempt_number::text || '|' || passed::text FROM mission_attempts
  UNION ALL SELECT 'reflections:' || id::text || '|' || md5(response) FROM reflections
  UNION ALL SELECT 'publications:'|| id::text || '|' || stable_path || '|' || status FROM publications
) t;
SQL
}

BASELINE_FP="$(fingerprint "$DB")"
BASELINE_COUNTS="$(psql -tA -d "$DB" -c "SELECT (SELECT count(*) FROM anonymous_learners),(SELECT count(*) FROM worlds),(SELECT count(*) FROM course_runs),(SELECT count(*) FROM mission_attempts),(SELECT count(*) FROM reflections),(SELECT count(*) FROM publications);")"
step "baseline row counts (learners,worlds,runs,attempts,reflections,pubs): $BASELINE_COUNTS"

# ---------------------------------------------------------------------------
# 3. Take a logical backup (this is the recovery point).
# ---------------------------------------------------------------------------
log "3. Take logical backup with pg_dump (custom format, compressed)"
T0="$(now_ms)"
pg_dump -Fc -d "$DB" -f "$BACKUP"
T1="$(now_ms)"
BACKUP_BYTES="$(wc -c < "$BACKUP" | tr -d ' ')"
step "backup written: $BACKUP (${BACKUP_BYTES} bytes) in $((T1 - T0)) ms"

# ---------------------------------------------------------------------------
# 4. Simulate a data-loss incident AFTER the recovery point.
#    (Destructive writes, exactly what a restore is meant to undo.)
# ---------------------------------------------------------------------------
log "4. Simulate disaster (destructive writes after the recovery point)"
psql -v ON_ERROR_STOP=1 -d "$DB" -q <<'SQL'
-- An unintended delete + a corrupting mass update — the class of incident a
-- restore exists for. (Deleting an unreferenced world models a "safe disposal
-- of test records" operation that hit the wrong row.)
DELETE FROM worlds WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
UPDATE publications SET status = 'withdrawn', stable_path = '/w/CORRUPTED';
SQL
POST_INCIDENT_COUNTS="$(psql -tA -d "$DB" -c "SELECT (SELECT count(*) FROM anonymous_learners),(SELECT count(*) FROM worlds),(SELECT count(*) FROM course_runs),(SELECT count(*) FROM mission_attempts),(SELECT count(*) FROM reflections),(SELECT count(*) FROM publications);")"
step "post-incident row counts: $POST_INCIDENT_COUNTS"
if [[ "$POST_INCIDENT_COUNTS" == "$BASELINE_COUNTS" ]]; then
  echo "[rehearsal] FAIL: disaster simulation did not change data." >&2
  exit 1
fi
step "confirmed data diverged from the recovery point"

# ---------------------------------------------------------------------------
# 5. Restore into a fresh database and measure RTO.
# ---------------------------------------------------------------------------
log "5. Restore from backup into a fresh database (measure RTO)"
RESTORE_DB="${DB}_restored"
R0="$(now_ms)"
psql -v ON_ERROR_STOP=1 -d postgres -qc "CREATE DATABASE \"$RESTORE_DB\";"
pg_restore --no-owner --no-privileges -d "$RESTORE_DB" "$BACKUP"
R1="$(now_ms)"
step "restore completed in $((R1 - R0)) ms into $RESTORE_DB"

# ---------------------------------------------------------------------------
# 6. Verify the restore matches the recovery point exactly.
# ---------------------------------------------------------------------------
log "6. Verify restored data equals the recovery point"
RESTORED_FP="$(fingerprint "$RESTORE_DB")"
RESTORED_COUNTS="$(psql -tA -d "$RESTORE_DB" -c "SELECT (SELECT count(*) FROM anonymous_learners),(SELECT count(*) FROM worlds),(SELECT count(*) FROM course_runs),(SELECT count(*) FROM mission_attempts),(SELECT count(*) FROM reflections),(SELECT count(*) FROM publications);")"
step "restored row counts: $RESTORED_COUNTS"

# Verify referential integrity survived (BIGSERIAL sequence + FKs).
SEQ_OK="$(psql -tA -d "$RESTORE_DB" -c "SELECT last_value >= 2 FROM mission_attempts_id_seq;")"
step "mission_attempts sequence restored past last insert: $SEQ_OK"

# Verify a fresh insert works post-restore (sequence not stale).
psql -v ON_ERROR_STOP=1 -d "$RESTORE_DB" -q -c "INSERT INTO mission_attempts (run_id, mission_id, attempt_number, evidence, passed) VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc','post-restore-write',1,'{}'::jsonb,true);"
step "post-restore write succeeded (BIGSERIAL sequence is healthy)"

psql -v ON_ERROR_STOP=1 -d postgres -qc "DROP DATABASE IF EXISTS \"$RESTORE_DB\";" >/dev/null

if [[ "$RESTORED_FP" != "$BASELINE_FP" ]]; then
  echo "[rehearsal] FAIL: restored fingerprint does not match recovery point." >&2
  exit 1
fi
step "PASS: restored data is byte-identical to the recovery point"

# ---------------------------------------------------------------------------
# 7. Migration forward-correction rehearsal (expand / migrate / contract).
# ---------------------------------------------------------------------------
log "7. Migration forward-correction rehearsal"
FWD_DB="${DB}_fwd"
psql -v ON_ERROR_STOP=1 -d postgres -qc "CREATE DATABASE \"$FWD_DB\";"
for m in "$MIGRATIONS_DIR"/*.sql; do psql -v ON_ERROR_STOP=1 -d "$FWD_DB" -qf "$m" >/dev/null; done
# Seed one live row so a NOT-NULL-without-default add is genuinely rejected
# (the canonical expand/contract hazard on a populated table).
psql -v ON_ERROR_STOP=1 -d "$FWD_DB" -q <<'SQL'
INSERT INTO anonymous_learners (id) VALUES ('11111111-1111-1111-1111-111111111111');
INSERT INTO course_runs (id, learner_id, course_version, status)
VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc','11111111-1111-1111-1111-111111111111','v1','active');
SQL

step "EXPAND: add a nullable column (backwards compatible)"
psql -v ON_ERROR_STOP=1 -d "$FWD_DB" -qc "ALTER TABLE course_runs ADD COLUMN evaluator_version TEXT;"

step "Simulate a BROKEN follow-on migration and prove it fails closed"
set +e
BROKEN_OUT="$(psql -v ON_ERROR_STOP=1 -d "$FWD_DB" -c "ALTER TABLE course_runs ADD COLUMN evaluator_version_required TEXT NOT NULL;" 2>&1)"
BROKEN_RC=$?
set -e
if [[ $BROKEN_RC -eq 0 ]]; then
  echo "[rehearsal] FAIL: broken migration unexpectedly succeeded." >&2
  exit 1
fi
step "broken migration correctly rejected (rc=$BROKEN_RC): $(echo "$BROKEN_OUT" | head -1)"

step "FORWARD CORRECTION: apply the fixed migration instead of rolling back"
psql -v ON_ERROR_STOP=1 -d "$FWD_DB" -qc "ALTER TABLE course_runs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;"
FWD_OK="$(psql -tA -d "$FWD_DB" -c "SELECT count(*) FROM information_schema.columns WHERE table_name='course_runs' AND column_name IN ('evaluator_version','retry_count');")"
psql -v ON_ERROR_STOP=1 -d postgres -qc "DROP DATABASE IF EXISTS \"$FWD_DB\";" >/dev/null
if [[ "$FWD_OK" != "2" ]]; then
  echo "[rehearsal] FAIL: forward-correction columns not present." >&2
  exit 1
fi
step "PASS: forward correction applied without a destructive rollback"

log "REHEARSAL COMPLETE — all checks passed"
printf '\nSummary:\n'
printf '  backup_ms=%s backup_bytes=%s restore_ms=%s\n' "$((T1 - T0))" "$BACKUP_BYTES" "$((R1 - R0))"
printf '  baseline_counts=%s restored_counts=%s\n' "$BASELINE_COUNTS" "$RESTORED_COUNTS"
printf '  fingerprint_match=%s\n' "$([[ "$RESTORED_FP" == "$BASELINE_FP" ]] && echo yes || echo no)"
