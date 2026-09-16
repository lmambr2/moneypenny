import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLlmCatalog, parseLlmOrigin } from "./catalog.js";

describe("parseLlmOrigin", () => {
  it("accepts http origins and strips /v1", () => {
    expect(parseLlmOrigin("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080");
    expect(parseLlmOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  });

  it("rejects non-http and credentials", () => {
    expect(parseLlmOrigin("file:///etc/passwd")).toBeNull();
    expect(parseLlmOrigin("http://user:pw@127.0.0.1:8080")).toBeNull();
    expect(parseLlmOrigin("not a url")).toBeNull();
  });
});

describe("fetchLlmCatalog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses OpenAI /v1/models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/v1/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "Qwen3.8",
                  owned_by: "vllm",
                  max_model_len: 32768,
                  root: "/models/Qwen3.8-27B-MXFP4-mtpfp8",
                },
                { id: "Qwen3.6", owned_by: "vllm", max_model_len: 32768 },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("no", { status: 404 });
      }),
    );
    const cat = await fetchLlmCatalog("http://127.0.0.1:8080/v1");
    expect(cat.available).toBe(true);
    expect(cat.url).toBe("http://127.0.0.1:8080");
    expect(cat.models.map((m) => m.id)).toEqual(["Qwen3.6", "Qwen3.8"]);
    expect(cat.models[1]?.maxModelLen).toBe(32768);
  });

  it("falls back to Ollama /api/tags", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/v1/models")) return new Response("no", { status: 404 });
        if (String(url).endsWith("/api/tags")) {
          return new Response(JSON.stringify({ models: [{ name: "gemma4:12b" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("no", { status: 404 });
      }),
    );
    const cat = await fetchLlmCatalog("http://127.0.0.1:11434");
    expect(cat.available).toBe(true);
    expect(cat.models).toEqual([{ id: "gemma4:12b", ownedBy: "ollama" }]);
  });
});
