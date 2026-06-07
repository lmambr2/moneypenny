import path from "node:path";
import { existsSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "./data/config.js";
import { createDatabase } from "./data/database.js";
import { createLogger } from "./logger.js";
import { YouTubeProvider } from "./music/youtube.js";
import { LocalProvider } from "./music/local.js";
import { StreamProvider } from "./music/stream.js";
import { Watchdog } from "./watchdog.js";
import { createAvatarStore } from "./data/avatars.js";
import { BotManager } from "./bot/manager.js";
import { createWebServer } from "./web/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
// config.json lives under data/ so ALL mutable state sits on one writable
// volume — lets the container run with a read-only root filesystem (DESIGN §11).
// Falls back to a legacy ROOT_DIR/config.json if one already exists there.
const LEGACY_CONFIG_PATH = path.join(ROOT_DIR, "config.json");
const CONFIG_PATH = existsSync(LEGACY_CONFIG_PATH)
  ? LEGACY_CONFIG_PATH
  : path.join(DATA_DIR, "config.json");
const DB_PATH = path.join(DATA_DIR, "moneypenny.db");
const LOG_DIR = path.join(DATA_DIR, "logs");
const AVATAR_DIR = path.join(DATA_DIR, "avatars");
const STATIC_DIR = path.join(ROOT_DIR, "web", "dist");

// Legacy DB filename from before the TSMusicBot -> Moneypenny rename.
// We migrate on startup (rename the .db + WAL companions) so existing
// bot_instances, play_history, and the users table (first-run state) are
// preserved. This is the DB analogue of the LEGACY_CONFIG_PATH handling below.
const LEGACY_DB_PATH = path.join(DATA_DIR, "tsmusicbot.db");
if (!existsSync(DB_PATH) && existsSync(LEGACY_DB_PATH)) {
  try {
    renameSync(LEGACY_DB_PATH, DB_PATH);
    for (const ext of ["-shm", "-wal"]) {
      const old = LEGACY_DB_PATH + ext;
      const nu = DB_PATH + ext;
      if (existsSync(old)) {
        try {
          renameSync(old, nu);
        } catch {
          // best-effort; SQLite can often recover
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log("Migrated legacy tsmusicbot.db -> moneypenny.db (bots, history, and first-run user state preserved)");
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("Failed to auto-migrate legacy DB file; a fresh moneypenny.db will be used:", e);
  }
}

async function main() {
  const config = loadConfig(CONFIG_PATH);
  saveConfig(CONFIG_PATH, config);

  const logger = createLogger(LOG_DIR);

  // Prevent unhandled errors from crashing the process
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled promise rejection");
  });
  const db = createDatabase(DB_PATH);
  logger.info({ dbPath: DB_PATH }, "using SQLite database");

  const avatarStore = createAvatarStore(AVATAR_DIR);

  const musicDir = process.env.MUSIC_DIR || "/music";
  const localProvider = new LocalProvider({ musicDir });
  const youtubeProvider = new YouTubeProvider();
  const streamProvider = new StreamProvider({
    bridgeUrl: config.streamBridgeUrl || process.env.STREAM_BRIDGE_URL || "",
    logger,
  });

  const botManager = new BotManager(
    localProvider,
    youtubeProvider,
    streamProvider,
    db,
    config,
    logger,
    avatarStore
  );
  await botManager.loadSavedBots();

  // Phase 0 convenience: Auto-create first bot from environment if none exist
  // This makes quick validation against a real TS6 server much easier.
  const savedInstances = db.getBotInstances ? db.getBotInstances() : [];
  const phase0Mode = !!process.env.TS6_HOST || !!process.env.TS_HOST;

  if (savedInstances.length === 0 && phase0Mode) {
    const tsHost = process.env.TS6_HOST || process.env.TS_HOST;
    try {
      const bot = await botManager.createBot({
        name: process.env.BOT_NAME || "Moneypenny",
        serverAddress: tsHost || "localhost",
        serverPort: parseInt(process.env.TS6_PORT || process.env.TS_PORT || "9987", 10),
        nickname: process.env.BOT_NICKNAME || process.env.BOT_NAME || "Moneypenny",
        defaultChannel: process.env.DEFAULT_CHANNEL,
        serverProtocol: "ts6",
        ts6ApiKey: process.env.TS6_API_KEY,
        serverPassword: process.env.TS_SERVER_PASSWORD,
        autoStart: true,
      });
      logger.info({ botId: bot.id }, "Phase 0: Auto-created first bot from TS6_* environment variables");
      logger.info(`Phase 0: Will attempt connection to ${tsHost}:${process.env.TS6_PORT || process.env.TS_PORT || "9987"}`);
    } catch (err) {
      logger.error({ err }, "Phase 0: Failed to auto-create bot from environment. Check TS6_HOST, TS6_API_KEY, ports, and reachability from this container/host.");
    }
  }

  if (phase0Mode) {
    logger.info("Phase 0 validation mode detected (TS6_* variables present)");
  }

  const webServer = createWebServer({
    port: config.webPort,
    host: process.env.BIND_ADDRESS || config.bindAddress || "127.0.0.1",
    botManager,
    localProvider,
    youtubeProvider,
    database: db,
    avatarStore,
    config,
    configPath: CONFIG_PATH,
    logger,
    staticDir: STATIC_DIR,
  });
  await webServer.start();

  // Watchdog (DESIGN §13): reconnect dropped autoStart bots + guard memory.
  // WATCHDOG_MEMORY_MB=0/unset disables the memory check; reconnect monitoring
  // is always on (cheap, only touches autoStart bots).
  const watchdog = new Watchdog({
    getTargets: () => botManager.getWatchdogTargets(),
    logger,
    memoryLimitMb: parseInt(process.env.WATCHDOG_MEMORY_MB || "0", 10) || 0,
    onMemoryExceeded: () => {
      logger.error("Exiting on memory ceiling — Docker restart policy should bring us back");
      process.exit(1);
    },
  });
  watchdog.start();

  logger.info({ webPort: config.webPort }, "Moneypenny started");
  const publicUrl = (config.publicUrl ?? "").trim().replace(/\/+$/, "");
  logger.info(
    `WebUI: ${publicUrl || `http://localhost:${config.webPort}`}`
  );

  const shutdown = () => {
    logger.info("Shutting down...");
    watchdog.stop();
    botManager.shutdown();
    webServer.stop();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
