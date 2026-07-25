import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpSttClient } from "./stt.js";

describe("HttpSttClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("feedStream parses partial/final/speaking from /asr/stream", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ partial: "money", final: null, speaking: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpSttClient({ url: "http://stt:9000" });
    const out = await client.feedStream(7, Buffer.from([1, 2]), 48_000, 1);
    expect(out).toEqual({
      partial: "money",
      final: null,
      speaking: true,
      keyword: null,
      listening: undefined,
      commandFinal: false,
      commandSource: undefined,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://stt:9000/asr/stream",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Client-Id": "7" }),
      }),
    );
  });

  it("feedStream returns empty result on HTTP failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    const client = new HttpSttClient({ url: "http://stt:9000" });
    const out = await client.feedStream(1, Buffer.alloc(4), 48_000, 1);
    expect(out).toEqual({ partial: "", final: null, speaking: false, error: "down" });
  });
});
