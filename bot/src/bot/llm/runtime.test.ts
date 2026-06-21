import { describe, it, expect, vi } from "vitest";
import { LlmRuntime } from "./runtime.js";

describe("LlmRuntime", () => {
  it("buildRetrieveHook is undefined when rag and memory are both off", () => {
    const runtime = new LlmRuntime({
      config: { ragEnabled: false, memoryEnabled: false } as any,
      logger: { info: vi.fn() } as any,
      memoryStore: { recall: vi.fn() } as any,
      getMemPalace: () => null,
      getRetrieval: () => undefined,
      getRightsEngine: () => null,
      onModuleChange: vi.fn(),
    });
    expect(runtime.buildRetrieveHook()).toBeUndefined();
  });

  it("retrieve hook merges MemPalace hits with non-duplicate SQLite facts", async () => {
    const search = vi.fn().mockResolvedValue([{ fact: "likes tea", score: 1.2 }]);
    const recall = vi.fn().mockReturnValue([
      { fact: "likes tea" },
      { fact: "hates coffee" },
    ]);
    const runtime = new LlmRuntime({
      config: { ragEnabled: false, memoryEnabled: true, mempalaceEnabled: true } as any,
      logger: { info: vi.fn() } as any,
      memoryStore: { recall } as any,
      getMemPalace: () => ({ search } as any),
      getRetrieval: () => undefined,
      getRightsEngine: () => null,
      onModuleChange: vi.fn(),
    });
    const hook = runtime.buildRetrieveHook()!;
    const out = await hook("beverages", { userUid: "u1" });
    expect(search).toHaveBeenCalledWith("u1", "beverages", 8);
    expect(out).toHaveLength(2);
    expect(out[0].source).toBe("your memory (MemPalace)");
    expect(out[1].text).toBe("hates coffee");
  });

  it("retrieve hook merges doctrine chunks and memory facts", async () => {
    const query = vi.fn().mockResolvedValue([{ text: "doc", source: "sop.md", score: 0.9 }]);
    const recall = vi.fn().mockReturnValue([{ fact: "likes tea" }]);
    const runtime = new LlmRuntime({
      config: { ragEnabled: true, memoryEnabled: true, ragTopK: 3 } as any,
      logger: { info: vi.fn() } as any,
      memoryStore: { recall } as any,
      getMemPalace: () => null,
      getRetrieval: () => ({ query } as any),
      getRightsEngine: () => null,
      onModuleChange: vi.fn(),
    });
    const hook = runtime.buildRetrieveHook()!;
    const out = await hook("question", { userUid: "u1", allowedClassifications: ["secret"] });
    expect(query).toHaveBeenCalledWith("question", 3, ["secret"]);
    expect(recall).toHaveBeenCalledWith("u1", 10);
    expect(out).toHaveLength(2);
    expect(out[1].source).toBe("your memory");
  });
});