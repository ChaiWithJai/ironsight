CREATE TABLE anonymous_learners (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE worlds (
  id UUID PRIMARY KEY,
  creator_id UUID NOT NULL REFERENCES anonymous_learners(id),
  profile JSONB NOT NULL,
  civilization TEXT NOT NULL,
  sigil TEXT NOT NULL,
  era TEXT NOT NULL,
  alpha_name TEXT NOT NULL,
  bravo_name TEXT NOT NULL,
  charlie_name TEXT NOT NULL,
  artifact_blob_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX worlds_creator_created_idx ON worlds (creator_id, created_at DESC);
CREATE INDEX worlds_created_idx ON worlds (created_at DESC);

CREATE TABLE course_runs (
  id UUID PRIMARY KEY,
  learner_id UUID NOT NULL REFERENCES anonymous_learners(id),
  world_id UUID REFERENCES worlds(id),
  course_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX course_runs_learner_idx ON course_runs (learner_id, started_at DESC);

CREATE TABLE mission_attempts (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES course_runs(id) ON DELETE CASCADE,
  mission_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  evidence JSONB NOT NULL,
  passed BOOLEAN NOT NULL,
  artifact_blob_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, mission_id, attempt_number)
);

CREATE TABLE reflections (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES course_runs(id) ON DELETE CASCADE,
  prompt_id TEXT NOT NULL,
  response TEXT NOT NULL,
  rubric JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE publications (
  id UUID PRIMARY KEY,
  world_id UUID NOT NULL REFERENCES worlds(id),
  learner_id UUID NOT NULL REFERENCES anonymous_learners(id),
  stable_path TEXT NOT NULL UNIQUE,
  deploy_url TEXT,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'withdrawn', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
