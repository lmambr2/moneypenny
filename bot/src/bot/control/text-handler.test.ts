import { describe, it, expect, vi } from "vitest";
import { TextMessageHandler } from "./text-handler.js";

describe("TextMessageHandler", () => {
  it("routes a command and sends the router response", async () => {
    const sendTextMessage = vi.fn();
    const route = vi.fn().mockResolvedValue({ type: "deterministic", command: { name: "help" } });
    const execute = vi.fn().mockResolvedValue("Help text");
    const handler = new TextMessageHandler({
      bot: {} as any,
      config: { commandPrefix: "!", commandAliases: {} } as any,
      logger: { warn: vi.fn(), error: vi.fn() } as any,
      tsClient: { sendTextMessage } as any,
      router: { route, execute } as any,
      roast: { captureLine: vi.fn() } as any,
      llm: { classificationsFor: vi.fn() } as any,
      rightsEngine: () => null,
    });

    await handler.handle({
      message: "!help",
      invokerUid: "u1",
      invokerName: "Alice",
      targetMode: 2,
    } as any);

    expect(route).toHaveBeenCalled();
    expect(execute).toHaveBeenCalled();
    expect(sendTextMessage).toHaveBeenCalledWith("Help text");
  });
});