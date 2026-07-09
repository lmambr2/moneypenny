import { describe, it, expect, vi, beforeEach } from "vitest";
import { ControlRouter } from "./router.js";
import { registerBotCommandHandlers, type CommandHandlerHost } from "./register-handlers.js";
import type { ParsedCommand } from "../bot/commands.js";
import type { TS3TextMessage } from "../ts-protocol/client.js";

function fakeLogger(): any {
  const l: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  l.child = () => l;
  return l;
}

function makeHost(overrides: Partial<CommandHandlerHost> = {}): CommandHandlerHost {
  return {
    commands: { execute: vi.fn().mockResolvedValue("ok") } as unknown as CommandHandlerHost["commands"],
    playback: {
      addResolvedItem: vi.fn(),
      playResolvedItem: vi.fn(),
    } as unknown as CommandHandlerHost["playback"],
    roast: { handleCommand: vi.fn(), handleOptOut: vi.fn() } as unknown as CommandHandlerHost["roast"],
    memory: {
      handleRemember: vi.fn(),
      handleRecall: vi.fn().mockResolvedValue(""),
      handleForget: vi.fn(),
      setMemPalace: vi.fn(),
    } as unknown as CommandHandlerHost["memory"],
    kg: {
      handleKg: vi.fn(),
      handleDiary: vi.fn(),
    } as unknown as CommandHandlerHost["kg"],
    knowledge: {
      handleReindex: vi.fn(),
      handleIngestStatus: vi.fn(),
    } as unknown as CommandHandlerHost["knowledge"],
    generate: {
      handleGenerate: vi.fn().mockResolvedValue("generated ok"),
    },
    ...overrides,
  };
}

describe("registerBotCommandHandlers", () => {
  let router: ControlRouter;
  let executeCommand: ReturnType<typeof vi.fn>;
  let host: CommandHandlerHost;

  beforeEach(() => {
    router = new ControlRouter(fakeLogger());
    executeCommand = vi.fn().mockResolvedValue("ok");
    host = makeHost({
      commands: { execute: executeCommand } as unknown as CommandHandlerHost["commands"],
    });
    registerBotCommandHandlers(router, host);
  });

  it("delegates prev to executeCommand with the source message (vote/follow parity)", async () => {
    const msg = { invokerUid: "uid-1" } as TS3TextMessage;
    const decision = await router.route("!prev", { bot: { isConnected: () => true } as any, logger: fakeLogger() });
    const out = await router.execute(decision, {
      bot: { isConnected: () => true } as any,
      logger: fakeLogger(),
      message: msg,
    });
    expect(out).toBe("ok");
    expect(executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({ name: "prev" }) as ParsedCommand,
      msg,
    );
  });

  // Regression: a command in PUBLIC/ADMIN_COMMANDS with an executor switch case
  // but no registered handler routes to "Unknown command". Both of these must
  // reach executeCommand.
  it.each(["chevron7", "radio"])("delegates %s to executeCommand", async (name) => {
    const decision = await router.route(`!${name}`, {
      bot: { isConnected: () => true } as any,
      logger: fakeLogger(),
    });
    const out = await router.execute(decision, {
      bot: { isConnected: () => true } as any,
      logger: fakeLogger(),
      message: {} as TS3TextMessage,
    });
    expect(out).toBe("ok");
    expect(executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({ name }) as ParsedCommand,
      expect.anything(),
    );
  });
});