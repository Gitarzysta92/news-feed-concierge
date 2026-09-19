CREATE TABLE IF NOT EXISTS articles (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_label TEXT NOT NULL,
        source_quality DOUBLE PRECISION NOT NULL,
        external_id TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        content_status TEXT NOT NULL,
        author TEXT,
        tags_json JSONB NOT NULL,
        image_url TEXT,
        popularity DOUBLE PRECISION NOT NULL,
        published_at TIMESTAMPTZ NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL,
        UNIQUE(source, external_id)
      );

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        weights_json JSONB NOT NULL,
        tag_affinities_json JSONB NOT NULL,
        version INTEGER NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evaluations (
        article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        profile_version INTEGER NOT NULL,
        ranking_algorithm TEXT NOT NULL,
        classic_json JSONB NOT NULL,
        llm_json JSONB,
        final_score DOUBLE PRECISION NOT NULL,
        reason TEXT NOT NULL,
        evaluated_at TIMESTAMPTZ NOT NULL,
        cache_key TEXT,
        PRIMARY KEY(article_id, channel_id)
      );

      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL,
        reaction TEXT NOT NULL,
        signal DOUBLE PRECISION NOT NULL,
        interface TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(channel_id, article_id, actor_id, interface)
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        interface TEXT NOT NULL,
        external_message_id TEXT,
        reason TEXT NOT NULL,
        delivered_at TIMESTAMPTZ NOT NULL,
        UNIQUE(channel_id, article_id, interface)
      );

      CREATE TABLE IF NOT EXISTS delivery_targets (
        interface TEXT NOT NULL,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        installation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY(interface, channel_id)
      );

      CREATE TABLE IF NOT EXISTS ingestion_runs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        fetched_count INTEGER NOT NULL DEFAULT 0,
        new_count INTEGER NOT NULL DEFAULT 0,
        extracted_count INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at TIMESTAMPTZ NOT NULL,
        finished_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_articles_published_id ON articles(published_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_evaluations_channel_score ON evaluations(channel_id, final_score DESC);
      CREATE INDEX IF NOT EXISTS idx_feedback_channel_updated ON feedback(channel_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_feedback_user_channel ON feedback(actor_id, channel_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_deliveries_channel_date ON deliveries(channel_id, delivered_at DESC);
      CREATE INDEX IF NOT EXISTS idx_delivery_targets_interface ON delivery_targets(interface, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_message ON deliveries(external_message_id)
        WHERE external_message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON ingestion_runs(started_at DESC);
