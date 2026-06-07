/**
 * Integration test: Full stack test against local TeamSpeak server.
 * Tests TCP connection, bot lifecycle via Web API, unit components.
 */
import { TS3Connection } from "./src/ts-protocol/connection.js";
import { createLogger } from "./src/logger.js";
import { createDatabase } from "./src/data/database.js";
import { loadConfig } from "./src/data/config.js";
import { NeteaseProvider } from "./src/music/netease.js";
import { QQMusicProvider } from "./src/music/qq.js";
import { BotManager } from "./src/bot/manager.js";
import { createWebServer } from "./src/web/server.js";
import { PlayQueue, PlayMode } from "./src/audio/queue.js";
import { parseCommand, isAdminCommand } from "./src/bot/commands.js";
import {
  encodeCommand,
  decodeResponse,
  escapeValue,
  unescapeValue,
} from "./src/ts-protocol/commands.js";
import {
  generateIdentity,
  exportIdentity,
  importIdentity,
} from "./src/ts-protocol/identity.js";
import { createOpusEncoder, PCM_FRAME_BYTES } from "./src/audio/encoder.js";
import { parseLyrics } from "./src/music/netease.js";

const HOST = "127.0.0.1";
const QUERY_PORT = 10011;
const VOICE_PORT = 9987;
const WEB_PORT = 3334;

const logger = createLogger();

let passed = 0;
let failed = 0;

const log = (msg: string) => console.log(`[TEST] ${msg}`);
const pass = (msg: string) => {
  console.log(`  ✅ ${msg}`);
  passed++;
};
const fail = (msg: string) => {
  console.log(`  ❌ ${msg}`);
  failed++;
};

function assert(condition: boolean, msg: string) {
  condition ? pass(msg) : fail(msg);
}

// ═══════════════════════════════════════════════════
// Test 1: TS3 Protocol — TCP Connection
// ═══════════════════════════════════════════════════
async function testTcpConnection() {
  log("═══ Test 1: TCP ServerQuery Connection ═══");
  const conn = new TS3Connection({ host: HOST, port: QUERY_PORT });

  await conn.connect();
  assert(conn.isConnected(), "Connected to ServerQuery port 10011");

  const useResult = await conn.send("use", { sid: 1 });
  assert(useResult.errorId === 0, `SELECT virtual server: ok`);

  const nickResult = await conn.send("clientupdate", {
    client_nickname: "Moneypenny-Test1",
  });
  assert(nickResult.errorId === 0, `Set nickname to Moneypenny-Test1`);

  const whoami = await conn.send("whoami");
  assert(whoami.errorId === 0, `whoami: client_id=${whoami.data[0]?.client_id}`);

  const version = await conn.send("version");
  assert(version.errorId === 0, `Server version: ${version.data[0]?.version}`);

  conn.disconnect();
  assert(!conn.isConnected(), "Disconnected cleanly");
}

// ═══════════════════════════════════════════════════
// Test 2: TS3 Protocol — Command Encoding
// ═══════════════════════════════════════════════════
function testCommandEncoding() {
  log("\n═══ Test 2: TS3 Command Encoding/Decoding ═══");

  assert(
    escapeValue("hello world") === "hello\\sworld",
    "Escape spaces"
  );
  assert(
    escapeValue("foo|bar") === "foo\\pbar",
    "Escape pipes"
  );
  assert(
    unescapeValue("hello\\sworld") === "hello world",
    "Unescape spaces"
  );

  const encoded = encodeCommand("login", {
    client_login_name: "bot",
    client_login_password: "test pass",
  });
  assert(
    encoded.includes("client_login_password=test\\spass"),
    "Encoded command escapes spaces in values"
  );

  const decoded = decodeResponse(
    "clid=1 client_nickname=User1|clid=2 client_nickname=User2"
  );
  assert(decoded.length === 2, "Decoded 2 entries from piped response");
  assert(decoded[0].client_nickname === "User1", "First entry nickname");
  assert(decoded[1].clid === "2", "Second entry clid");
}

// ═══════════════════════════════════════════════════
// Test 3: TS3 Identity
// ═══════════════════════════════════════════════════
function testIdentity() {
  log("\n═══ Test 3: TS3 Identity Generation ═══");

  const id = generateIdentity();
  assert(id.publicKey.length === 32, "Public key is 32 bytes");
  assert(id.privateKey.length === 64, "Private key is 64 bytes");
  assert(id.uid.length > 0, `UID generated: ${id.uid.slice(0, 20)}...`);

  const exported = exportIdentity(id);
  const imported = importIdentity(exported);
  assert(imported.uid === id.uid, "Export/import roundtrip preserves UID");

  const id2 = generateIdentity();
  assert(id.uid !== id2.uid, "Two identities have different UIDs");
}

