import path from "node:path";
import { Writable } from "node:stream";
import type { BotConfig } from "../data/config.js";
import type { DoctrineStore } from "../data/doctrine.js";
import type { FileDropStore } from "../data/file-drop.js";
import type { Logger } from "../logger.js";
import type { MusicProvider } from "../music/provider.js";
import { ingestDoctrineDoc, MAX_DOCTRINE_FILE_BYTES } from "../rag/doctrine-ingest.js";
import type { RetrievalStore } from "../rag/index.js";
import type { ChannelFile, TS3Client } from "../ts-protocol/client.js";
import { errorMessage } from "../util/error.js";
import {
  channelFilesDir,
  diskPathForChannelFile,
  listDiskChannelFiles,
  readDiskChannelFile,
} from "./file-drop-disk.js";

/**
 * TeamSpeak file-browser → ingestion (ROADMAP Phase 6, TS-native path).
 *
 * Members drop files into a dedicated channel's file repository; the bot polls
 * it (recursively) and routes new files by extension — `.md`/`.markdown` into
 * the doctrine RAG pipeline, audio into the music library — reusing the exact
 * same sinks as the web-upload and git-wiki paths (`ingestDoctrineDoc`,
 * `LocalProvider.uploadSong`).
 *
 * TS3 has no "file uploaded" push event, so this is poll + diff against a SQLite
 * seen-set (survives restarts; keyed on full path + size + mtime). Security
 * boundary: whoever has TS upload permission on the drop channel. Classification
 * is taken from the doc's frontmatter (consistent with the other ingestion
 * paths) — restrict who can upload to the channel accordingly.
 */

/** Hardcoded drop-channel name. Create a TS channel with EXACTLY this name. */
export const FILE_DROP_CHANNEL_NAME = "moneypenny-drop";

/** Audio extensions routed to the music library (mirrors LocalProvider defaults). */
const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".flac",
  ".wav",
  ".ogg",
  ".m4a",
  ".aac",
  ".wma",
  ".opus",
]);

const MD_CAP = MAX_DOCTRINE_FILE_BYTES;
const AUDIO_CAP = 50 * 1024 * 1024; // 50 MiB per dropped track
const DOWNLOAD_TIMEOUT_MS = 60_000; // TS file transfer can silently hang (cf. avatar upload)
const MAX_SUBDIR_DEPTH = 8; // guard against pathological / looping file trees
const MAX_DOWNLOAD_ATTEMPTS = 3; // transient download failures retry up to this, then give up

export type IngestOutcome = "ingested" | "skipped" | "retry";

export interface FileDropDeps {
  tsClient: Pick<
    TS3Client,
    | "resolveChannelIdByName"
    | "listChannelFiles"
    | "fileTransferInitDownload"
    | "downloadFileData"
    | "getHost"
    | "sendChannelMessage"
  >;
  localProvider: MusicProvider;
  retrieval?: RetrievalStore;
  doctrine?: DoctrineStore;
  store: FileDropStore;
  config: BotConfig;
  logger?: Logger;
  /** Liveness gate — only poll while the bot is connected to TS. */
  isConnected: () => boolean;
  /**
   * When set (co-located deploy), list + read dropped files from the TS server's
   * on-disk file repo instead of `ftgetfilelist` + file transfer. Container path
   * to the mounted `files/` tree (e.g. `/ts6-files`).
   */
  tsFilesDir?: string;
  /** Virtual server id for the on-disk path segment (default 1). */
  tsVirtualServerId?: number;
}

