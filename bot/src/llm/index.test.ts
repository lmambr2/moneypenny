import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest, ChatCompletionResponse } from "./client.js";
import { ConversationStore, LlmModule } from "./index.js";

// Build a fake LlmClient that records requests and returns scripted responses.
function fakeClient(responder: (req: ChatCompletionRequest) => ChatCompletionResponse) {
  const requests: ChatCompletionRequest[] = [];
  const client = {
    chat: vi.fn(async (req: ChatCompletionRequest) => {
      requests.push(req);
      return responder(req);
    }),
  };
  return { client, requests };
}

function textResponse(content: string | null, toolCalls?: any[]): ChatCompletionResponse {
  return {
    id: "x",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, tool_calls: toolCalls },
        finish_reason: "stop",
      },
    ],
  };
}

describe("LlmModule history", () => {
  it("ask is stateless when no conversationId is given", async () => {
    const { client, requests } = fakeClient(() => textResponse("answer"));
    const mod = new LlmModule({ client: client as any });

    await mod.ask("first");
    await mod.ask("second");

    // Each request: [system, user] only — no carried-over history.
    expect(requests[1].messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(requests[1].messages[1].content).toBe("second");
  });

  it("ask carries prior turns when a conversationId is given", async () => {
    const { client, requests } = fakeClient((req) => {
      const last = req.messages[req.messages.length - 1].content;
      return textResponse(`re:${last}`);
    });
    const mod = new LlmModule({ client: client as any });

    const a1 = await mod.ask("what is jazz", "room");
    expect(a1).toBe("re:what is jazz");

    await mod.ask("and blues", "room");
    // Second request: system prompt, then the first exchange, then new user turn.
    expect(requests[1].messages[0].role).toBe("system");
    expect(requests[1].messages.slice(1).map((m) => m.content)).toEqual([
      "what is jazz",
      "re:what is jazz",
      "and blues",
    ]);
  });

  it("does not persist failed ask turns", async () => {
    let calls = 0;
    const { client, requests } = fakeClient(() => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return textResponse("ok");
    });
    const mod = new LlmModule({ client: client as any });

    const first = await mod.ask("hi", "room");
    expect(first).toMatch(/moment/i); // friendly fallback

    await mod.ask("hello", "room");
    // The failed "hi" turn must not pollute history — the successful request
    // carries only [system, user].
    expect(requests[1].messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(requests[1].messages[1].content).toBe("hello");
  });

  it("chatForIntent records a compact turn even when only tool calls are returned", async () => {
    const { client, requests } = fakeClient(() =>
      textResponse(null, [
        {
          id: "1",
          type: "function",
          function: { name: "play_music", arguments: '{"query":"jazz"}' },
        },
      ]),
    );
    const history = new ConversationStore();
    const mod = new LlmModule({ client: client as any, history });

    const r = await mod.chatForIntent("put on some jazz", "room");
    expect(r.toolCalls?.[0].name).toBe("play_music");

    // A follow-up should see the prior (summarized) assistant turn.
    await mod.chatForIntent("something faster", "room");
    const contents = requests[1].messages.map((m) => m.content);
    expect(contents).toContain("put on some jazz");
    expect(contents.some((c) => typeof c === "string" && c!.includes("play_music"))).toBe(true);
  });

  it("resetConversation forgets history", async () => {
    const { client, requests } = fakeClient(() => textResponse("ok"));
    const mod = new LlmModule({ client: client as any });
    await mod.ask("one", "room");
    mod.resetConversation("room");
    await mod.ask("two", "room");
    // Post-reset request has no carried history.
    expect(requests[1].messages.map((m) => m.role)).toEqual(["system", "user"]);
  });
});
