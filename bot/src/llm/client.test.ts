import { afterEach, describe, expect, it, vi } from "vitest";
import { LLM_PENNY_KEEP_ALIVE, LlmClient } from "./client.js";

describe("LlmClient payload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends keep_alive 24h, optional think/num_ctx, and stream false by default", async () => {
    let captured: string | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      captured = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          id: "x",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new LlmClient({ baseUrl: "http://penny.example", timeoutMs: 5_000 });
    await client.chat({
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "none",
      think: false,
      numCtx: 8192,
      flashAttention: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(captured).toBeTruthy();
    const body = JSON.parse(captured!);
    expect(body.stream).toBe(false);
    expect(body.keep_alive).toBe(LLM_PENNY_KEEP_ALIVE);
    expect(body.think).toBe(false);
    expect(body.options).toEqual({ num_ctx: 8192, flash_attention: true });
  });

  it("unload posts Ollama keep_alive 0", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new LlmClient({
      baseUrl: "http://penny.example",
      model: "gemma-test",
      timeoutMs: 5_000,
    });
    await client.unload();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://penny.example/api/generate");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "gemma-test", keep_alive: 0, stream: false });
  });
});
