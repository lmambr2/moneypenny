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