// ═══════════════════════════════════════════════════
// Test 4: Command Parser
// ═══════════════════════════════════════════════════
function testCommandParser() {
  log("\n═══ Test 4: Command Parser ═══");

  const cmd = parseCommand("!play Bohemian Rhapsody Queen", "!");
  assert(cmd !== null && cmd.name === "play", "Parse !play");
  assert(cmd!.args === "Bohemian Rhapsody Queen", "Args preserved with spaces");

  const cmd2 = parseCommand("!play -y Hotel California", "!");
  assert(cmd2!.flags.has("y"), "Flag -y parsed");
  assert(cmd2!.args === "Hotel California", "Args after flag");

  const cmd3 = parseCommand("!p Stairway to Heaven", "!", { p: "play", s: "skip" });
  assert(cmd3!.name === "play", "Alias p→play resolved");

  assert(parseCommand("hello", "!") === null, "Non-command → null");
  assert(parseCommand("", "!") === null, "Empty → null");
  assert(parseCommand("!vol 80", "!")!.args === "80", "!vol 80");
  assert(parseCommand("!mode loop", "!")!.args === "loop", "!mode loop");

  assert(isAdminCommand("vol"), "vol is admin command");
  assert(!isAdminCommand("play"), "play is public command");
}

// ═══════════════════════════════════════════════════
// Test 5: Play Queue
// ═══════════════════════════════════════════════════
function testPlayQueue() {
  log("\n═══ Test 5: Play Queue ═══");

  const q = new PlayQueue();
  assert(q.isEmpty(), "Starts empty");

  const songs = ["Song A", "Song B", "Song C"].map((name, i) => ({
    id: String(i),
    name,
    artist: "Artist",
    album: "Album",
    platform: "netease" as const,
    url: `http://example.com/${i}.mp3`,
    coverUrl: "",
    duration: 180,
  }));

  for (const s of songs) q.add(s);
  assert(q.size() === 3, "Queue has 3 songs");

  q.play();
  assert(q.current()?.name === "Song A", "Play → Song A");

  q.next();
  assert(q.current()?.name === "Song B", "Next → Song B");

  q.prev();
  assert(q.current()?.name === "Song A", "Prev → Song A");

  q.setMode(PlayMode.Loop);
  q.playAt(2);
  assert(q.current()?.name === "Song C", "PlayAt(2) → Song C");
  q.next();
  assert(q.current()?.name === "Song A", "Loop wraps to Song A");

  q.setMode(PlayMode.Sequential);
  q.playAt(2);
  assert(q.next() === null, "Sequential: end → null");

  q.remove(0);
  assert(q.size() === 2, "Remove reduces size");

  q.clear();
  assert(q.isEmpty(), "Clear empties queue");
}

// ═══════════════════════════════════════════════════
// Test 6: Opus Encoder
// ═══════════════════════════════════════════════════
function testOpusEncoder() {
  log("\n═══ Test 6: Opus Encoder ═══");

  const enc = createOpusEncoder();
  const silence = Buffer.alloc(PCM_FRAME_BYTES, 0);

  const opus = enc.encode(silence);
  assert(opus.length > 0, `Encoded 20ms silence → ${opus.length} bytes`);
  assert(opus.length < PCM_FRAME_BYTES, "Opus smaller than raw PCM");

  const decoded = enc.decode(opus);
  assert(decoded.length === PCM_FRAME_BYTES, `Decoded back to ${decoded.length} bytes`);
}

// ═══════════════════════════════════════════════════
// Test 7: Database
// ═══════════════════════════════════════════════════
function testDatabase() {
  log("\n═══ Test 7: Database ═══");

  const db = createDatabase(":memory:");

  db.addPlayHistory({
    botId: "test",
    songId: "123",
    songName: "Bohemian Rhapsody",
    artist: "Queen",
    album: "A Night at the Opera",
    platform: "local",
    coverUrl: "",
  });
  const history = db.getPlayHistory("test", 10);
  assert(history.length === 1 && history[0].songName === "Bohemian Rhapsody", "Play history saved/loaded");
  assert(history[0].playedAt !== undefined, `playedAt auto-generated: ${history[0].playedAt}`);

  db.saveBotInstance({
    id: "b1",
    name: "Bot",
    serverAddress: "127.0.0.1",
    serverPort: 9987,
    nickname: "Bot",
    defaultChannel: "",
    channelPassword: "",
    autoStart: false,
  });
  assert(db.getBotInstances().length === 1, "Bot instance saved");
  assert(db.deleteBotInstance("b1"), "Bot instance deleted");
  assert(db.getBotInstances().length === 0, "No instances after delete");

  db.close();
}

