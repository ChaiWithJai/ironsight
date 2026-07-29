-- Identity & session continuity for anonymous learners.
--
-- Adds the columns that make the anonymous session bootstrap, consent recording,
-- and learner-held recovery real, plus a non-identifying merge audit. This is an
-- expand-only migration (new nullable columns + new table); it never rewrites or
-- drops existing data, so the previous app version keeps working against it.
--
-- Policy of record: docs/PRIVACY.md (single functional cookie, anonymous-first)
-- and docs/adr/0002-anonymous-session-recovery.md (the recovery/merge/consent
-- decisions this schema serves).

-- Consent (docs/PRIVACY.md §5): the affirmative act that precedes the first
-- durable write is recorded on the learner row. `consent_version` names the
-- notice the learner agreed to so a later policy change is auditable.
ALTER TABLE anonymous_learners
  ADD COLUMN IF NOT EXISTS consent_version TEXT,
  ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ;

-- Recovery (issue #3 "cookie loss/expiry, cross-device recovery"): we store only
-- the SHA-256 hash of a high-entropy secret the LEARNER holds. Without the
-- learner presenting the plaintext the server still cannot re-link them, so the
-- minimal-collection posture in docs/PRIVACY.md §4 is preserved: continuity is a
-- learner-held credential, not a server-side identity graph.
ALTER TABLE anonymous_learners
  ADD COLUMN IF NOT EXISTS recovery_hash TEXT,
  ADD COLUMN IF NOT EXISTS recovery_set_at TIMESTAMPTZ;

-- A recovery secret maps to exactly one learner. Partial index keeps the
-- uniqueness constraint off the many rows that never opt into recovery.
CREATE UNIQUE INDEX IF NOT EXISTS anonymous_learners_recovery_hash_idx
  ON anonymous_learners (recovery_hash)
  WHERE recovery_hash IS NOT NULL;

-- Merge audit (issue #3 "duplicate/merge behavior"): when a learner recovers a
-- canonical identity from a device that had already started an orphan anonymous
-- session, the orphan's owned records are reassigned to the canonical learner
-- and the orphan row is deleted. We keep counts only — never merged content —
-- so a merge is provable without re-collecting what was merged.
CREATE TABLE IF NOT EXISTS identity_merges (
  id BIGSERIAL PRIMARY KEY,
  canonical_id UUID NOT NULL REFERENCES anonymous_learners(id) ON DELETE CASCADE,
  merged_worlds INTEGER NOT NULL DEFAULT 0,
  merged_runs INTEGER NOT NULL DEFAULT 0,
  merged_publications INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
