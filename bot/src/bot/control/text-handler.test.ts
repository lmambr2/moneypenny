import { describe, expect, it, vi } from "vitest";
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
      roast: { captureLine: vi.fn(), captureExchange: vi.fn() } as any,
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

  it("captures !ask plus her reply for the roast log", async () => {
    const captureExchange = vi.fn();
    const sendTextMessage = vi.fn();
    const handler = new TextMessageHandler({
      bot: {} as any,
      config: { commandPrefix: "!", commandAliases: {} } as any,
      logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      tsClient: { sendTextMessage } as any,
      router: {
        route: vi.fn().mockResolvedValue({
          type: "llm",
          llmIntent: { mode: "ask", text: "how do I refine" },
        }),
        execute: vi.fn().mockResolvedValue("Slowly, dear."),
      } as any,
      roast: { captureLine: vi.fn(), captureExchange } as any,
      llm: { classificationsFor: vi.fn() } as any,
      rightsEngine: () => null,
    });

    await handler.handle({
      message: "!ask how do I refine",
      invokerUid: "u1",
      invokerName: "Alice",
      targetMode: 2,
    } as any);

    expect(captureExchange).toHaveBeenCalledWith({
      userUid: "u1",
      userName: "Alice",
      question: "how do I refine",
      reply: "Slowly, dear.",
    });
    expect(sendTextMessage).toHaveBeenCalledWith("Slowly, dear.");
  });
});
