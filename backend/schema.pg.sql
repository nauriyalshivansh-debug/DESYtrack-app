-- ============================================================
-- DESYtrack — PostgreSQL schema (Neon-compatible).
-- Mirrors backend/schema.sql (SQLite) with Postgres types.
-- Timestamps are stored as TEXT in 'YYYY-MM-DD HH24:MI:SS' form to match
-- the app's existing string handling.
-- ============================================================

-- ---------- USERS & ACCESS CONTROL ----------
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE,
  email         TEXT UNIQUE,
  full_name     TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member','partner')),
  organization  TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);

-- ---------- REFERENCE: STATUS WORKFLOW ----------
CREATE TABLE IF NOT EXISTS statuses (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL,
  is_terminal INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS status_transitions (
  from_status TEXT NOT NULL REFERENCES statuses(code),
  to_status   TEXT NOT NULL REFERENCES statuses(code),
  PRIMARY KEY (from_status, to_status)
);

-- ---------- REFERENCE: STATIONS ----------
CREATE TABLE IF NOT EXISTS stations (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  location    TEXT NOT NULL,
  set_status  TEXT REFERENCES statuses(code),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1
);

-- ---------- CORE: SAMPLES ----------
CREATE TABLE IF NOT EXISTS samples (
  id             SERIAL PRIMARY KEY,
  sample_code    TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  description    TEXT,
  material_type  TEXT,
  batch_lot      TEXT,
  origin         TEXT,
  quantity       REAL,
  unit           TEXT,
  storage_location TEXT,
  hazard_class   TEXT,
  owner_org      TEXT,
  current_location TEXT,
  current_station  TEXT REFERENCES stations(code),
  status         TEXT NOT NULL DEFAULT 'received' REFERENCES statuses(code),
  custodian_id   INTEGER REFERENCES users(id),
  created_by     INTEGER NOT NULL REFERENCES users(id),
  received_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  updated_at     TEXT NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_samples_status    ON samples(status);
CREATE INDEX IF NOT EXISTS idx_samples_custodian ON samples(custodian_id);
CREATE INDEX IF NOT EXISTS idx_samples_material  ON samples(material_type);

-- ---------- CHAIN OF CUSTODY / AUDIT EVENTS ----------
CREATE TABLE IF NOT EXISTS custody_events (
  id           SERIAL PRIMARY KEY,
  sample_id    INTEGER NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL CHECK (event_type IN
                 ('created','status_change','transfer','test_logged','note','edit','scan','attachment')),
  from_value   TEXT,
  to_value     TEXT,
  note         TEXT,
  actor_id     INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_custody_sample ON custody_events(sample_id, created_at);

-- ---------- TESTS / ANALYSES ----------
CREATE TABLE IF NOT EXISTS tests (
  id           SERIAL PRIMARY KEY,
  sample_id    INTEGER NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  test_type    TEXT NOT NULL,
  method       TEXT,
  result_value TEXT,
  result_unit  TEXT,
  outcome      TEXT CHECK (outcome IN ('pass','fail','inconclusive','pending')) DEFAULT 'pending',
  performed_by INTEGER REFERENCES users(id),
  performed_at TEXT,
  created_at   TEXT NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_tests_sample ON tests(sample_id);

-- ---------- COMMENTS ----------
CREATE TABLE IF NOT EXISTS comments (
  id         SERIAL PRIMARY KEY,
  sample_id  INTEGER NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared','internal')),
  created_at TEXT NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_comments_sample ON comments(sample_id);

-- ---------- PARTNER ACCESS GRANTS ----------
CREATE TABLE IF NOT EXISTS sample_access (
  sample_id  INTEGER NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  can_edit   INTEGER NOT NULL DEFAULT 0,
  granted_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (sample_id, user_id)
);

-- ---------- ATTACHMENTS / DATA FILES ----------
CREATE TABLE IF NOT EXISTS attachments (
  id           SERIAL PRIMARY KEY,
  sample_id    INTEGER NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  content_type TEXT,
  size_bytes   BIGINT,
  storage_key  TEXT NOT NULL,
  storage_mode TEXT NOT NULL DEFAULT 'local',
  visibility   TEXT NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared','internal')),
  uploaded_by  INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_attach_sample ON attachments(sample_id);
