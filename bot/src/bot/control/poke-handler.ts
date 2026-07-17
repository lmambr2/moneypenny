import type { ControlRouter, RouterContext } from "../../control/router.js";
import type { BotConfig } from "../../data/config.js";
import type { Logger } from "../../logger.js";
import type { RightsEngine } from "../../rights/index.js";
import type { TS3Client, TS3Poke } from "@moneypenny/ts6-client";
import type { BotInstance } from "../instance.js";
import type { LlmRuntime } from "../llm/runtime.js";
import { resolveSubject } from "../rights/subject.js";

export interface PokeHandlerDeps {
  bot: BotInstance;
  config: BotConfig;
  logger: Logger;
  tsClient: TS3Client;
  router: ControlRouter;
  llm: LlmRuntime;
  rightsEngine: () => RightsEngine | null;
}

/** Sliding-window rate limit for poke commands (per invoker UID). */
export class PokeRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly windowMs = 60_000) {}

  /** Returns true if the poke should be allowed (and records it). */
  allow(uid: string, maxPerMinute: number, now = Date.now()): boolean {
    const max = Math.max(1, maxPerMinute);
    const key = uid || "unknown";
    const cutoff = now - this.windowMs;
    const prev = (this.hits.get(key) ?? []).filter((t) => t >= cutoff);
    if (prev.length >= max) {
      this.hits.set(key, prev);
      return false;
    }
    prev.push(now);
    this.hits.set(key, prev);
    return true;
  }
}

/**
 * TeamSpeak poke → ControlRouter (docs/BUILD.md P0).
 * Prefix optional (same policy as voice). Replies via poke-back (short) +
 * channel text for longer public results when useful.
 */
export class PokeHandler {
  private limiter = new PokeRateLimiter();

  constructor(private deps: PokeHandlerDeps) {}

  async handle(poke: TS3Poke): Promise<void> {
    if (this.deps.config.pokeCommandsEnabled === false) {
      this.deps.logger.debug(
        { from: poke.invokerName },
        "Poke ignored (pokeCommandsEnabled=false)",
      );
      return;
    }

    const body = (poke.message ?? "").trim();
    if (!body) {
      await this.reply(poke, "Send a command in the poke, e.g. skip or !play song");
      return;
    }

    const maxPerMin = this.deps.config.pokeCommandsPerMinute ?? 12;
    if (!this.limiter.allow(poke.invokerUid || poke.invokerId, maxPerMin)) {
      await this.reply(poke, "Too many pokes — slow down.");
      return;
    }

    let canRun: ((commandName: string) => boolean) | undefined;
    let allowedClassifications: string[] | undefined;
    const engine = this.deps.rightsEngine();
    const invokerClid = Number.parseInt(poke.invokerId, 10);
    if (engine) {
      const subject = await resolveSubject(
        poke.invokerUid,
        this.deps.tsClient,
        this.deps.logger,
        undefined,
        Number.isFinite(invokerClid) ? invokerClid : undefined,
      );
      canRun = (commandName: string) => engine.can(subject, commandName);
      allowedClassifications = this.deps.llm.classificationsFor(subject);
    }

    const context: RouterContext = {
      bot: this.deps.bot,
      logger: this.deps.logger,
      conversationId: `poke:${poke.invokerUid || poke.invokerId}`,
      canRun,
      invokerUid: poke.invokerUid,
      invokerName: poke.invokerName,
      allowedClassifications,
      postFollowUp: async (text) => {
        await this.reply(poke, text);
      },
    };

    // Prefix optional — same as voice.
    const decision = await this.deps.router.routeVoice(
      body,
      context,
      this.deps.config.commandAliases,
    );

    if (decision.type === "unknown") {
      await this.reply(poke, "Unknown command. Try skip, play <song>, or !ask …");
      return;
    }

    try {
      const response = await this.deps.router.execute(decision, context);
      if (response) {
        await this.reply(poke, response);
        // Public side-effects also land in channel so others see now-playing etc.
        if (shouldMirrorToChannel(response)) {
          try {
            await this.deps.tsClient.sendTextMessage(response);
          } catch {
            /* best-effort */
          }
        }
      }
    } catch (err) {
      this.deps.logger.error({ err, from: poke.invokerName }, "Poke command error");
      try {
        await this.reply(poke, `Error: ${(err as Error).message}`);
      } catch {
        /* best-effort */
      }
    }
  }

  private async reply(poke: TS3Poke, text: string): Promise<void> {
    const clid = Number.parseInt(poke.invokerId, 10);
    if (Number.isFinite(clid) && clid > 0) {
      try {
        await this.deps.tsClient.pokeClient(clid, text);
        return;
      } catch (err) {
        this.deps.logger.debug({ err }, "poke reply failed — falling back to channel text");
      }
    }
    try {
      await this.deps.tsClient.sendTextMessage(text);
    } catch {
      /* best-effort */
    }
  }
}

/** Long / public results that others in channel should also see. */
export function shouldMirrorToChannel(response: string): boolean {
  const t = response.trim();
  if (t.length > 100) return true;
  if (/^now playing/i.test(t)) return true;
  if (/^queued/i.test(t)) return true;
  if (/^skipped/i.test(t)) return true;
  return false;
}
