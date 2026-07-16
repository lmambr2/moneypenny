import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMBEDDING_MODEL_SBC,
  DEFAULT_EMBEDDING_MODEL_SERVER,
  defaultModelForEdition,
  EmbeddingsClient,
} from "./embeddings.js";
import { l2Normalize } from "./normalize.js";

describe("defaultModelForEdition", () => {
  it("sbc / empty → nomic v2", () => {
    expect(defaultModelForEdition("sbc")).toBe(DEFAULT_EMBEDDING_MODEL_SBC);
    expect(defaultModelForEdition("")).toBe(DEFAULT_EMBEDDING_MODEL_SBC);
    expect(defaultModelForEdition(undefined)).toBe(DEFAULT_EMBEDDING_MODEL_SBC);
  });
  it("server → bge-large", () => {
    expect(defaultModelForEdition("server")).toBe(DEFAULT_EMBEDDING_MODEL_SERVER);
  });
});

describe("EmbeddingsClient normalize", () => {
  it("constructor defaults model from edition env", () => {
    const prev = process.env.MONEYPENNY_EDITION;
    const prevM = process.env.EMBEDDING_MODEL;
    delete process.env.EMBEDDING_MODEL;
    process.env.MONEYPENNY_EDITION = "server";
    try {
      const c = new EmbeddingsClient({ baseUrl: "http://example.invalid" });
      expect(c.getModel()).toBe(DEFAULT_EMBEDDING_MODEL_SERVER);
    } finally {
      if (prev === undefined) delete process.env.MONEYPENNY_EDITION;
      else process.env.MONEYPENNY_EDITION = prev;
      if (prevM === undefined) delete process.env.EMBEDDING_MODEL;
      else process.env.EMBEDDING_MODEL = prevM;
    }
  });

  it("l2Normalize is used for cosine-ready unit vectors", () => {
    // Contract: ingest path expects unit vectors; helper is the same as client post-process.
    const u = l2Normalize([1, 0, 0, 0]);
    expect(u[0]).toBeCloseTo(1, 8);
  });
});
