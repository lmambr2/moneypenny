import type { BotConfig } from "../../data/config.js";
import type { MemoryStore } from "../../data/memory.js";
import { economyContextForQuestion } from "../../economy/context.js";
import { DelegateClient } from "../../llm/delegate.js";
import { createLlmClient } from "../../llm/fallback-client.js";
import { LlmModule, type RetrievalHook } from "../../llm/index.js";
import type { Logger } from "../../logger.js";
import type { MemPalaceClient } from "../../memory/mempalace-client.js";
import type { RetrievalStore } from "../../rag/index.js";
import type { RightsEngine, Subject } from "../../rights/index.js";
import type { KgService } from "../community/kg.js";
import { allowedClassificationsFor } from "../rights/subject.js";

export interface LlmRuntimeDeps {
  config: BotConfig;
  logger: Logger;
  memoryStore: MemoryStore;
  getKg: () => KgService | null;
  getMemPalace: () => MemPalaceClient | null;
  getRetrieval: () => RetrievalStore | undefined;
  getRightsEngine: () => RightsEngine | null;
  onModuleChange: (module: LlmModule | null) => void;
}

/**
 * In-process LLM lifecycle + RAG/memory retrieval hook (DESIGN §9, Phase 5–7).
 */
export class LlmRuntime {
  private module: LlmModule | null = null;

  constructor(private deps: LlmRuntimeDeps) {}

  getModule(): LlmModule | null {
    return this.module;
  }

  /** Create the module when llmEnabled is set at construction time. */
  initialize(): void {
    if (this.deps.config.llmEnabled) {
      this.rebuild();
      this.deps.logger.info(
        {
          url: this.deps.config.llmUrl || "(default)",
          model: this.deps.config.llmModel || "(default)",
        },
        "LLM module enabled",
      );
    }
  }

  updateLlm(
    enabled: boolean,
    url?: string,
    model?: string,
    systemPrompt?: string,
    temperature?: number,
    fallbackUrl?: string,
    fallbackModel?: string,
    delegateUrl?: string,
    delegateModel?: string,
  ): void {
    this.deps.config.llmEnabled = enabled;
    this.deps.config.llmUrl = url ?? "";
    this.deps.config.llmModel = model ?? "";
    if (fallbackUrl !== undefined) this.deps.config.llmFallbackUrl = fallbackUrl;
    if (fallbackModel !== undefined) this.deps.config.llmFallbackModel = fallbackModel;
    if (delegateUrl !== undefined) this.deps.config.llmDelegateUrl = delegateUrl;
    if (delegateModel !== undefined) this.deps.config.llmDelegateModel = delegateModel;
    if (systemPrompt !== undefined) this.deps.config.llmSystemPrompt = systemPrompt;
    if (temperature !== undefined) this.deps.config.llmTemperature = temperature;
    if (!enabled) {
      this.module = null;
      this.deps.onModuleChange(null);
      return;
    }
    this.rebuild();
  }

  updateRag(enabled: boolean, topK?: number): void {
    this.deps.config.ragEnabled = enabled;
    if (topK !== undefined) this.deps.config.ragTopK = topK;
    this.refreshRetrieveHook();
  }

  updateMemory(enabled: boolean): void {
    this.deps.config.memoryEnabled = enabled;
    this.refreshRetrieveHook();
  }

  updateKg(enabled: boolean): void {
    this.deps.config.kgEnabled = enabled;
    this.deps.getKg()?.updateKg(enabled);
    this.refreshRetrieveHook();
  }

  refreshRetrieveHook(): void {
    this.module?.setRetrieve(this.buildRetrieveHook());
  }

  buildRetrieveHook(): RetrievalHook | undefined {
    // Economy seed injects on keyword match even when RAG/memory/KG are off,
    // so !ask "how do I refine quantainium" still gets order context.
    if (
      !this.deps.config.ragEnabled &&
      !this.deps.config.memoryEnabled &&
      !this.deps.config.kgEnabled
    ) {
      return async (q) => economyContextForQuestion(q);
    }
    return (q, ctx) => this.retrieveContext(q, ctx);
  }

  classificationsFor(subject: Subject): string[] | undefined {
    return allowedClassificationsFor(subject, this.deps.getRightsEngine());
  }

  async getLlmStatus(): Promise<{
    configured: boolean;
    available: boolean;
    primaryAvailable: boolean;
    fallbackAvailable: boolean;
    fallbackConfigured: boolean;
    activeFallback: boolean;
    delegateConfigured: boolean;
    delegateAvailable: boolean;
  }> {
    if (!this.module) {
      return {
        configured: false,
        available: false,
        primaryAvailable: false,
        fallbackAvailable: false,
        fallbackConfigured: false,
        activeFallback: false,
        delegateConfigured: false,
        delegateAvailable: false,
      };
    }
    return this.module.getAvailability();
  }

