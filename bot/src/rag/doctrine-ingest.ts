import { watch } from "node:fs";
import type { RetrievalStore } from "./index.js";
import type { DoctrineStore } from "../data/doctrine.js";
import { parseFrontmatter, metadataMatchesRegistry } from "./frontmatter.js";
import type { Logger } from "../logger.js";

/** Max size for a single doctrine `.md` file (web upload + TS file-browser drop). */
export const MAX_DOCTRINE_FILE_BYTES = 15 * 1024 * 1024;

export interface IngestedDoc {
  source: string;
  classification: string;
  chunks: number;
}

export interface ReindexSourcesOptions {
  /** Re-embed even when file bytes match the registry (recovery / explicit !reindex). */
  force?: boolean;
}

/**
 * Ingest one doctrine markdown doc end-to-end (ROADMAP Phase 6): parse
 * frontmatter → save the file → embed the body into the vector store with
 * classification/tags metadata → record the registry row. Shared by the admin
 * API and the `!reindex` command so both paths behave identically.
 */
export async function ingestDoctrineDoc(
  retrieval: RetrievalStore,
  doctrine: DoctrineStore,
  source: string,
  content: string,
): Promise<IngestedDoc> {
  const fm = parseFrontmatter(content);
  const saved = doctrine.saveFile(source, content);
  if (!saved) throw new Error(`invalid doctrine filename: ${source}`);
  const chunks = await retrieval.ingest(saved, fm.body, { classification: fm.classification, tags: fm.tags });
  doctrine.upsert({
    source: saved,
    classification: fm.classification,
    tags: fm.tags,
    chunks,
    bytes: Buffer.byteLength(content),
    updatedAt: Date.now(),
  });
  return { source: saved, classification: fm.classification, chunks };
}

/** Drop vector chunks + registry rows for docs removed from disk (git rm, rsync --delete). */
export async function purgeOrphanedDoctrine(retrieval: RetrievalStore, doctrine: DoctrineStore): Promise<void> {
  const onDisk = new Set(doctrine.files());
  for (const doc of doctrine.list()) {
    if (!onDisk.has(doc.source)) {
      await retrieval.purge(doc.source);
      doctrine.remove(doc.source);
    }
  }
}

function shouldReingest(
  doctrine: DoctrineStore,
  source: string,
  content: string,
  force: boolean,
): boolean {
  if (force) return true;
  const existing = doctrine.get(source);
  if (!existing) return true;
  if (existing.bytes !== Buffer.byteLength(content)) return true;
  const fm = parseFrontmatter(content);
  return !metadataMatchesRegistry(fm, existing);
}

/**
 * Re-index specific doctrine files only. Purges a listed source when its file
 * was deleted. Skips unchanged files unless `force` is set.
 */
export async function reindexDoctrineSources(
  retrieval: RetrievalStore,
  doctrine: DoctrineStore,
  sources: Iterable<string>,
  opts: ReindexSourcesOptions = {},
): Promise<IngestedDoc[]> {
  const force = opts.force === true;
  const out: IngestedDoc[] = [];
  const seen = new Set<string>();

  for (const raw of sources) {
    const source = doctrine.safeName(raw);
    if (!source || seen.has(source)) continue;
    seen.add(source);

    const content = doctrine.readFile(source);
    if (content != null) {
      if (!shouldReingest(doctrine, source, content, force)) continue;
      out.push(await ingestDoctrineDoc(retrieval, doctrine, source, content));
      continue;
    }

    if (doctrine.get(source)) {
      await retrieval.purge(source);
      doctrine.remove(source);
    }
  }

  return out;
}

/**
 * Full sync of the doctrine dir into the vector store: re-ingest changed files,
 * skip byte-identical docs, and purge any previously-ingested doc whose file is
 * gone (so a `git rm` / deleted `.md` drops out of the knowledge base).
 */
export async function reindexDoctrine(retrieval: RetrievalStore, doctrine: DoctrineStore): Promise<IngestedDoc[]> {
  await purgeOrphanedDoctrine(retrieval, doctrine);
  const out: IngestedDoc[] = [];
  for (const source of doctrine.files()) {
    const content = doctrine.readFile(source);
    if (content == null) continue;
    if (!shouldReingest(doctrine, source, content, false)) continue;
    out.push(await ingestDoctrineDoc(retrieval, doctrine, source, content));
  }
  return out;
}

/**
 * Watch the doctrine dir and auto-reindex on change (ROADMAP Phase 6, "canonical"
 * wiki-as-code path). Single-file edits re-embed only that doc; dir-level events
 * (rsync --delete, ambiguous watch payloads) run a full sync with orphan purge.
 * Debounced so a multi-file push batches into one selective pass.
 */
export function watchDoctrineDir(
  retrieval: RetrievalStore,
  doctrine: DoctrineStore,
  logger?: Logger,
  debounceMs = 2500,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pending = false;
  let pendingFull = false;
  const pendingFiles = new Set<string>();
  let watcher: ReturnType<typeof watch> | undefined;

  const run = (): void => {
    if (running) {
      pending = true;
      return;
    }
    running = true;

    const full = pendingFull;
    const files = [...pendingFiles];
    pendingFull = false;
    pendingFiles.clear();

    const job = full
      ? reindexDoctrine(retrieval, doctrine)
      : files.length > 0
        ? reindexDoctrineSources(retrieval, doctrine, files)
        : Promise.resolve([]);

    job
      .then((docs) =>
        logger?.info(
          { docs: docs.length, mode: full ? "full" : "selective", files: full ? undefined : files },
          "Doctrine auto-reindexed (dir changed)",
        ),
      )
      .catch((err) => logger?.warn({ err }, "Doctrine auto-reindex failed"))
      .finally(() => {
        running = false;
        if (pending) {
          pending = false;
          schedule();
        }
      });
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run();
    }, debounceMs);
  };

  const onFsEvent = (filename: string | null | undefined): void => {
    if (filename == null || filename === "") {
      pendingFull = true;
      pendingFiles.clear();
      schedule();
      return;
    }
    const name = String(filename).replace(/\\/g, "/");
    if (!/\.(md|markdown)$/i.test(name)) return;
    const source = doctrine.safeName(name);
    if (!source) {
      pendingFull = true;
      pendingFiles.clear();
      schedule();
      return;
    }
    pendingFiles.add(source);
    schedule();
  };

  try {
    watcher = watch(doctrine.dir, { persistent: false, recursive: true }, (_event, filename) => {
      onFsEvent(filename);
    });
    logger?.info({ dir: doctrine.dir }, "Watching doctrine dir (recursive) — git push / scp / manual edits auto-reindex");
  } catch (err) {
    logger?.warn({ err, dir: doctrine.dir }, "Recursive watch unavailable — falling back to top-level watch");
    try {
      watcher = watch(doctrine.dir, { persistent: false }, (_event, filename) => onFsEvent(filename));
      logger?.info({ dir: doctrine.dir }, "Watching doctrine dir (top-level only)");
    } catch (err2) {
      logger?.warn({ err: err2, dir: doctrine.dir }, "Could not watch doctrine dir; auto-reindex disabled");
    }
  }
  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}