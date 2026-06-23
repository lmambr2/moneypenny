import type { TS3Client } from "../../ts-protocol/client.js";
import type { BotConfig } from "../../data/config.js";
import type { DoctrineStore } from "../../data/doctrine.js";
import type { FileDropStore } from "../../data/file-drop.js";
import type { Logger } from "../../logger.js";
import type { MusicProvider } from "../../music/provider.js";
import { startFileDropWatcher, FILE_DROP_CHANNEL_NAME } from "../../ingest/file-drop.js";
import type { RetrievalStore } from "../../rag/index.js";
import type { WorkflowKind } from "../../docs/workflow.js";
import { analystSavePath } from "../../docs/analyst.js";
import { workflowSavePath } from "../../docs/workflow.js";
import { ingestDoctrineDoc, reindexDoctrine, reindexDoctrineSources } from "../../rag/doctrine-ingest.js";

export interface KnowledgeServiceDeps {
  config: BotConfig;
  logger: Logger;
  tsClient: TS3Client;
  localProvider: MusicProvider;
  isConnected: () => boolean;
  /** Co-located TS6 file-repo mount for file-drop (see TS6_FILES_DIR). */
  tsFilesDir?: string;
  tsVirtualServerId?: number;
}

/** Doctrine RAG, file-drop ingestion, and related chat commands (Phase 5/6). */
export class KnowledgeService {
  private retrieval?: RetrievalStore;
  private doctrine?: DoctrineStore;
  private fileDropStore?: FileDropStore;
  private stopFileDropWatch: (() => void) | null = null;

  constructor(private deps: KnowledgeServiceDeps) {}

  getRetrieval(): RetrievalStore | undefined {
    return this.retrieval;
  }

  getDoctrine(): DoctrineStore | undefined {
    return this.doctrine;
  }

  setRetrieval(store: RetrievalStore | undefined): void {
    this.retrieval = store;
  }

  setDoctrine(store: DoctrineStore | undefined): void {
    this.doctrine = store;
  }

  setFileDropStore(store: FileDropStore | undefined): void {
    this.fileDropStore = store;
    if (this.deps.isConnected()) this.startFileDropWatcher();
  }

  setTsFilesDir(dir: string | undefined, virtualServerId?: number): void {
    this.deps.tsFilesDir = dir;
    if (virtualServerId !== undefined) this.deps.tsVirtualServerId = virtualServerId;
  }

  updateFileDrop(enabled: boolean, pollSec?: number): void {
    this.deps.config.fileDropEnabled = enabled;
    if (pollSec !== undefined && pollSec > 0) this.deps.config.fileDropPollSec = pollSec;
  }

  startFileDropWatcher(): void {
    if (this.stopFileDropWatch || !this.fileDropStore) return;
    this.stopFileDropWatch = startFileDropWatcher({
      tsClient: this.deps.tsClient,
      localProvider: this.deps.localProvider,
      retrieval: this.retrieval,
      doctrine: this.doctrine,
      store: this.fileDropStore,
      config: this.deps.config,
      logger: this.deps.logger,
      isConnected: this.deps.isConnected,
      tsFilesDir: this.deps.tsFilesDir,
      tsVirtualServerId: this.deps.tsVirtualServerId,
    });
  }

  stopFileDropWatcher(): void {
    this.stopFileDropWatch?.();
    this.stopFileDropWatch = null;
  }

  async handleReindex(sources?: string[]): Promise<string> {
    if (!this.deps.config.ragEnabled || !this.retrieval || !this.doctrine) {
      return "The knowledge base is off. An admin can enable it in Settings.";
    }
    try {
      const selective = sources?.map((s) => s.trim()).filter(Boolean) ?? [];
      const docs =
        selective.length > 0
          ? await reindexDoctrineSources(this.retrieval, this.doctrine, selective, { force: true })
          : await reindexDoctrine(this.retrieval, this.doctrine);
      const chunks = docs.reduce((n, d) => n + d.chunks, 0);
      if (selective.length > 0 && docs.length === 0) {
        return `No doctrine files re-indexed (${selective.length} path${selective.length === 1 ? "" : "s"} checked — missing or invalid).`;
      }
      const scope =
        selective.length > 0
          ? `${docs.length} of ${selective.length} requested doc${selective.length === 1 ? "" : "s"}`
          : `${docs.length} doctrine doc${docs.length === 1 ? "" : "s"}`;
      const skippedNote =
        selective.length === 0 && docs.length === 0 ? " (corpus unchanged — all files already indexed)" : "";
      return `Re-indexed ${scope} (${chunks} chunks)${skippedNote}.`;
    } catch (err) {
      this.deps.logger.warn({ err }, "Doctrine reindex failed");
      return "Reindex failed — check the vector DB and embedding service.";
    }
  }

