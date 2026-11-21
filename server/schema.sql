CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS circles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  icon text NOT NULL DEFAULT 'folder',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE circles ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '';
ALTER TABLE circles ADD COLUMN IF NOT EXISTS smart_rules jsonb NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS learning_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('article', 'video', 'pdf', 'markdown', 'local_video', 'image')),
  title text NOT NULL,
  source_url text UNIQUE,
  file_key text,
  file_hash text UNIQUE,
  mime_type text,
  ingest_state text NOT NULL DEFAULT 'queued' CHECK (ingest_state IN ('queued', 'parsing', 'ready', 'failed')),
  learning_state text NOT NULL DEFAULT 'inbox' CHECK (learning_state IN ('inbox', 'learning', 'mastered')),
  ai_state text NOT NULL DEFAULT 'pending' CHECK (ai_state IN ('pending', 'ready', 'unconfigured', 'failed', 'unavailable')),
  ingest_error text,
  ai_error text,
  raw_markdown text NOT NULL DEFAULT '',
  captured_markdown text,
  metadata_json jsonb NOT NULL DEFAULT '{}',
  supersedes_item_id uuid REFERENCES learning_items(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE learning_items ADD COLUMN IF NOT EXISTS starred boolean NOT NULL DEFAULT false;
ALTER TABLE learning_items ADD COLUMN IF NOT EXISTS visited_at timestamptz;

CREATE TABLE IF NOT EXISTS circle_items (
  circle_id uuid NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES learning_items(id) ON DELETE CASCADE,
  PRIMARY KEY (circle_id, item_id)
);
CREATE INDEX IF NOT EXISTS circle_items_item_idx ON circle_items (item_id);

CREATE TABLE IF NOT EXISTS content_anchors (
  id text PRIMARY KEY,
  item_id uuid NOT NULL REFERENCES learning_items(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  text text NOT NULL,
  anchor_meta jsonb NOT NULL DEFAULT '{}',
  embedding vector,
  UNIQUE (item_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS ai_distillations (
  item_id uuid PRIMARY KEY REFERENCES learning_items(id) ON DELETE CASCADE,
  summary jsonb NOT NULL,
  recommended_tags jsonb NOT NULL,
  recommended_circles jsonb NOT NULL,
  key_points_json jsonb NOT NULL,
  model_used text NOT NULL
);

ALTER TABLE IF EXISTS video_notes RENAME TO item_notes;
CREATE TABLE IF NOT EXISTS item_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES learning_items(id) ON DELETE CASCADE,
  seconds double precision CHECK (seconds >= 0),
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE item_notes ALTER COLUMN seconds DROP NOT NULL;

CREATE TABLE IF NOT EXISTS jobs (
  item_id uuid NOT NULL REFERENCES learning_items(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('parse', 'distill', 'embed')),
  lease_until timestamptz,
  lease_token uuid,
  PRIMARY KEY (item_id, kind)
);
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('parse', 'distill', 'embed'));

CREATE TABLE IF NOT EXISTS review_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES learning_items(id) ON DELETE CASCADE,
  anchor_id text,
  front text NOT NULL,
  back text NOT NULL,
  quote text,
  source_kind text NOT NULL DEFAULT 'manual' CHECK (source_kind IN ('manual', 'key_point', 'note')),
  ease_factor double precision NOT NULL DEFAULT 2.5,
  interval_days integer NOT NULL DEFAULT 0,
  repetitions integer NOT NULL DEFAULT 0,
  lapses integer NOT NULL DEFAULT 0,
  due_at timestamptz NOT NULL DEFAULT now(),
  last_reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_cards_due_idx ON review_cards (due_at);
CREATE INDEX IF NOT EXISTS review_cards_item_idx ON review_cards (item_id);

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  scope_type text NOT NULL DEFAULT 'all' CHECK (scope_type IN ('all', 'circle', 'item')),
  scope_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES ai_threads(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  citations_json jsonb NOT NULL DEFAULT '[]',
  model_used text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS widget_json jsonb;
ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS web_sources_json jsonb NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS ai_messages_thread_idx ON ai_messages (thread_id, created_at);
