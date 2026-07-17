/**
 * Declarative command registry (PR-A1 / A2 / A3).
 *
 * Holds handlers + optional middleware pipeline. Tool-call mapping lives in
 * tool-map.ts (special mappers) + CommandSpec.llmTool aliases.
 */
import { COMMAND_MANIFEST, type CommandSpec, type ParsedCommand } from "../bot/commands.js";
import type { CommandHandler, RouterContext, RouterDecision } from "./router.js";
import { type ToolCallInput, toolCallToCommand } from "./tool-map.js";

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
   * Map an LLM tool call to a ParsedCommand via the shared tool-map
   * (special mappers + manifest llmTool aliases).
   */
  toolToCommand(toolName: string, args: Record<string, unknown> = {}): ParsedCommand | null {
    return toolCallToCommand({ name: toolName, arguments: args });
  }

  /** Same as toolToCommand but accepts a full tool-call object. */
  mapToolCall(tc: ToolCallInput): ParsedCommand | null {
    return toolCallToCommand(tc);
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