// ═══════════════════════════════════════════════════
// Test 8: Lyrics Parser
// ═══════════════════════════════════════════════════
function testLyricsParser() {
  log("\n═══ Test 8: Lyrics Parser ═══");

  const lrc = `[00:00.00] Title: Test Song
[00:12.50]Yellow flowers in the story
[00:15.80]Floating since the year of birth`;

  const lines = parseLyrics(lrc);
  assert(lines.length === 2, "Skipped metadata, got 2 lyric lines");
  assert(Math.abs(lines[0].time - 12.5) < 0.1, `Line 1 time: ${lines[0].time}`);
  assert(lines[0].text === "Yellow flowers in the story", "Line 1 text");

  const tlyric = "[00:12.50]Yellow flowers in the story (translation)";
  const merged = parseLyrics("[00:12.50]Hello", tlyric);
  assert(merged[0].translation !== undefined, "Translation merged");

  assert(parseLyrics("").length === 0, "Empty lyrics → empty array");
}

// ═══════════════════════════════════════════════════
// Test 9: Full Stack — Web API + Bot + TS Connection
// ═══════════════════════════════════════════════════
async function testFullStack() {
  log("\n═══ Test 9: Full Stack (Web API → Bot → TeamSpeak) ═══");

  const db = createDatabase(":memory:");
  const config = loadConfig("nonexistent");
  const neteaseProvider = new NeteaseProvider("http://127.0.0.1:3001");
  const qqProvider = new QQMusicProvider("http://127.0.0.1:3002");
  const botManager = new BotManager(neteaseProvider, qqProvider, db, config, logger);

  const web = createWebServer({
    port: WEB_PORT,
    botManager,
    neteaseProvider,
    qqProvider,
    database: db,
    config,
    logger,
  });
  await web.start();
  log(`  Web server on port ${WEB_PORT}`);

  // Health check
  const health = await fetch(`http://127.0.0.1:${WEB_PORT}/api/health`).then((r) => r.json());
  assert(health.status === "ok", `Health: ${JSON.stringify(health)}`);

  // Bot list (empty)
  const list0 = await fetch(`http://127.0.0.1:${WEB_PORT}/api/bot`).then((r) => r.json());
  assert(list0.bots.length === 0, "No bots initially");

  // Create bot
  const createRes = await fetch(`http://127.0.0.1:${WEB_PORT}/api/bot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Test Bot",
      serverAddress: HOST,
      serverPort: VOICE_PORT,
      nickname: "Moneypenny-FullTest",
      autoStart: false,
    }),
  });
  const botData = await createRes.json();
  assert(createRes.status === 201, `Created bot: ${botData.id}`);
  const botId = botData.id;

  // Start bot (connect to TS)
  log("  Connecting bot to TeamSpeak...");
  const startRes = await fetch(`http://127.0.0.1:${WEB_PORT}/api/bot/${botId}/start`, {
    method: "POST",
  });
  const startData = await startRes.json();
  assert(startData.success === true, "Bot connected to TeamSpeak!");

  // Verify connected
  const status = await fetch(`http://127.0.0.1:${WEB_PORT}/api/bot/${botId}`).then((r) =>
    r.json()
  );
  assert(status.connected === true, `Bot status: connected=${status.connected}`);
  assert(status.name === "Test Bot", `Bot name: ${status.name}`);
  assert(status.volume === 75, `Default volume: ${status.volume}`);
  assert(status.playing === false, "Not playing (no song loaded)");

  // Queue endpoint
  const queueRes = await fetch(
    `http://127.0.0.1:${WEB_PORT}/api/player/${botId}/queue`
  ).then((r) => r.json());
  assert(Array.isArray(queueRes.queue), `Queue: ${queueRes.queue.length} items`);
  assert(queueRes.status.id === botId, "Queue status has correct botId");

  // Volume control
  const volRes = await fetch(`http://127.0.0.1:${WEB_PORT}/api/player/${botId}/volume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ volume: 50 }),
  }).then((r) => r.json());
  assert(volRes.message === "Volume set to 50%", `Volume: ${volRes.message}`);

  // Mode control
  const modeRes = await fetch(`http://127.0.0.1:${WEB_PORT}/api/player/${botId}/mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "loop" }),
  }).then((r) => r.json());
  assert(modeRes.message === "Play mode set to: loop", `Mode: ${modeRes.message}`);

  // Pause (no track, should still respond)
  const pauseRes = await fetch(`http://127.0.0.1:${WEB_PORT}/api/player/${botId}/pause`, {
    method: "POST",
  }).then((r) => r.json());
  assert(pauseRes.message === "Paused", `Pause: ${pauseRes.message}`);

  // Now (nothing playing)
  // This would go through bot.executeCommand which requires the bot instance
  // Test it via the queue status
  const status2 = await fetch(`http://127.0.0.1:${WEB_PORT}/api/bot/${botId}`).then((r) =>
    r.json()
  );
  assert(status2.volume === 50, "Volume persisted to 50");
  assert(status2.playMode === "loop", "Mode persisted to loop");

  // Stop bot
  const stopRes = await fetch(`http://127.0.0.1:${WEB_PORT}/api/bot/${botId}/stop`, {
    method: "POST",
  }).then((r) => r.json());
  assert(stopRes.success === true, "Bot stopped");

  // Delete bot
  const delRes = await fetch(`http://127.0.0.1:${WEB_PORT}/api/bot/${botId}`, {
    method: "DELETE",
  }).then((r) => r.json());
  assert(delRes.success === true, "Bot deleted");

  // Verify empty
  const list1 = await fetch(`http://127.0.0.1:${WEB_PORT}/api/bot`).then((r) => r.json());
  assert(list1.bots.length === 0, "No bots after cleanup");

  web.stop();
  botManager.shutdown();
  db.close();
}

