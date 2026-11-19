PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY,
  email                TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name                 TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  role                 TEXT NOT NULL DEFAULT 'voter' CHECK (role IN ('admin', 'voter')),
  must_change_password INTEGER NOT NULL DEFAULT 1,
  active               INTEGER NOT NULL DEFAULT 1,
  listed               INTEGER NOT NULL DEFAULT 1,   -- appears in open-vote staff lists
  department           TEXT NOT NULL DEFAULT '',
  failed_logins        INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  last_login_at        TEXT,
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  max_votes   INTEGER NOT NULL DEFAULT 1 CHECK (max_votes BETWEEN 1 AND 50),
  active      INTEGER NOT NULL DEFAULT 1,
  -- 'nominees': admins curate the nominees. 'directory': open vote, voters pick a person from the staff list.
  mode        TEXT NOT NULL DEFAULT 'nominees' CHECK (mode IN ('nominees', 'directory')),
  allow_self_vote INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nominees (
  id          INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  bio         TEXT NOT NULL DEFAULT '',
  image       TEXT,
  user_id     INTEGER REFERENCES users(id),   -- set for staff-list candidates (open-vote categories)
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nominees_category ON nominees(category_id);

-- A ballot records THAT a person voted in a category (eligibility / turnout).
-- It deliberately holds no nominee, so the link between voter and choice is never stored.
CREATE TABLE IF NOT EXISTS ballots (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  category_id     INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  selection_count INTEGER NOT NULL CHECK (selection_count >= 1),
  created_at      TEXT NOT NULL,
  UNIQUE (user_id, category_id)
);

-- Votes are anonymous: random id, no user, no timestamp, and no rowid to leak insertion order.
CREATE TABLE IF NOT EXISTS votes (
  id          TEXT PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  nominee_id  INTEGER NOT NULL REFERENCES nominees(id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_votes_nominee ON votes(nominee_id);
CREATE INDEX IF NOT EXISTS idx_votes_category ON votes(category_id);

-- Append-only, hash-chained audit trail.
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  actor_role  TEXT NOT NULL,
  action      TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '',
  ip          TEXT NOT NULL DEFAULT '',
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
