CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL,
  name TEXT NOT NULL,
  owner_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  artwork TEXT,
  preview TEXT,
  links TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  yt TEXT
);
CREATE INDEX IF NOT EXISTS songs_month ON songs (month, created_at);
CREATE INDEX IF NOT EXISTS songs_owner ON songs (owner_hash, month);

CREATE TABLE IF NOT EXISTS likes (
  song_id TEXT NOT NULL,
  owner_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (song_id, owner_hash)
);
