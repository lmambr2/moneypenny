import type { ControlRouter, RouterContext } from "../../control/router.js";
import type { BotConfig } from "../../data/config.js";
import type { Logger } from "../../logger.js";
import type { RightsEngine } from "../../rights/index.js";
import type { TS3Client, TS3TextMessage } from "../../ts-protocol/client.js";
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
  constructor(private deps: TextMessageHandlerDeps) {}

  async handle(msg: TS3TextMessage): Promise<void> {
    this.deps.roast.captureLine(msg);

    let canRun: ((commandName: string) => boolean) | undefined;
    let allowedClassifications: string[] | undefined;
    const engine = this.deps.rightsEngine();
    if (engine) {
      const invokerClid = Number.parseInt(msg.invokerId, 10);
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
        await this.deps.tsClient.sendTextMessage(response);
      } else if (decision.type === "deterministic" && decision.command) {
        this.deps.logger.warn(
          { command: decision.command.name },
          "Router returned no response — command may be incomplete in new system",
        );
      }
    } catch (err) {
      this.deps.logger.error({ err, decision }, "ControlRouter error");
      try {
        await this.deps.tsClient.sendTextMessage(`Error: ${(err as Error).message}`);
      } catch {
        /* best-effort error reply */
      }
    }
  }
}