  async askLlm(question: string): Promise<string | null> {
    if (!this.module) return null;
    return this.module.ask(question);
  }

  private rebuild(): void {
    const delegateUrl = this.deps.config.llmDelegateUrl?.trim();
    const mc = this.deps.config.memoryContext ?? {};
    const cc = this.deps.config.ragClaimCheck ?? {};
    this.module = new LlmModule({
      logger: this.deps.logger,
      systemPrompt: this.deps.config.llmSystemPrompt || undefined,
      temperature: this.deps.config.llmTemperature,
      retrieve: this.buildRetrieveHook(),
      workingTurns: mc.workingTurns,
      memoryBudgets: {
        workingTurns: mc.workingTurns,
        doctrineChunks: mc.doctrineChunks,
        orgKgHits: mc.orgKgHits,
        playbooks: mc.playbooks,
        lastTools: mc.lastTools,
      },
      dedupeInjections: mc.dedupeInjections !== false,
      claimCheck: {
        enabled: cc.enabled === true,
        maxClaims: cc.maxClaims,
        maxExtraRetrieves: cc.maxExtraRetrieves,
        revise: cc.revise,
        timeoutMs: cc.timeoutMs,
      },
      delegate: delegateUrl
        ? new DelegateClient({
            baseUrl: delegateUrl,
            model: this.deps.config.llmDelegateModel || undefined,
            logger: this.deps.logger,
          })
        : undefined,
      client: createLlmClient({
        primary: {
          baseUrl: this.deps.config.llmUrl || undefined,
          model: this.deps.config.llmModel || undefined,
          timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS || "180000", 10) || 180_000,
          logger: this.deps.logger,
        },
        fallbackUrl: this.deps.config.llmFallbackUrl,
        fallbackModel: this.deps.config.llmFallbackModel || undefined,
        logger: this.deps.logger,
      }),
    });
    this.deps.onModuleChange(this.module);
  }

  /**
   * Public retrieve for harness cockpit (H1/H2) — same sources as !ask, with
   * classification when the vector payload has it.
   */
  async retrieveForHarness(
    question: string,
    ctx?: { allowedClassifications?: string[]; userUid?: string },
  ): Promise<Array<{ text: string; source: string; score?: number; classification?: string }>> {
    return this.retrieveContext(question, ctx);
  }

  private async retrieveContext(
    question: string,
    ctx?: { allowedClassifications?: string[]; userUid?: string },
  ): Promise<Array<{ text: string; source: string; score?: number; classification?: string }>> {
    const out: Array<{ text: string; source: string; score?: number; classification?: string }> =
      [];
    const retrieval = this.deps.getRetrieval();
    if (this.deps.config.ragEnabled && retrieval) {
      const chunks = await retrieval.query(
        question,
        this.deps.config.ragTopK,
        ctx?.allowedClassifications,
      );
      out.push(
        ...chunks.map((c) => ({
          text: c.text,
          source: c.source,
          score: c.score,
          classification: c.classification,
        })),
      );
    }
    if (this.deps.config.memoryEnabled && ctx?.userUid) {
      const mp = this.deps.config.mempalaceEnabled ? this.deps.getMemPalace() : null;
      if (mp) {
        const hits = await mp.search(ctx.userUid, question, 8);
        const seen = new Set(hits.map((h) => h.fact.trim().toLowerCase()));
        out.push(
          ...hits.map((h) => ({
            text: h.fact,
            source: "your memory (MemPalace)",
            score: h.score ?? 1,
          })),
        );
        const local = this.deps.memoryStore.recall(ctx.userUid, 10);
        for (const f of local) {
          const key = f.fact.trim().toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ text: f.fact, source: "your memory", score: 0.5 });
        }
      } else {
        const facts = this.deps.memoryStore.recall(ctx.userUid, 10);
        out.push(...facts.map((f) => ({ text: f.fact, source: "your memory", score: 1 })));
      }
    }
    if (this.deps.config.kgEnabled) {
      const kg = this.deps.getKg();
      if (kg) {
        const hits = await kg.recallForQuestion(question);
        out.push(...hits.map((h) => ({ text: h.text, source: h.source, score: 0.9 })));
      }
    }
    // Static org-economy seed (docs/economy.md) — no network on the ask path.
    out.push(...economyContextForQuestion(question));
    return out;
  }
}
