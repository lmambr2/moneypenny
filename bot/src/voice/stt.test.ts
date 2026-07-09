import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SherpaSttClient } from "./stt.js";

vi.mock("axios", () => ({
  default: {
    post: vi.fn(),
    delete: vi.fn(),
    isAxiosError: (err: unknown) =>
      typeof err === "object" &&
      err !== null &&
      (err as { isAxiosError?: boolean }).isAxiosError === true,
  },
}));

describe("SherpaSttClient", () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
    vi.mocked(axios.delete).mockReset();
  });

  it("feedStream parses partial/final/speaking from /asr/stream", async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { partial: "money", final: null, speaking: true },
    });
    const client = new SherpaSttClient({ url: "http://stt:9000" });
    const out = await client.feedStream(7, Buffer.from([1, 2]), 48_000, 1);
    expect(out).toEqual({
      partial: "money",
      final: null,
      speaking: true,
      keyword: null,
      listening: undefined,
      commandFinal: false,
    });
    expect(axios.post).toHaveBeenCalledWith(
      "http://stt:9000/asr/stream",
      expect.any(Buffer),
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Client-Id": "7" }),
      }),
    );
  });

  it("feedStream returns empty result on HTTP failure", async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error("down"));
    const client = new SherpaSttClient({ url: "http://stt:9000" });
    const out = await client.feedStream(1, Buffer.alloc(4), 48_000, 1);
    expect(out).toEqual({ partial: "", final: null, speaking: false, error: "down" });
  });
});
