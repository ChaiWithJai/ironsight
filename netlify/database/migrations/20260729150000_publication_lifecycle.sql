-- Publication lifecycle: ownership listing, immutable revisions, withdrawal, and
-- safe disposal of canary/test records — all with a durable audit trail.
--
-- Design decisions (see PR body for full rationale):
--   * Worlds stay IMMUTABLE. "Editing" a world publishes a NEW immutable world with
--     its own stable id/URL and records lineage via supersedes_id. The predecessor
--     stays 'published' and readable forever, so no stable URL ever changes meaning.
--   * Withdrawal is the only status transition on an existing world. A withdrawn
--     world's durable record leaves public reads (410 Gone), but the URL contract it
--     encodes still boots the same civilization via the offline URL fallback, so the
--     shared link's *meaning* is preserved even though its durable copy is not.
--   * Disposal is a hard delete restricted to rows explicitly flagged disposable,
--     reachable only through a secret-guarded maintenance endpoint.

ALTER TABLE worlds
  ADD COLUMN status TEXT NOT NULL DEFAULT 'published'
    CHECK (status IN ('published', 'withdrawn')),
  ADD COLUMN supersedes_id UUID REFERENCES worlds(id),
  ADD COLUMN disposable BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN withdrawn_at TIMESTAMPTZ;

-- Owner listing walks (creator_id, status, created_at); disposal sweeps disposable rows.
CREATE INDEX worlds_creator_status_idx ON worlds (creator_id, status, created_at DESC);
CREATE INDEX worlds_disposable_idx ON worlds (disposable) WHERE disposable;

-- Append-only audit log. Intentionally NOT foreign-keyed to worlds: a disposal
-- hard-deletes the world row, but the record that it happened must survive. Each
-- event snapshots enough context (actor, reason, detail) to reconstruct intent.
CREATE TABLE world_events (
  id BIGSERIAL PRIMARY KEY,
  world_id UUID NOT NULL,
  actor_id UUID,
  actor_kind TEXT NOT NULL DEFAULT 'learner'
    CHECK (actor_kind IN ('learner', 'maintenance')),
  action TEXT NOT NULL
    CHECK (action IN ('published', 'revised', 'withdrawn', 'disposed')),
  reason TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX world_events_world_idx ON world_events (world_id, created_at DESC);
CREATE INDEX world_events_action_idx ON world_events (action, created_at DESC);