// ═══════════════════════════════════════════════════
// Test 10: WebSocket Connection
// ═══════════════════════════════════════════════════
async function testWebSocket() {
  log("\n═══ Test 10: WebSocket Real-time ═══");

  const db = createDatabase(":memory:");
  const config = loadConfig("nonexistent");
  const neteaseProvider = new NeteaseProvider("http://127.0.0.1:3001");
  const qqProvider = new QQMusicProvider("http://127.0.0.1:3002");
  const botManager = new BotManager(neteaseProvider, qqProvider, db, config, logger);

  const web = createWebServer({
    port: WEB_PORT + 1,
    botManager,
    neteaseProvider,
    qqProvider,
    database: db,
    config,
    logger,
  });
  await web.start();

  // Connect WebSocket
  const { WebSocket: WS } = await import("ws");
  const ws = new WS(`ws://127.0.0.1:${WEB_PORT + 1}/ws`);

  const messages: any[] = [];

  // Register message handler BEFORE connection opens
  ws.on("message", (data) => {
    messages.push(JSON.parse(data.toString()));
  });

  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WS timeout")), 3000);
  });
  assert(ws.readyState === WS.OPEN, "WebSocket connected");

  // Wait a moment for init message
  await new Promise((r) => setTimeout(r, 500));

  assert(messages.length > 0, `Received ${messages.length} message(s)`);
  assert(messages[0].type === "init", `Message type: ${messages[0].type}`);
  assert(Array.isArray(messages[0].bots), "Init contains bots array");

  ws.close();
  web.stop();
  botManager.shutdown();
  db.close();
}

// ═══════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════
async function main() {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║   Moneypenny Integration Test Suite           ║");
  console.log("║   TS Server: localhost:9987 / query:10011     ║");
  console.log("╚═══════════════════════════════════════════════╝\n");

  try {
    await testTcpConnection();
    testCommandEncoding();
    testIdentity();
    testCommandParser();
    testPlayQueue();
    testOpusEncoder();
    testDatabase();
    testLyricsParser();
    await testFullStack();
    await testWebSocket();
  } catch (err) {
    fail(`Unexpected error: ${(err as Error).message}`);
    console.error(err);
  }

  console.log("\n╔═══════════════════════════════════════════════╗");
  console.log(`║   Results: ${passed} passed, ${failed} failed               ║`);
  console.log("╚═══════════════════════════════════════════════╝");

  // Give a moment for cleanup
  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500);
}

main();
