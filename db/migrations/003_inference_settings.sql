CREATE TABLE inference_settings (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  settings JSONB NOT NULL,
  encrypted_api_key TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
