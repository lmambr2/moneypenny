import { afterEach, describe, expect, it, vi } from "vitest";
import { LLM_PENNY_KEEP_ALIVE, LlmClient, normalizeLlmBaseUrl } from "./client.js";

describe("normalizeLlmBaseUrl", () => {
  it("strips trailing slash and /v1 so OpenAI base URLs do not double", () => {
    expect(normalizeLlmBaseUrl("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080");
    expect(normalizeLlmBaseUrl("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080");
    expect(normalizeLlmBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeLlmBaseUrl("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
  });
});

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
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.options).toEqual({ num_ctx: 8192, flash_attention: true });
  });

  it("POSTs /v1/chat/completions with Qwen thinking disabled", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "x",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "hi" },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const c = new LlmClient({ baseUrl: "http://127.0.0.1:8080/v1", model: "Qwen3.8" });
    const out = await c.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(out.choices[0].message.content).toBe("hi");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("Qwen3.8");
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
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
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://penny.example/api/generate");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "gemma-test", keep_alive: 0, stream: false });
  });
});