/** Reject if `p` doesn't settle within `ms` (TS file transfers can hang silently). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Join a TS file-repo dir path and an entry name (root is "/"). */
export function joinFilePath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir.replace(/\/+$/, "")}/${name}`;
}

/** Download a channel file into a size-capped in-memory buffer, with a timeout. */
async function downloadToBuffer(
  deps: FileDropDeps,
  channelId: bigint,
  filePath: string,
  cap: number,
): Promise<Buffer> {
  return withTimeout(
    (async () => {
      const info = await deps.tsClient.fileTransferInitDownload(channelId, filePath);
      if (info.size > BigInt(cap))
        throw new Error(`file too large (${info.size} bytes, cap ${cap})`);
      const chunks: Buffer[] = [];
      let total = 0;
      const sink = new Writable({
        write(chunk: Buffer, _enc, cb) {
          total += chunk.length;
          if (total > cap) return cb(new Error("exceeded size cap mid-stream"));
          chunks.push(Buffer.from(chunk));
          cb();
        },
      });
      await deps.tsClient.downloadFileData(deps.tsClient.getHost(), info, sink);
      return Buffer.concat(chunks);
    })(),
    DOWNLOAD_TIMEOUT_MS,
    `download ${filePath}`,
  );
}

/** Best-effort confirmation into the drop channel (+ always logged). */
async function confirm(deps: FileDropDeps, channelId: bigint, message: string): Promise<void> {
  try {
    await deps.tsClient.sendChannelMessage(channelId, message);
  } catch (err) {
    deps.logger?.debug({ err }, "Drop-channel confirmation message failed");
  }
  deps.logger?.info({ message }, "File-drop ingest");
}

/**
 * Ingest a single not-yet-seen channel file: download (from `filePath`), route by
 * extension, and record the outcome in the seen-set. Returns the outcome —
 * `"retry"` means a transient download failure that was deliberately NOT
 * recorded, so the caller can re-attempt on a later poll. Exported for tests.
 */
export async function ingestChannelFile(
  deps: FileDropDeps,
  channelId: bigint,
  filePath: string,
  file: ChannelFile,
  key: string,
): Promise<IngestOutcome> {
  const name = file.name;
  const ext = path.extname(name).toLowerCase();
  const isMd = ext === ".md" || ext === ".markdown";
  const isAudio = AUDIO_EXTENSIONS.has(ext);

  if (!isMd && !isAudio) {
    deps.store.record({ key, name, kind: "skipped", result: "unsupported type" });
    return "skipped";
  }
  if (isMd && !(deps.retrieval && deps.doctrine && deps.config.ragEnabled)) {
    deps.store.record({ key, name, kind: "skipped", result: "RAG disabled" });
    await confirm(deps, channelId, `📎 "${name}" skipped — the knowledge base is disabled.`);
    return "skipped";
  }

  // Read is the transient-failure surface (network / hung transfer / race with
  // TS still flushing the upload): on error, don't record — retry on later poll.
  let buf: Buffer;
  try {
    if (deps.tsFilesDir) {
      const channelDir = channelFilesDir(deps.tsFilesDir, deps.tsVirtualServerId ?? 1, channelId);
      const abs = diskPathForChannelFile(channelDir, filePath);
      buf = await readDiskChannelFile(abs, isMd ? MD_CAP : AUDIO_CAP);
    } else {
      buf = await downloadToBuffer(deps, channelId, filePath, isMd ? MD_CAP : AUDIO_CAP);
    }
  } catch (err: unknown) {
    deps.logger?.warn({ err: errorMessage(err), name }, "File-drop read failed — will retry");
    return "retry";
  }

  // Past download, failures are deterministic (parse / embed / write) — record so
  // we don't loop. For .md the file is still written to the doctrine dir by
  // ingestDoctrineDoc before embedding, so `!reindex` can recover an embed outage.
  try {
    if (isMd) {
      const doc = await ingestDoctrineDoc(
        deps.retrieval!,
        deps.doctrine!,
        name,
        buf.toString("utf-8"),
      );
      deps.store.record({ key, name, kind: "doctrine", result: `${doc.chunks} chunks` });
      await confirm(
        deps,
        channelId,
        `📎 Ingested doctrine "${doc.source}" (classification: ${doc.classification}, ${doc.chunks} chunks).`,
      );
    } else {
      const upload = deps.localProvider.uploadSong;
      if (!upload) throw new Error("music upload not supported");
      const song = await upload.call(deps.localProvider, name, buf);
      const label = song.artist ? `${song.name} — ${song.artist}` : song.name;
      deps.store.record({ key, name, kind: "music", result: "added" });
      await confirm(deps, channelId, `🎵 Added "${label}" to the library.`);
    }
    return "ingested";
  } catch (err: unknown) {
    const msg = errorMessage(err);
    deps.store.record({ key, name, kind: "skipped", result: `error: ${msg}` });
    deps.logger?.warn({ err, name }, "File-drop ingest failed");
    await confirm(deps, channelId, `⚠️ Couldn't ingest "${name}": ${msg}`);
    return "skipped";
  }
}

