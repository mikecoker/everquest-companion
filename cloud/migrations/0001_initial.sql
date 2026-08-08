PRAGMA foreign_keys = ON;

CREATE TABLE account (
  discord_user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE device (
  id TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL REFERENCES account(discord_user_id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX device_account_active_idx ON device(discord_user_id, revoked_at);

CREATE TABLE pairing (
  code_hash TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL REFERENCES account(discord_user_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX pairing_expiry_idx ON pairing(expires_at, consumed_at);

CREATE TABLE session_ticket (
  token_hash TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL REFERENCES account(discord_user_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('publisher', 'viewer')),
  subject_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX session_ticket_expiry_idx ON session_ticket(expires_at, consumed_at);

CREATE TABLE rate_limit (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

CREATE INDEX rate_limit_expiry_idx ON rate_limit(reset_at);
