import path from "node:path";
import { existsSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "./data/config.js";
import { createDatabase } from "./data/database.js";
import { createLogger } from "./logger.js";
import { YouTubeProvider } from "./music/youtube.js";
import { LocalProvider } from "./music/local.js";
import { TagStore } from "./radio/index.js";
import { StreamProvider } from "./music/stream.js";
import { Watchdog } from "./watchdog.js";
import { createAvatarStore } from "./data/avatars.js";
import { BotManager } from "./bot/manager.js";
import { createWebServer } from "./web/server.js";
import { RetrievalStore, EmbeddingsClient, QdrantClient } from "./rag/index.js";
import { warmLlmModels } from "./llm/warmup.js";
import { DoctrineStore } from "./data/doctrine.js";
import { FileDropStore } from "./data/file-drop.js";
import { reindexDoctrine, watchDoctrineDir } from "./rag/doctrine-ingest.js";

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
  const tagStore = new TagStore({ db: db.db });
  const localProvider = new LocalProvider({
    musicDir,
    excludedIds: () => tagStore.bumperKeySet(), // hide bumper-flagged assets from music search (§9.2)
  });
  const youtubeProvider = new YouTubeProvider();
  const streamProvider = new StreamProvider({
    bridgeUrl: config.streamBridgeUrl || process.env.STREAM_BRIDGE_URL || "",
    logger,
  });

  // Retrieval / RAG substrate (ROADMAP Phase 5). Off unless ragEnabled. Endpoint
  // + model are config-driven so the same code serves the RK3588 (EmbeddingGemma
  // on ollama) and x86+GPU (Qwen3-Embedding) tracks; each is pointable remote.
  let retrieval: RetrievalStore | undefined;
  let doctrine: DoctrineStore | undefined;
  let stopDoctrineWatch: (() => void) | undefined;
  if (config.ragEnabled) {
    const embedTimeout = parseInt(process.env.EMBEDDING_TIMEOUT_MS || "600000", 10) || 600_000;
    const embeddings = new EmbeddingsClient({
      baseUrl: config.embeddingUrl || config.llmUrl || undefined,
      model: config.embeddingModel || undefined,
      timeoutMs: embedTimeout,
      logger,
    });
    const qdrant = new QdrantClient({ baseUrl: config.vectorDbUrl || undefined, logger });
    retrieval = new RetrievalStore({
      embeddings,
      qdrant,
      collection: config.ragCollection,
      topK: config.ragTopK,
      logger,
    });
    // Best-effort eager init (probe dim + ensure collection); never blocks startup.
    retrieval.init().catch((err) => logger.error({ err }, "RAG init failed — will retry lazily"));
    // Doctrine corpus (Phase 6): registry + on-disk .md under DATA_DIR/doctrine.
    doctrine = new DoctrineStore(db.db, DATA_DIR, logger);
    // Wiki-as-code: sync any doctrine on disk into the vector store at startup
    // (catches files added while down), then watch for live changes (git push /
    // scp / manual). Both best-effort; never block startup.
    const dd = doctrine;
    retrieval
      .init()
      .then(() => reindexDoctrine(retrieval!, dd))
      .then((docs) => { if (docs.length) logger.info({ docs: docs.length }, "Doctrine synced at startup"); })
      .catch((err) => logger.warn({ err }, "Doctrine startup sync skipped"));
    stopDoctrineWatch = watchDoctrineDir(retrieval, doctrine, logger);
    logger.info(
      { vectorDbUrl: config.vectorDbUrl, embeddingModel: config.embeddingModel },
      "RAG enabled",
    );
  }

  // Seen-set for TeamSpeak file-browser ingestion (Phase 6 TS-native path).
  // Created unconditionally — audio drops feed the music library even when RAG
  // is off; the watcher itself is gated by config.fileDropEnabled.
  const fileDropStore = new FileDropStore(db.db);
  const tsFilesDir = process.env.TS6_FILES_DIR?.trim() || undefined;
  const tsVirtualServerId = parseInt(process.env.TS6_VIRTUAL_SERVER_ID || "1", 10) || 1;

  const botManager = new BotManager(
    localProvider,
    youtubeProvider,
    streamProvider,
    db,
    config,
    logger,
    avatarStore,
    retrieval,
    doctrine,
    fileDropStore,
    tsFilesDir,
    tsVirtualServerId
  );
  await botManager.loadSavedBots();

  // Pre-warm chat + embedding models (best-effort; first !ask/voice turn is faster).
  void warmLlmModels(config, logger);

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
        serverPassword: process.env.TS6_SERVER_PASSWORD || process.env.TS_SERVER_PASSWORD,
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
    streamProvider,
    database: db,
    avatarStore,
    config,
    configPath: CONFIG_PATH,
    logger,
    staticDir: STATIC_DIR,
    retrieval,
    doctrine,
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
    stopDoctrineWatch?.();
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
