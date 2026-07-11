import Database from "better-sqlite3";

export interface PlayHistoryEntry {
  botId: string;
  songId: string;
  songName: string;
  artist: string;
  album: string;
  platform: "local" | "youtube" | "stream";
  coverUrl: string;
}

export interface PlayHistoryRecord extends PlayHistoryEntry {
  id: number;
  playedAt: string;
}

export interface BotInstance {
  id: string;
  name: string;
  serverAddress: string;
  serverPort: number;
  nickname: string;
  defaultChannel: string;
  channelPassword: string;
  autoStart: boolean;
  /** "ts3" | "ts6" | "" (empty = auto-detect) */
  serverProtocol: string;
  /** API key for TS6 HTTP Query */
  ts6ApiKey: string;
  /** Password to join the TS server (server password) */
  serverPassword: string;
  identity?: string;
}

export interface ProfileConfig {
  avatarEnabled: boolean;
  descriptionEnabled: boolean;
  nicknameEnabled: boolean;
  awayStatusEnabled: boolean;
  channelDescEnabled: boolean;
  nowPlayingMsgEnabled: boolean;
}

export const DEFAULT_PROFILE_CONFIG: ProfileConfig = {
  avatarEnabled: true,
  descriptionEnabled: true,
  nicknameEnabled: true,
  awayStatusEnabled: true,
  channelDescEnabled: true,
  nowPlayingMsgEnabled: true,
};

export interface BotDatabase {
  db: Database.Database;
  addPlayHistory(entry: PlayHistoryEntry): void;
  getPlayHistory(botId: string, limit: number): PlayHistoryRecord[];
  /**
   * Song ids that have been played `maxPlays` or more times within the last
   * `cooldownHours` (auto-DJ anti-repeat). Empty set when disabled/invalid.
   */
  getAutoDjSaturatedSongIds(
    botId: string,
    maxPlays: number,
    cooldownHours: number,
  ): Set<string>;
  saveBotInstance(instance: BotInstance): void;
  getBotInstances(): BotInstance[];
  deleteBotInstance(id: string): boolean;
  getProfileConfig(botId: string): ProfileConfig;
  saveProfileConfig(botId: string, config: ProfileConfig): void;
  getCustomAvatarPath(botId: string): string | null;
  setCustomAvatarPath(botId: string, path: string | null): void;
  close(): void;
}

function migrateSchema(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(bot_instances)").all() as Array<{ name: string }>;
  const names = columns.map((c) => c.name);
  if (!names.includes("identity")) {
    db.exec("ALTER TABLE bot_instances ADD COLUMN identity TEXT");
  }
  if (!names.includes("serverProtocol")) {
    db.exec("ALTER TABLE bot_instances ADD COLUMN serverProtocol TEXT NOT NULL DEFAULT ''");
  }
  if (!names.includes("ts6ApiKey")) {
    db.exec("ALTER TABLE bot_instances ADD COLUMN ts6ApiKey TEXT NOT NULL DEFAULT ''");
  }
  if (!names.includes("serverPassword")) {
    db.exec("ALTER TABLE bot_instances ADD COLUMN serverPassword TEXT NOT NULL DEFAULT ''");
  }
  // Profile feature flags
  const profileCols = [
    "profile_avatar_enabled",
    "profile_description_enabled",
    "profile_nickname_enabled",
    "profile_away_enabled",
    "profile_channel_desc_enabled",
    "profile_now_playing_enabled",
  ];
  for (const col of profileCols) {
    if (!names.includes(col)) {
      db.exec(`ALTER TABLE bot_instances ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 1`);
    }
  }
  if (!names.includes("custom_avatar_path")) {
    db.exec("ALTER TABLE bot_instances ADD COLUMN custom_avatar_path TEXT");
  }

  const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  const userColNames = userColumns.map((c) => c.name);
  if (!userColNames.includes("role")) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
  }
}

function initTables(db: Database.Database): void {
  db.exec(`
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
      identity TEXT
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
  `);
}