/** Ingest new files from one scan pass (shared retry bookkeeping). */
async function ingestEntries(
  deps: FileDropDeps,
  channelId: bigint,
  entries: Array<{ filePath: string; file: ChannelFile }>,
  attempts: Map<string, number>,
): Promise<void> {
  for (const { filePath, file: e } of entries) {
    if (e.type !== 1) continue;
    const key = `${channelId}:${filePath}:${e.size}:${e.datetime}`;
    if (deps.store.seen(key)) continue;

    const outcome = await ingestChannelFile(deps, channelId, filePath, e, key);
    if (outcome === "retry") {
      const n = (attempts.get(key) ?? 0) + 1;
      if (n >= MAX_DOWNLOAD_ATTEMPTS) {
        attempts.delete(key);
        deps.store.record({
          key,
          name: e.name,
          kind: "skipped",
          result: `read failed after ${n} attempts`,
        });
        await confirm(deps, channelId, `⚠️ Gave up on "${e.name}" after ${n} read attempts.`);
      } else {
        attempts.set(key, n);
      }
    } else {
      attempts.delete(key);
    }
  }
}

/** Recurse a directory of the drop channel via TS protocol listing. */
async function scanDirProtocol(
  deps: FileDropDeps,
  channelId: bigint,
  dirPath: string,
  depth: number,
  attempts: Map<string, number>,
): Promise<void> {
  const entries = await deps.tsClient.listChannelFiles(channelId, dirPath);
  const files: Array<{ filePath: string; file: ChannelFile }> = [];
  for (const e of entries) {
    const full = joinFilePath(dirPath, e.name);
    if (e.type === 0) {
      if (depth < MAX_SUBDIR_DEPTH)
        await scanDirProtocol(deps, channelId, full, depth + 1, attempts);
      continue;
    }
    files.push({ filePath: full, file: e });
  }
  await ingestEntries(deps, channelId, files, attempts);
}

/**
 * List the drop channel (recursively) and ingest every file not already in the
 * seen-set. `attempts` carries transient-download retry counts across polls.
 */
export async function scanDropChannel(
  deps: FileDropDeps,
  channelId: bigint,
  attempts: Map<string, number> = new Map(),
): Promise<void> {
  if (deps.tsFilesDir) {
    const channelDir = channelFilesDir(deps.tsFilesDir, deps.tsVirtualServerId ?? 1, channelId);
    const entries = await listDiskChannelFiles(channelDir, "/", 0, MAX_SUBDIR_DEPTH);
    await ingestEntries(deps, channelId, entries, attempts);
    return;
  }
  await scanDirProtocol(deps, channelId, "/", 0, attempts);
}

/**
 * Start the drop-channel watcher. Self-rescheduling poll (like the idle poller),
 * not a fixed interval, so a slow tick never overlaps itself. Returns a stop fn.
 */
export function startFileDropWatcher(deps: FileDropDeps): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let channelId: bigint | null = null;
  let warnedMissing = false;
  const attempts = new Map<string, number>();

  const tick = async () => {
    try {
      if (deps.config.fileDropEnabled && deps.isConnected()) {
        if (channelId == null) {
          channelId = await deps.tsClient.resolveChannelIdByName(FILE_DROP_CHANNEL_NAME);
          if (channelId == null) {
            if (!warnedMissing) {
              deps.logger?.info(
                { channel: FILE_DROP_CHANNEL_NAME },
                "File-drop enabled but channel not found yet — create it in TeamSpeak",
              );
              warnedMissing = true;
            }
          } else {
            deps.logger?.info(
              {
                channel: FILE_DROP_CHANNEL_NAME,
                channelId: String(channelId),
                disk: !!deps.tsFilesDir,
              },
              deps.tsFilesDir ? "Watching drop channel (disk mount)" : "Watching drop channel",
            );
          }
        }
        if (channelId != null) await scanDropChannel(deps, channelId, attempts);
      }
    } catch (err) {
      deps.logger?.warn({ err }, "File-drop poll failed");
    } finally {
      if (!stopped) {
        const sec = Math.max(5, deps.config.fileDropPollSec || 30);
        timer = setTimeout(tick, sec * 1000);
      }
    }
  };

  // Kick off the first tick on the next loop turn (so construction stays sync).
  timer = setTimeout(tick, 0);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
