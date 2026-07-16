/**
 * Declarative command registry (PR-A1).
 *
 * Holds handlers + optional middleware pipeline. ControlRouter dual-writes
 * registerHandler into this registry so execution can migrate off the
 * internal Map without a big-bang rewrite.
 */
import {
  COMMAND_MANIFEST,
  type CommandSpec,
  type ParsedCommand,
} from "../bot/commands.js";
import type { CommandHandler, RouterContext, RouterDecision } from "./router.js";

export type ControlMiddleware = (
  ctx: RouterContext,
  cmd: ParsedCommand,
  decision: RouterDecision,
  next: () => Promise<string | null>,
) => Promise<string | null>;

export class CommandRegistry {
  private handlers = new Map<string, CommandHandler>();
  private middleware: ControlMiddleware[] = [];
  /** llmTool / alias → command name */
  private toolAliases = new Map<string, string>();

  constructor(private readonly specs: readonly CommandSpec[] = COMMAND_MANIFEST) {
    for (const s of specs) {
      this.toolAliases.set(s.name, s.name);
      if (s.llmTool) this.toolAliases.set(s.llmTool, s.name);
    }
  }

  /** Append middleware (order = registration order). */
  use(mw: ControlMiddleware): this {
    this.middleware.push(mw);
    return this;
  }

  clearMiddleware(): void {
    this.middleware = [];
  }

  register(handler: CommandHandler): void {
    this.handlers.set(handler.name.toLowerCase(), handler);
  }

  has(name: string): boolean {
    return this.handlers.has(name.toLowerCase());
  }

  get(name: string): CommandHandler | undefined {
    return this.handlers.get(name.toLowerCase());
  }

  /** All registered handler names (lowercase). */
  names(): string[] {
    return [...this.handlers.keys()];
  }

  spec(name: string): CommandSpec | undefined {
    const n = name.toLowerCase();
    return this.specs.find((s) => s.name === n);
  }

  /** Rights token for a command (spec.rightsToken ?? name). */
  rightsToken(name: string): string {
    return this.spec(name)?.rightsToken ?? name.toLowerCase();
  }

  /**
   * Map an LLM tool name + args to a ParsedCommand using manifest llmTool
   * aliases. Special multi-arg tools (move_client, select_tracks, …) still
   * go through toolCallToCommand in the router — this covers simple 1:1 maps.
   */
  toolToCommand(toolName: string, args: Record<string, unknown> = {}): ParsedCommand | null {
    const cmdName = this.toolAliases.get(toolName) ?? this.toolAliases.get(toolName.toLowerCase());
    if (!cmdName) return null;

    const q =
      typeof args.query === "string"
        ? args.query.trim()
        : typeof args.target === "string"
          ? args.target.trim()
          : typeof args.prompt === "string"
            ? args.prompt.trim()
            : typeof args.task === "string"
              ? args.task.trim()
              : "";

    const flags = new Set<string>();
    if (args.platform === "youtube" || args.source === "youtube") flags.add("y");
    if (args.platform === "local" || args.source === "local") flags.add("l");
    if (args.platform === "stream" || args.source === "stream") flags.add("s");

    return {
      name: cmdName,
      args: q,
      rawArgs: q ? q.split(/\s+/).filter(Boolean) : [],
      flags,
    };
  }

  /**
   * Run middleware chain then the registered handler.
   * Returns a friendly unknown-command string if no handler.
   */
  async execute(
    cmd: ParsedCommand,
    ctx: RouterContext,
    decision: RouterDecision,
  ): Promise<string | null> {
    const handler = this.get(cmd.name);
    if (!handler) {
      return `Unknown command. Try ${"!"}help.`;
    }

    let i = 0;
    const run = async (): Promise<string | null> => {
      if (i < this.middleware.length) {
        const mw = this.middleware[i++];
        return mw(ctx, cmd, decision, run);
      }
      return handler.execute(cmd, ctx, decision);
    };
    return run();
  }
}
