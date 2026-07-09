import type { ControlRouter, RouterContext } from "../../control/router.js";
import type { Logger } from "../../logger.js";
import type { TS3Client, TS3TextMessage } from "../../ts-protocol/client.js";
import type { ParsedCommand } from "../commands.js";
import type { BotInstance } from "../instance.js";
import type { RightsRuntime } from "../rights/runtime.js";
import { resolveSubject, resolveWebSubject } from "../rights/subject.js";

export interface RoutedExecutorDeps {
  bot: BotInstance;
  router: ControlRouter;
  rights: RightsRuntime;
  tsClient: TS3Client;
  logger: Logger;
  adminGroups: () => string[];
}

/** Web + TS routed command execution with rank gating (shared with voice path). */
export class RoutedCommandExecutor {
  constructor(private deps: RoutedExecutorDeps) {}

  canWebUserRunCommand(
    user: { id: string; username: string; role: "admin" | "member" },
    commandName: string,
  ): Promise<boolean> {
    const engine = this.deps.rights.getEngine();
    if (!engine) return Promise.resolve(true);
    return resolveWebSubject(
      user,
      this.deps.tsClient,
      this.deps.adminGroups().map(String),
      this.deps.logger,
    ).then((subject) => engine.can(subject, commandName));
  }

  async executeRoutedCommand(
    cmd: ParsedCommand,
    opts?: {
      webUser?: { id: string; username: string; role: "admin" | "member" };
      message?: TS3TextMessage;
    },
  ): Promise<{ message: string | null; denied: boolean }> {
    let canRun: ((commandName: string) => boolean) | undefined;
    const engine = this.deps.rights.getEngine();
    if (engine) {
      if (opts?.webUser) {
        const subject = await resolveWebSubject(
          opts.webUser,
          this.deps.tsClient,
          this.deps.adminGroups().map(String),
          this.deps.logger,
        );
        canRun = (commandName) => engine.can(subject, commandName);
      } else if (opts?.message) {
        const invokerClid = Number.parseInt(opts.message.invokerId, 10);
        const subject = await resolveSubject(
          opts.message.invokerUid,
          this.deps.tsClient,
          this.deps.logger,
          opts.message.invokerGroups,
          Number.isFinite(invokerClid) ? invokerClid : undefined,
        );
        canRun = (commandName) => engine.can(subject, commandName);
      }
    }

    const context: RouterContext = {
      bot: this.deps.bot,
      logger: this.deps.logger,
      conversationId: opts?.webUser ? `web:${opts.webUser.id}` : undefined,
      canRun,
      invokerUid: opts?.webUser ? `web:${opts.webUser.id}` : opts?.message?.invokerUid,
      invokerName: opts?.webUser?.username ?? opts?.message?.invokerName,
      message: opts?.message,
    };

    const message = await this.deps.router.executeParsedCommand(cmd, context);
    const denied = message?.startsWith("You don't have permission") ?? false;
    return { message, denied };
  }
}
