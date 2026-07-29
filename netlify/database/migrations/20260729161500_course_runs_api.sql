-- Expand-only migration for the course-runs API (issue #3, P0 learner loop).
--
-- The first teaching-platform migration created course_runs, mission_attempts,
-- reflections and publications as bare tables. This migration adds the
-- provenance and idempotency columns the durable-progress API needs WITHOUT
-- rewriting or dropping anything: every addition is nullable or defaulted, so a
-- deployment running the world-publication slice keeps working while the new
-- Functions roll out (expand/migrate/contract, per ADR 0001).

-- COURSE RUNS ---------------------------------------------------------------
-- last_activity_at lets "resume" surface the freshest run and lets a future
-- retention sweep find dormant anonymous runs without reading every attempt.
ALTER TABLE course_runs
  ADD COLUMN last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- At most one *active* run per learner per course version. Resuming returns the
-- existing row instead of forking a learner's history across tabs/devices;
-- completed and abandoned runs are exempt so a learner may re-take a course
-- they already finished. This is the concurrency contract for start/resume.
CREATE UNIQUE INDEX course_runs_one_active_idx
  ON course_runs (learner_id, course_version)
  WHERE status = 'active';

-- MISSION ATTEMPTS ----------------------------------------------------------
-- idempotency_key: client-generated per submission. A retried or duplicated
--   submit (offline flush, double-click, second tab) collapses onto the same
--   stored attempt instead of inserting a duplicate.
-- evaluator_version: which rubric version produced pass/fail, so a later rubric
--   change never silently reinterprets old evidence.
-- evidence_bytes / evidence_sha256: integrity + size metadata for the immutable
--   Blob copy of the evidence, kept relationally in Postgres.
-- evidence_status: 'inline'  = only the JSONB copy exists,
--                  'stored'  = immutable Blob export succeeded,
--                  'skipped' = Blob unavailable; DB row is still authoritative.
ALTER TABLE mission_attempts
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN evaluator_version TEXT NOT NULL DEFAULT 'unversioned',
  ADD COLUMN evidence_bytes INTEGER,
  ADD COLUMN evidence_sha256 TEXT,
  ADD COLUMN evidence_status TEXT NOT NULL DEFAULT 'inline'
    CHECK (evidence_status IN ('inline', 'stored', 'skipped'));

-- Idempotent replay key, unique within a run. Partial so historical rows that
-- predate the column (idempotency_key IS NULL) are unaffected.
CREATE UNIQUE INDEX mission_attempts_idempotency_idx
  ON mission_attempts (run_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Read path for resume/hydration: newest attempts first within a run.
CREATE INDEX mission_attempts_run_created_idx
  ON mission_attempts (run_id, created_at DESC);

-- REFLECTIONS ---------------------------------------------------------------
-- prompt_version / rubric_version / evaluator_version pin the exact wording a
-- learner answered and the rubric an evaluator would grade against.
-- updated_at tracks edit-in-place revisions.
ALTER TABLE reflections
  ADD COLUMN prompt_version TEXT NOT NULL DEFAULT 'unversioned',
  ADD COLUMN rubric_version TEXT,
  ADD COLUMN evaluator_version TEXT,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Safe size limit enforced in the database, not just the app: a free-text
-- explanation is capped so a single reflection cannot become an abuse vector.
ALTER TABLE reflections
  ADD CONSTRAINT reflections_response_length CHECK (char_length(response) <= 4000);

-- Edit-in-place: one reflection per (run, prompt). A learner refining an
-- explanation updates the same row instead of accreting duplicates.
CREATE UNIQUE INDEX reflections_run_prompt_idx ON reflections (run_id, prompt_id);
