-- ============================================================
-- SampleTrack — Physical lab/material sample tracking schema
-- Portable SQL. Written for SQLite; notes mark Postgres deltas.
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- USERS & ACCESS CONTROL ----------

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    UNIQUE,            -- login User ID, issued by an admin
  email         TEXT    UNIQUE,            -- optional contact address
  full_name     TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  -- role governs global capability. 'partner' = external, sees only shared samples.
  role          TEXT    NOT NULL DEFAULT 'member'
                        CHECK (role IN ('admin','member','partner')),
  organization  TEXT,                       -- partner's company; NULL for internal staff
  is_active     INTEGER NOT NULL DEFAULT 1,  -- BOOLEAN in Postgres
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------- REFERENCE: STATUS WORKFLOW ----------
-- Statuses are data, not code, so the workflow can evolve without redeploying.
CREATE TABLE IF NOT EXISTS statuses (
  code        TEXT PRIMARY KEY,   -- e.g. 'received'
  label       TEXT NOT NULL,      -- e.g. 'Received'
  sort_order  INTEGER NOT NULL,
  is_terminal INTEGER NOT NULL DEFAULT 0
);

-- Allowed transitions between statuses (a directed graph).
CREATE TABLE IF NOT EXISTS status_transitions (
  from_status TEXT NOT NULL REFERENCES statuses(code),
  to_status   TEXT NOT NULL REFERENCES statuses(code),
  PRIMARY KEY (from_status, to_status)
);

-- ---------- REFERENCE: STATIONS (designated physical spots) ----------
-- A station is a physical spot in the lab with its own QR poster. Scanning a
-- sample at a station records WHERE the sample is (location) and, when the
-- station represents a lifecycle stage, advances the sample's status too.
CREATE TABLE IF NOT EXISTS stations (
  code        TEXT PRIMARY KEY,                 -- e.g. 'STN-TESTING' (QR payload)
  label       TEXT NOT NULL,                    -- e.g. 'Testing Bench'
  location    TEXT NOT NULL,                    -- physical place, e.g. 'Lab 2 · Bench A'
  set_status  TEXT REFERENCES statuses(code),   -- stage this spot moves samples into (NULL = location only)
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1        -- BOOLEAN in Postgres
);

-- ---------- CORE: SAMPLES ----------

CREATE TABLE IF NOT EXISTS samples (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_code    TEXT    NOT NULL UNIQUE,     -- human-facing accession no., e.g. SMP-2026-0001
  name           TEXT    NOT NULL,
  description    TEXT,
  material_type  TEXT,                        -- e.g. 'polymer', 'alloy', 'soil', 'reagent'
  batch_lot      TEXT,                        -- manufacturing batch / lot number
  origin         TEXT,                        -- supplier / field site / project of origin
  quantity       REAL,
  unit           TEXT,                        -- 'g', 'mL', 'pcs'
  storage_location TEXT,                      -- freezer/shelf/bin
  hazard_class   TEXT,                        -- GHS class or 'none'
  owner_org      TEXT,                        -- industry partner (company) that sent/owns this sample
  status         TEXT    NOT NULL DEFAULT 'received'
                         REFERENCES statuses(code),
  -- where the sample physically is right now (set by the last station scan)
  current_location TEXT,
  current_station  TEXT REFERENCES stations(code),
  -- current custodian: who physically holds / is responsible for the sample now
  custodian_id   INTEGER REFERENCES users(id),
  created_by     INTEGER NOT NULL REFERENCES users(id),
  received_at    TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_samples_status    ON samples(status);
CREATE INDEX IF NOT EXISTS idx_samples_custodian ON samples(custodian_id);
CREATE INDEX IF NOT EXISTS idx_samples_material   ON samples(material_type);

-- ---------- CHAIN OF CUSTODY / AUDIT EVENTS ----------
-- Append-only. Every meaningful action writes one immutable row here.
CREATE TABLE IF NOT EXISTS custody_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_id    INTEGER NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  event_type   TEXT    NOT NULL              -- lifecycle actions incl. station scans + file attachments
                       CHECK (event_type IN
                       ('created','status_change','transfer','test_logged','note','edit','scan','attachment')),
  from_value   TEXT,                          -- prior status / prior custodian, when relevant
  to_value     TEXT,                          -- new status / new custodian
  note         TEXT,
  actor_id     INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_custody_sample ON custody_events(sample_id, created_at);

-- ---------- TESTS / ANALYSES ----------
CREATE TABLE IF NOT EXISTS tests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_id    INTEGER NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  test_type    TEXT    NOT NULL,             -- 'tensile','FTIR','pH','microbial', ...
  method       TEXT,                          -- SOP / standard reference, e.g. 'ASTM D638'
  result_value TEXT,                          -- kept as text to hold numbers, ranges, or verdicts
  result_unit  TEXT,
  outcome      TEXT    CHECK (outcome IN ('pass','fail','inconclusive','pending')) DEFAULT 'pending',
  performed_by INTEGER REFERENCES users(id),
  performed_at TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tests_sample ON tests(sample_id);

-- ---------- COMMENTS / COLLABORATION ----------
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_id  INTEGER NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id),
  body       TEXT    NOT NULL,
  -- internal comments are hidden from partner accounts
  visibility TEXT    NOT NULL DEFAULT 'shared'
                     CHECK (visibility IN ('shared','internal')),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_sample ON comments(sample_id);

-- ---------- PARTNER ACCESS GRANTS ----------
-- Row-level sharing: a partner user sees a sample ONLY if a grant row exists.
CREATE TABLE IF NOT EXISTS sample_access (
  sample_id  INTEGER NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  can_edit   INTEGER NOT NULL DEFAULT 0,   -- partners are read-only by default
  granted_by INTEGER REFERENCES users(id),
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (sample_id, user_id)
);

-- ---------- ATTACHMENTS / DATA FILES ----------
-- Files (e.g. beamline scan data) attached to a sample. The bytes live in object
-- storage (S3-compatible) when configured, else on local disk; this row is the
-- metadata + pointer. 'shared' files are visible to granted partners.
CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_id    INTEGER NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  filename     TEXT    NOT NULL,
  content_type TEXT,
  size_bytes   INTEGER,
  storage_key  TEXT    NOT NULL,             -- object key / relative path
  storage_mode TEXT    NOT NULL DEFAULT 'local',  -- 's3' | 'local'
  visibility   TEXT    NOT NULL DEFAULT 'shared'
                       CHECK (visibility IN ('shared','internal')),
  uploaded_by  INTEGER REFERENCES users(id),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attach_sample ON attachments(sample_id);
