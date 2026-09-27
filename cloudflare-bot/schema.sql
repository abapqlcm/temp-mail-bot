-- Temp Mail Bot — D1 schema
-- همگون با INIT_SQL داخل cloudflare-bot/worker.js (هر تغییری اینجا هم باید بیاد)

CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  address TEXT NOT NULL UNIQUE,
  label TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used INTEGER DEFAULT 0,
  expires_at INTEGER DEFAULT 0,
  last_seen INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  sender TEXT,
  subject TEXT,
  body TEXT,
  raw_snippet TEXT,
  received_at INTEGER NOT NULL,
  html_raw TEXT DEFAULT '',
  is_read INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_addr_user ON addresses(user_id);
CREATE INDEX IF NOT EXISTS idx_mails_addr ON mails(address, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_user ON sessions(user_id);