export function createDatabase(dbPath: string): BotDatabase {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initTables(db);
  migrateSchema(db);

  const insertHistory = db.prepare(`
    INSERT INTO play_history (botId, songId, songName, artist, album, platform, coverUrl)
    VALUES (@botId, @songId, @songName, @artist, @album, @platform, @coverUrl)
  `);

  const selectHistory = db.prepare(`
    SELECT * FROM play_history WHERE botId = ? ORDER BY id DESC LIMIT ?
  `);

  // Rolling-window play counts for auto-DJ repeat cooldown.
  // playedAt is TEXT datetime('now') UTC — compare with the same form.
  const selectSaturatedSongIds = db.prepare(`
    SELECT songId, COUNT(*) AS n
    FROM play_history
    WHERE botId = ?
      AND playedAt >= datetime('now', ?)
    GROUP BY songId
    HAVING n >= ?
  `);

  const upsertInstance = db.prepare(`
    INSERT INTO bot_instances (id, name, serverAddress, serverPort, nickname, defaultChannel, channelPassword, autoStart, serverProtocol, ts6ApiKey, serverPassword, identity)
    VALUES (@id, @name, @serverAddress, @serverPort, @nickname, @defaultChannel, @channelPassword, @autoStart, @serverProtocol, @ts6ApiKey, @serverPassword, @identity)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      serverAddress = excluded.serverAddress,
      serverPort = excluded.serverPort,
      nickname = excluded.nickname,
      defaultChannel = excluded.defaultChannel,
      channelPassword = excluded.channelPassword,
      autoStart = excluded.autoStart,
      serverProtocol = excluded.serverProtocol,
      ts6ApiKey = excluded.ts6ApiKey,
      serverPassword = excluded.serverPassword,
      identity = excluded.identity
  `);

  const selectInstances = db.prepare(`SELECT * FROM bot_instances`);

  const deleteInstance = db.prepare(`DELETE FROM bot_instances WHERE id = ?`);

  const selectProfileConfig = db.prepare(`
    SELECT profile_avatar_enabled, profile_description_enabled,
           profile_nickname_enabled, profile_away_enabled,
           profile_channel_desc_enabled, profile_now_playing_enabled
    FROM bot_instances WHERE id = ?
  `);

  const updateProfileConfig = db.prepare(`
    UPDATE bot_instances SET
      profile_avatar_enabled = @avatar,
      profile_description_enabled = @description,
      profile_nickname_enabled = @nickname,
      profile_away_enabled = @away,
      profile_channel_desc_enabled = @channelDesc,
      profile_now_playing_enabled = @nowPlaying
    WHERE id = @id
  `);

  const selectCustomAvatar = db.prepare(`SELECT custom_avatar_path FROM bot_instances WHERE id = ?`);
  const updateCustomAvatar = db.prepare(`UPDATE bot_instances SET custom_avatar_path = ? WHERE id = ?`);

  return {
    db,

    addPlayHistory(record) {
      insertHistory.run(record);
    },

    getPlayHistory(botId, limit) {
      return selectHistory.all(botId, limit) as PlayHistoryRecord[];
    },

    getAutoDjSaturatedSongIds(botId, maxPlays, cooldownHours) {
      if (!botId || !Number.isFinite(maxPlays) || maxPlays < 1) return new Set();
      if (!Number.isFinite(cooldownHours) || cooldownHours <= 0) return new Set();
      // SQLite modifier: '-12 hours' / '-0.5 hours' (fractional hours ok as string).
      const mod = `-${cooldownHours} hours`;
      const rows = selectSaturatedSongIds.all(botId, mod, Math.floor(maxPlays)) as Array<{
        songId: string;
        n: number;
      }>;
      return new Set(rows.map((r) => r.songId).filter(Boolean));
    },

    saveBotInstance(instance) {
      upsertInstance.run({
        ...instance,
        autoStart: instance.autoStart ? 1 : 0,
        identity: instance.identity ?? null,
      });
    },

    getBotInstances() {
      const rows = selectInstances.all() as Array<
        Omit<BotInstance, "autoStart" | "identity"> & { autoStart: number; identity: string | null }
      >;
      return rows.map((r) => ({
        ...r,
        autoStart: r.autoStart === 1,
        serverProtocol: r.serverProtocol ?? "",
        ts6ApiKey: r.ts6ApiKey ?? "",
        serverPassword: r.serverPassword ?? "",
        identity: r.identity ?? undefined,
      }));
    },

    deleteBotInstance(id) {
      const result = deleteInstance.run(id);
      return result.changes > 0;
    },

    getProfileConfig(botId) {
      const row = selectProfileConfig.get(botId) as Record<string, number> | undefined;
      if (!row) return { ...DEFAULT_PROFILE_CONFIG };
      return {
        avatarEnabled: row.profile_avatar_enabled === 1,
        descriptionEnabled: row.profile_description_enabled === 1,
        nicknameEnabled: row.profile_nickname_enabled === 1,
        awayStatusEnabled: row.profile_away_enabled === 1,
        channelDescEnabled: row.profile_channel_desc_enabled === 1,
        nowPlayingMsgEnabled: row.profile_now_playing_enabled === 1,
      };
    },

    saveProfileConfig(botId, config) {
      updateProfileConfig.run({
        id: botId,
        avatar: config.avatarEnabled ? 1 : 0,
        description: config.descriptionEnabled ? 1 : 0,
        nickname: config.nicknameEnabled ? 1 : 0,
        away: config.awayStatusEnabled ? 1 : 0,
        channelDesc: config.channelDescEnabled ? 1 : 0,
        nowPlaying: config.nowPlayingMsgEnabled ? 1 : 0,
      });
    },

    getCustomAvatarPath(botId) {
      const row = selectCustomAvatar.get(botId) as { custom_avatar_path: string | null } | undefined;
      return row?.custom_avatar_path ?? null;
    },
    setCustomAvatarPath(botId, path) {
      updateCustomAvatar.run(path, botId);
    },

    close() {
      db.close();
    },
  };
}
