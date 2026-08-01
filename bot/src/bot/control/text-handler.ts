import type { TS3Client, TS3TextMessage } from "@moneypenny/ts6-client";
import type { ControlRouter, RouterContext } from "../../control/router.js";
import type { BotConfig } from "../../data/config.js";
import type { Logger } from "../../logger.js";
import type { RightsEngine } from "../../rights/index.js";
import type { RoastService } from "../community/roast.js";
import type { BotInstance } from "../instance.js";
import type { LlmRuntime } from "../llm/runtime.js";
import { conversationKey, resolveSubject } from "../rights/subject.js";

export interface TextMessageHandlerDeps {
  bot: BotInstance;
  config: BotConfig;
  logger: Logger;
  tsClient: TS3Client;
  router: ControlRouter;
  roast: RoastService;
  llm: LlmRuntime;
  rightsEngine: () => RightsEngine | null;
}

/** TeamSpeak text-message path: roast capture → rights context → ControlRouter. */
export class TextMessageHandler {
  /** Identical reply within this window is suppressed (echo-loop breaker). */
  private static readonly REPLY_DEDUPE_MS = 4_000;
  private lastReply: { text: string; at: number } | null = null;

  constructor(private deps: TextMessageHandlerDeps) {}

  async handle(msg: TS3TextMessage): Promise<void> {
    const invokerClid = Number.parseInt(msg.invokerId, 10);
    // Host-level self filter (ts6-client also filters; belt if clid was 0 there).
    const ownId = this.deps.tsClient.getClientId?.() ?? 0;
    if (ownId > 0 && Number.isFinite(invokerClid) && invokerClid === ownId) {
      this.deps.logger.debug({ message: msg.message }, "Text handler: ignore own message");
      return;
    }

    this.deps.roast.captureLine(msg);
    // Presence for radio: chat proves a human is here even if clientlist lags.
    if (Number.isFinite(invokerClid) && invokerClid > 0) {
      try {
        this.deps.bot.noteRadioHumanActivity?.(invokerClid);
      } catch {
        /* optional on fakes */
      }
    }

    let canRun: ((commandName: string) => boolean) | undefined;
    let allowedClassifications: string[] | undefined;
    const engine = this.deps.rightsEngine();
    if (engine) {
      const subject = await resolveSubject(
        msg.invokerUid,
        this.deps.tsClient,
        this.deps.logger,
        msg.invokerGroups,
        Number.isFinite(invokerClid) ? invokerClid : undefined,
      );
      canRun = (commandName: string) => engine.can(subject, commandName);
      allowedClassifications = this.deps.llm.classificationsFor(subject);
    }

    const context: RouterContext = {
      bot: this.deps.bot,
      logger: this.deps.logger,
      conversationId: conversationKey(msg),
      canRun,
      invokerUid: msg.invokerUid,
      invokerName: msg.invokerName,
      allowedClassifications,
      message: msg,
      postFollowUp: async (text) => {
        await this.deps.tsClient.sendTextMessage(text);
      },
    };

    const decision = await this.deps.router.route(
      msg.message,
      context,
      this.deps.config.commandPrefix,
      this.deps.config.commandAliases,
    );

    try {
      const response = await this.deps.router.execute(decision, context);
      if (response) {
        await this.sendReply(response);
      } else if (decision.type === "deterministic" && decision.command) {
        this.deps.logger.warn(
          { command: decision.command.name },
          "Router returned no response — command may be incomplete in new system",
        );
      }
    } catch (err) {
      this.deps.logger.error({ err, decision }, "ControlRouter error");
      try {
        await this.sendReply(`Error: ${(err as Error).message}`);
      } catch {
        /* best-effort error reply */
      }
    }
  }

  /** Send channel reply with identical-text flood suppression. */
  private async sendReply(text: string): Promise<void> {
    const trimmed = text.trim();
    const now = Date.now();
    if (
      this.lastReply &&
      this.lastReply.text === trimmed &&
      now - this.lastReply.at < TextMessageHandler.REPLY_DEDUPE_MS
    ) {
      this.deps.logger.warn(
        { preview: trimmed.slice(0, 80) },
        "Suppressing identical channel reply (echo loop breaker)",
      );
      return;
    }
    this.lastReply = { text: trimmed, at: now };
    await this.deps.tsClient.sendTextMessage(text);
  }
}
