-- Canonical SQLite schema for moneypenny.db.
-- Ported from bot/src CREATE TABLE IF NOT EXISTS at ec464a2.
-- Dual-run: CREATE IF NOT EXISTS is safe; do not ADD COLUMN from both runtimes.
-- Node remains the production writer until BOT_RUNTIME=rust.

PRAGMA foreign_keys = ON;

-- ── Core (bot/src/data/database.ts) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS play_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  botId TEXT NOT NULL,
  songId TEXT NOT NULL,
  songName TEXT NOT NULL,
  artist TEXT NOT NULL,
  album TEXT NOT NULL,
  platform TEXT NOT NULL,
  coverUrl TEXT NOT NULL,
  playedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_play_history_botId ON play_history(botId, id DESC);
CREATE INDEX IF NOT EXISTS idx_play_history_bot_song_played
  ON play_history(botId, songId, playedAt);

CREATE TABLE IF NOT EXISTS bot_instances (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  serverAddress TEXT NOT NULL,
  serverPort INTEGER NOT NULL,
  nickname TEXT NOT NULL,
  defaultChannel TEXT NOT NULL,
  channelPassword TEXT NOT NULL,
  autoStart INTEGER NOT NULL DEFAULT 0,
  serverProtocol TEXT NOT NULL DEFAULT '',
  ts6ApiKey TEXT NOT NULL DEFAULT '',
  serverPassword TEXT NOT NULL DEFAULT '',
  identity TEXT,
  profile_avatar_enabled INTEGER NOT NULL DEFAULT 1,
  profile_description_enabled INTEGER NOT NULL DEFAULT 1,
  profile_nickname_enabled INTEGER NOT NULL DEFAULT 1,
  profile_away_enabled INTEGER NOT NULL DEFAULT 1,
  profile_channel_desc_enabled INTEGER NOT NULL DEFAULT 1,
  profile_now_playing_enabled INTEGER NOT NULL DEFAULT 1,
  custom_avatar_path TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  passwordHash TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin'
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  lastSeenAt INTEGER NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_userId ON sessions(userId);
CREATE INDEX IF NOT EXISTS idx_sessions_expiresAt ON sessions(expiresAt);

CREATE TABLE IF NOT EXISTS user_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  actorId TEXT,
  actorUsername TEXT,
  targetUserId TEXT,
  targetUsername TEXT,
  action TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_audit_timestamp ON user_audit(timestamp DESC);

-- ── Memory / KG / doctrine / ingest ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_uid TEXT NOT NULL,
  fact TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_memory_uid ON user_memory(user_uid);

CREATE TABLE IF NOT EXISTS kg_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  fact TEXT NOT NULL,
  valid_from TEXT,
  valid_until TEXT,
  diary TEXT,
  created_by_uid TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_subject ON kg_facts(subject);
CREATE INDEX IF NOT EXISTS idx_kg_created ON kg_facts(created_at DESC);

CREATE TABLE IF NOT EXISTS doctrine_docs (
  source TEXT PRIMARY KEY,
  classification TEXT NOT NULL DEFAULT 'unclassified',
  tags TEXT NOT NULL DEFAULT '',
  valid_until TEXT,
  chunks INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ingested_files (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT '',
  ingested_at INTEGER NOT NULL
);

-- ── Radio / music ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS track_tags (
  track_key TEXT PRIMARY KEY,
  genre TEXT, subgenre TEXT, mood TEXT,
  musical_key TEXT, key_scale TEXT, bpm INTEGER, energy REAL, danceability REAL,
  bumper INTEGER NOT NULL DEFAULT 0,
  bumper_kind TEXT,
  ops_scope TEXT,
  rating_avg REAL, rating_count INTEGER,
  source TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_track_tags_bumper ON track_tags(bumper);

CREATE TABLE IF NOT EXISTS track_ratings (
  track_key TEXT NOT NULL,
  rater TEXT NOT NULL,
  stars INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (track_key, rater)
);

CREATE TABLE IF NOT EXISTS yt_saved (
  video_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  duration INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bumper_cache (
  hash TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  built_floor TEXT NOT NULL,
  voice TEXT,
  format TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playback_blacklist (
  track_key TEXT PRIMARY KEY,
  platform TEXT,
  name TEXT,
  artist TEXT,
  reason TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

-- ── Hangar / economy / roast ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hangar_profiles (
  owner_key TEXT PRIMARY KEY,
  uid TEXT,
  callsign TEXT,
  display_name TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hangar_profiles_uid ON hangar_profiles(uid);
CREATE INDEX IF NOT EXISTS idx_hangar_profiles_cs ON hangar_profiles(callsign);

CREATE TABLE IF NOT EXISTS user_ships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key TEXT NOT NULL,
  ship_id TEXT NOT NULL,
  ship_name TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  catalog_matched INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_key, ship_id)
);
CREATE INDEX IF NOT EXISTS idx_user_ships_owner ON user_ships(owner_key);
CREATE INDEX IF NOT EXISTS idx_user_ships_name ON user_ships(ship_name);

CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  lines_json TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_orders_created ON work_orders(created_at DESC);

CREATE TABLE IF NOT EXISTS economy_cache (
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (source, key)
);
CREATE INDEX IF NOT EXISTS idx_economy_cache_exp ON economy_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_economy_cache_fetched ON economy_cache(fetched_at);

CREATE TABLE IF NOT EXISTS roast_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_uid TEXT NOT NULL,
  user_name TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  score INTEGER,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_roast_quotes_score ON roast_quotes(score);

CREATE TABLE IF NOT EXISTS roast_optout (
  user_uid TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS roast_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
