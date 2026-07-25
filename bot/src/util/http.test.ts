import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBuffer, fetchJson, HttpRequestError, isHttpRequestError } from "./http.js";

describe("util/http", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchJson returns parsed JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const data = await fetchJson<{ ok: boolean }>("http://x/health");
    expect(data).toEqual({ ok: true });
  });

  it("fetchJson throws HttpRequestError with status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503, statusText: "Unavailable" })),
    );
    await expect(fetchJson("http://x/fail")).rejects.toMatchObject({
      name: "HttpRequestError",
      status: 503,
    });
  });

  it("fetchBuffer returns bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    );
    const buf = await fetchBuffer("http://x/bin");
    expect(buf.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it("isHttpRequestError narrows", () => {
    expect(isHttpRequestError(new HttpRequestError("x", { status: 400 }))).toBe(true);
    expect(isHttpRequestError(new Error("x"))).toBe(false);
  });
});
