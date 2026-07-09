import axios from "axios";
import { describe, expect, it, vi } from "vitest";
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
    expect(isRetryableLlmError(new axios.AxiosError("x", "ECONNREFUSED"))).toBe(true);
  });
  it("treats 4xx app errors as non-retryable", () => {
    const err = new axios.AxiosError("bad", "ERR_BAD_REQUEST", undefined, undefined, {
      status: 400,
      statusText: "Bad Request",
      headers: {},
      config: {} as any,
      data: {},
    });
    expect(isRetryableLlmError(err)).toBe(false);
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
        throw new axios.AxiosError("down", "ECONNREFUSED");
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