  handleIngestStatus(): string {
    if (!this.fileDropStore) return "File drop isn't available on this build.";
    const rows = this.fileDropStore.recent(10);
    const state = this.deps.config.fileDropEnabled ? "on" : "off";
    if (rows.length === 0) {
      return this.deps.config.fileDropEnabled
        ? `File drop is on (channel "${FILE_DROP_CHANNEL_NAME}") — nothing ingested yet.`
        : `File drop is off. An admin can enable it in Settings → AI & Permissions.`;
    }
    const icon = (k: string) => (k === "doctrine" ? "📎" : k === "music" ? "🎵" : "⚠️");
    const lines = rows.map((r) => `${icon(r.kind)} ${r.name} — ${r.result}`);
    return [`File drop is ${state}; last ${rows.length}:`, ...lines].join("\n");
  }

  /** RAG panel status (Settings test box). */
  async getRagStatus(): Promise<{
    configured: boolean;
    available: boolean;
    docCount: number;
    topK: number;
    vectorDbUrl: string;
    embeddingUrl: string;
    embeddingModel: string;
    ragCollection: string;
  }> {
    let available = false;
    if (this.retrieval) {
      try {
        await this.retrieval.init();
        available = true;
      } catch {
        available = false;
      }
    }
    return {
      configured: this.deps.config.ragEnabled ?? false,
      available,
      docCount: this.doctrine?.list().length ?? 0,
      topK: this.deps.config.ragTopK ?? 4,
      vectorDbUrl: this.deps.config.vectorDbUrl ?? "",
      embeddingUrl: this.deps.config.embeddingUrl || this.deps.config.llmUrl || "",
      embeddingModel: this.deps.config.embeddingModel ?? "",
      ragCollection: this.deps.config.ragCollection ?? "moneypenny_docs",
    };
  }

  /** Admin RAG query — throws when the substrate is down (unlike !ask's soft-fail). */
  async queryRag(
    question: string,
    topK?: number,
    allowedClassifications?: string[],
  ) {
    if (!this.deps.config.ragEnabled || !this.retrieval) return null;
    return this.retrieval.queryStrict(question, topK, allowedClassifications);
  }

  /** Persist arbitrary analyst output into doctrine + Qdrant (DESIGN §R3 `!analyst -s`). */
  async saveAnalystDoc(
    markdown: string,
    classification = "restricted",
  ): Promise<{ ok: true; source: string } | { ok: false; error: string }> {
    if (!this.deps.config.ragEnabled || !this.retrieval || !this.doctrine) {
      return { ok: false, error: "knowledge base is off" };
    }
    const body = stripSourcesFooter(markdown).trim();
    if (!body) return { ok: false, error: "empty document" };

    let content = body;
    if (!body.startsWith("---")) {
      const validUntil = new Date();
      validUntil.setUTCDate(validUntil.getUTCDate() + 30);
      const date = validUntil.toISOString().slice(0, 10);
      content =
        `---\nclassification: ${classification}\ntags: [analyst, report]\nvalid_until: ${date}\n---\n\n` +
        body;
    }

    let source = analystSavePath();
    if (this.doctrine.readFile(source) != null) {
      const stamp = Date.now();
      const dot = source.lastIndexOf(".");
      source = `${source.slice(0, dot)}-${stamp}${source.slice(dot)}`;
    }

    try {
      await ingestDoctrineDoc(this.retrieval, this.doctrine, source, content);
      return { ok: true, source };
    } catch (err) {
      this.deps.logger.warn({ err, source }, "Analyst doc save failed");
      return { ok: false, error: "ingest failed — check vector DB and embeddings" };
    }
  }

  /** Persist a generated workflow doc into doctrine + Qdrant (DESIGN §R3 `-s` flag). */
  async saveWorkflowDoc(
    kind: WorkflowKind,
    markdown: string,
  ): Promise<{ ok: true; source: string } | { ok: false; error: string }> {
    if (!this.deps.config.ragEnabled || !this.retrieval || !this.doctrine) {
      return { ok: false, error: "knowledge base is off" };
    }
    const body = stripSourcesFooter(markdown).trim();
    if (!body) return { ok: false, error: "empty document" };

    let source = workflowSavePath(kind);
    if (this.doctrine.readFile(source) != null) {
      const stamp = Date.now();
      const dot = source.lastIndexOf(".");
      source = `${source.slice(0, dot)}-${stamp}${source.slice(dot)}`;
    }

    try {
      await ingestDoctrineDoc(this.retrieval, this.doctrine, source, body);
      return { ok: true, source };
    } catch (err) {
      this.deps.logger.warn({ err, source, kind }, "Workflow doc save failed");
      return { ok: false, error: "ingest failed — check vector DB and embeddings" };
    }
  }
}

/** Drop the deterministic citation footer before persisting generated docs. */
function stripSourcesFooter(text: string): string {
  const marker = "\n\n📎 Sources:";
  const idx = text.indexOf(marker);
  return idx >= 0 ? text.slice(0, idx) : text;
}