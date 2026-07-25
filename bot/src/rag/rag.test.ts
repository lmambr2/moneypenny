import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpRequestError } from "../util/http.js";
import { EmbeddingsClient } from "./embeddings.js";
import { RetrievalStore } from "./index.js";
import { l2Normalize } from "./normalize.js";
import { VectorClient } from "./vector-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("EmbeddingsClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs /v1/embeddings and returns vectors in input order", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toContain("/v1/embeddings");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "nomic-embed-text-v2-moe", input: ["a", "b"] });
      return jsonResponse({
        data: [
          { embedding: [4, 5, 6], index: 1 },
          { embedding: [1, 2, 3], index: 0 },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const c = new EmbeddingsClient({
      baseUrl: "http://ollama:11434",
      model: "nomic-embed-text-v2-moe",
    });
    const vecs = await c.embed(["a", "b"]);
    expect(vecs[0].map((x) => +x.toFixed(8))).toEqual(
      l2Normalize([1, 2, 3]).map((x) => +x.toFixed(8)),
    );
    expect(vecs[1].map((x) => +x.toFixed(8))).toEqual(
      l2Normalize([4, 5, 6]).map((x) => +x.toFixed(8)),
    );
  });

  it("probes dimension once and caches it", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: [{ embedding: [0, 0, 0, 0], index: 0 }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const c = new EmbeddingsClient({ baseUrl: "http://ollama:11434" });
    expect(await c.dimension()).toBe(4);
    expect(await c.dimension()).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("VectorClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates the collection when absent (404 → PUT with size+Cosine)", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(init?.method ?? "GET").toUpperCase() === "PUT") {
        expect(String(url)).toContain("/collections/docs");
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({ vectors: { size: 768, distance: "Cosine" } });
        return jsonResponse({});
      }
      return new Response("missing", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const q = new VectorClient({ baseUrl: "http://turbovec:6333" });
    await q.ensureCollection("docs", 768);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("does not recreate an existing collection", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ result: { config: { params: { vectors: { size: 768 } } } } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const q = new VectorClient({ baseUrl: "http://turbovec:6333" });
    await q.ensureCollection("docs", 768);
    const puts = (fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>).filter(
      (c) => String(c[1]?.method ?? "GET").toUpperCase() === "PUT",
    );
    expect(puts).toHaveLength(0);
  });

  it("searches with limit + payload and returns hits", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toContain("/collections/docs/points/search");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ vector: [1, 2, 3], limit: 4, with_payload: true });
      return jsonResponse({ result: [{ id: "x", score: 0.9, payload: { text: "t" } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const q = new VectorClient({ baseUrl: "http://turbovec:6333" });
    const hits = await q.search("docs", [1, 2, 3], 4);
    expect(hits[0]).toMatchObject({ id: "x", score: 0.9 });
  });

  it("surfaces 404 via HttpRequestError status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 404 })),
    );
    const q = new VectorClient({ baseUrl: "http://turbovec:6333" });
    await expect(q.search("docs", [1], 1)).rejects.toBeInstanceOf(HttpRequestError);
  });
});

describe("RetrievalStore", () => {
  function makeStore() {
    const embeddings = {
      dimension: vi.fn().mockResolvedValue(3),
      embed: vi.fn(),
      getModel: vi.fn().mockReturnValue("embeddinggemma"),
    };
    const vectorStore = {
      ensureCollection: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
      deleteBySource: vi.fn().mockResolvedValue(undefined),
      search: vi.fn(),
    };
    const store = new RetrievalStore({
      embeddings: embeddings as any,
      vectorStore: vectorStore as any,
      collection: "docs",
      topK: 2,
    });
    return { store, embeddings, vectorStore };
  }

  it("init probes dim and ensures the collection once", async () => {
    const { store, embeddings, vectorStore } = makeStore();
    await store.init();
    await store.init();
    expect(embeddings.dimension).toHaveBeenCalledTimes(1);
    expect(vectorStore.ensureCollection).toHaveBeenCalledWith("docs", 3);
  });

  it("ingest chunks → embeds → purges source → upserts", async () => {
    const { store, embeddings, vectorStore } = makeStore();
    embeddings.embed.mockResolvedValue([[1, 1, 1]]);
    const n = await store.ingest("doc.md", "# H\nsome body text", { classification: "unclass" });
    expect(n).toBe(1);
    expect(vectorStore.deleteBySource).toHaveBeenCalledWith("docs", "doc.md");
    const [, points] = vectorStore.upsert.mock.calls[0];
    expect(points[0]).toMatchObject({ vector: [1, 1, 1] });
    expect(points[0].payload).toMatchObject({ source: "doc.md", classification: "unclass" });
  });

  it("ingest batches large docs so ollama is not sent 100+ texts at once", async () => {
    const { store, embeddings, vectorStore } = makeStore();
    embeddings.embed.mockImplementation(async (input: string | string[]) => {
      const texts = Array.isArray(input) ? input : [input];
      return texts.map(() => [1, 1, 1]);
    });
    const body = Array.from(
      { length: 20 },
      (_, i) => `## Section ${i}\n${"word ".repeat(200)}`,
    ).join("\n\n");
    const n = await store.ingest("big.md", body);
    expect(n).toBeGreaterThan(8);
    expect(embeddings.embed.mock.calls.length).toBeGreaterThan(1);
    expect(vectorStore.upsert).toHaveBeenCalled();
  });

  it("query embeds the question and maps hits to chunks", async () => {
    const { store, embeddings, vectorStore } = makeStore();
    embeddings.embed.mockResolvedValue([[9, 9, 9]]);
    vectorStore.search.mockResolvedValue([
      {
        id: "a",
        score: 0.8,
        payload: { text: "answer", source: "doc.md", classification: "unclassified" },
      },
    ]);
    const out = await store.query("what is the answer?");
    expect(vectorStore.search).toHaveBeenCalledWith("docs", [9, 9, 9], 8, undefined);
    expect(out).toEqual([
      { text: "answer", source: "doc.md", score: 0.8, classification: "unclassified" },
    ]);
  });

  it("query passes a classification filter when allowedClassifications is given", async () => {
    const { store, embeddings, vectorStore } = makeStore();
    embeddings.embed.mockResolvedValue([[1, 2, 3]]);
    vectorStore.search.mockResolvedValue([]);
    await store.query("q", 4, ["unclassified", "restricted"]);
    expect(vectorStore.search).toHaveBeenCalledWith("docs", [1, 2, 3], 16, {
      must: [{ key: "classification", match: { any: ["unclassified", "restricted"] } }],
    });
  });

  it("query returns [] (never throws) when retrieval fails", async () => {
    const { store, embeddings } = makeStore();
    embeddings.embed.mockRejectedValue(new Error("ollama down"));
    expect(await store.query("x")).toEqual([]);
  });

  it("query drops chunks past valid_until", async () => {
    const { store, embeddings, vectorStore } = makeStore();
    embeddings.embed.mockResolvedValue([[1, 0, 0]]);
    vectorStore.search.mockResolvedValue([
      {
        id: "fresh",
        score: 0.9,
        payload: {
          text: "current",
          source: "a.md",
          classification: "unclassified",
          valid_until: "2099-01-01",
        },
      },
      {
        id: "stale",
        score: 0.95,
        payload: {
          text: "old",
          source: "b.md",
          classification: "unclassified",
          valid_until: "2000-01-01",
        },
      },
    ]);
    const out = await store.query("q");
    expect(out.map((c) => c.text)).toEqual(["current"]);
  });
});
