CREATE TABLE room (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_discord_user_id TEXT NOT NULL REFERENCES account(discord_user_id) ON DELETE CASCADE,
  invite_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE INDEX room_owner_active_idx ON room(owner_discord_user_id, closed_at);

CREATE TABLE room_member (
  room_id TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL REFERENCES account(discord_user_id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  PRIMARY KEY (room_id, discord_user_id)
);

CREATE UNIQUE INDEX room_member_one_active_idx
  ON room_member(discord_user_id) WHERE left_at IS NULL;
CREATE INDEX room_member_room_active_idx ON room_member(room_id, left_at);

ALTER TABLE session_ticket ADD COLUMN room_id TEXT;
