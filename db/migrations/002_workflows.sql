CREATE TABLE workflow_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error TEXT
);
CREATE UNIQUE INDEX workflow_jobs_active_key ON workflow_jobs(dedupe_key) WHERE status IN ('queued','running');
CREATE INDEX workflow_jobs_pending ON workflow_jobs(next_attempt_at,created_at) WHERE status IN ('queued','running');
CREATE TABLE delivery_intents (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  interface TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending','sent','uncertain')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(channel_id,article_id,interface)
);
CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  document JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
