-- Parasyte PCS shared server schema (Cloudflare D1 / SQLite).

-- Append-only command log: the single source of truth that the ledger replays.
CREATE TABLE IF NOT EXISTS commands (
  seq        INTEGER PRIMARY KEY,
  type       TEXT    NOT NULL,
  user_id    TEXT,
  at         INTEGER NOT NULL,
  payload    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

-- Sign-in secrets live here, never in the command log or audit trail.
CREATE TABLE IF NOT EXISTS credentials (
  user_id        TEXT PRIMARY KEY,
  pw_hash        TEXT    NOT NULL,             -- pbkdf2-sha256$iterations$salt$hash (peppered)
  pw_set_at      INTEGER NOT NULL,
  demo           INTEGER NOT NULL DEFAULT 0,   -- 1 = shared demo persona; usable only while DEMO_MODE=on
  totp_secret    TEXT,                         -- AES-GCM sealed
  totp_enabled   INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER NOT NULL DEFAULT 0,   -- replay protection
  failed         INTEGER NOT NULL DEFAULT 0,
  locked_until   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id   TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  used_at   INTEGER,
  PRIMARY KEY (user_id, code_hash)
);

-- Opaque bearer sessions, stored as SHA-256 of the token. stage: full | mfa | mfa_setup.
CREATE TABLE IF NOT EXISTS sessions (
  id_hash    TEXT PRIMARY KEY,
  user_id    TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  stage      TEXT    NOT NULL,
  ip         TEXT,
  ua         TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- Single-use invitation and password-reset links, stored hashed. purpose: invite | reset.
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT    NOT NULL,
  purpose    TEXT    NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS auth_tokens_user ON auth_tokens (user_id, purpose);

CREATE TABLE IF NOT EXISTS mail_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr    TEXT,
  subject    TEXT,
  body       TEXT,
  created_at INTEGER,
  status     TEXT
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
