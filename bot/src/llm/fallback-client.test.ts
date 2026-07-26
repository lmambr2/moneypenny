import { describe, expect, it, vi } from "vitest";
import { HttpRequestError } from "../util/http.js";
import type { ChatCompletionResponse } from "./client.js";
import { FallbackLlmClient, isRetryableLlmError } from "./fallback-client.js";

function okResp(text: string): ChatCompletionResponse {
  return {
    id: "x",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  };
}

describe("isRetryableLlmError", () => {
  it("treats connection refused as retryable", () => {
    expect(isRetryableLlmError(new Error("ECONNREFUSED"))).toBe(true);
    expect(
      isRetryableLlmError(new HttpRequestError("fetch failed", { cause: new Error("x") })),
    ).toBe(true);
  });
  it("treats 4xx app errors as non-retryable", () => {
    expect(isRetryableLlmError(new HttpRequestError("HTTP 400", { status: 400 }))).toBe(false);
  });
  it("treats 503 as retryable", () => {
    expect(isRetryableLlmError(new HttpRequestError("HTTP 503", { status: 503 }))).toBe(true);
  });
});

describe("FallbackLlmClient", () => {
  it("uses primary when it succeeds", async () => {
    const primary = { chat: vi.fn(async () => okResp("primary")) };
    const fallback = { chat: vi.fn(async () => okResp("fallback")) };
    const client = new FallbackLlmClient({
      primary: { baseUrl: "http://primary" },
      fallbackUrl: "http://fallback",
    });
    (client as any).primary = primary;
    (client as any).fallback = fallback;

    const out = await client.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(out.choices[0].message.content).toBe("primary");
    expect(fallback.chat).not.toHaveBeenCalled();
  });

  it("falls back on retryable primary failure", async () => {
    const primary = {
      chat: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    };
    const fallback = { chat: vi.fn(async () => okResp("fallback")) };
    const client = new FallbackLlmClient({
      primary: { baseUrl: "http://primary" },
      fallbackUrl: "http://fallback",
    });
    (client as any).primary = primary;
    (client as any).fallback = fallback;

    const out = await client.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(out.choices[0].message.content).toBe("fallback");
    expect(client.usedFallbackLast()).toBe(true);
  });
});

/**
 * Ground truth for /api/health. A silent downgrade to the fallback is the
 * failure this exists to surface: when the LAN host slept, every LLM-backed
 * feature quietly ran on a model a fifth the size and nothing reported it.
 */
describe("FallbackLlmClient route tracking", () => {
  const build = (primary: unknown, fallback?: unknown) => {
    const client = new FallbackLlmClient({
      primary: { baseUrl: "http://primary" },
      fallbackUrl: "http://fallback",
    });
    (client as any).primary = primary;
    (client as any).fallback = fallback;
    return client;
  };

  it("reports no route before any completion", () => {
    const client = build({ chat: vi.fn() }, { chat: vi.fn() });
    expect(client.getLastRoute()).toEqual({ route: "none", at: 0 });
  });

  it("records the primary when it serves", async () => {
    const client = build({ chat: vi.fn(async () => okResp("primary")) }, { chat: vi.fn() });
    await client.chat({ messages: [{ role: "user", content: "hi" }] });
    const r = client.getLastRoute();
    expect(r.route).toBe("primary");
    expect(r.at).toBeGreaterThan(0);
  });

  it("records the fallback when the primary is down", async () => {
    const client = build(
      {
        chat: vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      },
      { chat: vi.fn(async () => okResp("fallback")) },
    );
    await client.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(client.getLastRoute().route).toBe("fallback");
  });

  it("returns to primary once it recovers", async () => {
    let down = true;
    const client = build(
      {
        chat: vi.fn(async () => {
          if (down) throw new Error("ECONNREFUSED");
          return okResp("primary");
        }),
      },
      { chat: vi.fn(async () => okResp("fallback")) },
    );
    await client.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(client.getLastRoute().route).toBe("fallback");
    down = false;
    await client.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(client.getLastRoute().route).toBe("primary");
  });

  // A non-retryable failure means nothing served the request, so the route
  // must not be advanced to imply a success that did not happen.
  it("leaves the route unchanged when the call throws outright", async () => {
    const client = build(
      {
        chat: vi.fn(async () => {
          throw new Error("400 bad request");
        }),
      },
      { chat: vi.fn() },
    );
    await expect(client.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow();
    expect(client.getLastRoute().route).toBe("none");
  });

  it("hands back a copy so callers cannot mutate internal state", async () => {
    const client = build({ chat: vi.fn(async () => okResp("primary")) }, { chat: vi.fn() });
    await client.chat({ messages: [{ role: "user", content: "hi" }] });
    const r = client.getLastRoute();
    r.route = "none";
    expect(client.getLastRoute().route).toBe("primary");
  });
});
