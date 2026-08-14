import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse } from "./client.js";
import { DelegateClient } from "./delegate.js";

function okResp(text: string): ChatCompletionResponse {
  return {
    id: "x",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  };
}

const MSGS = [{ role: "user" as const, content: "analyse this" }];

describe("DelegateClient heavy-model degradation", () => {
  it("uses the heavy model when it succeeds and reports not degraded", async () => {
    const heavy = { chat: vi.fn(async () => okResp("heavy")) };
    const light = { chat: vi.fn(async () => okResp("light")) };
    const c = new DelegateClient({
      baseUrl: "http://llm",
      model: "big",
      fallbackModel: "small",
    });
    (c as any).inner = heavy;
    (c as any).lighter = light;

    expect(await c.complete(MSGS)).toBe("heavy");
    expect(light.chat).not.toHaveBeenCalled();
    expect(c.isDegraded()).toBe(false);
  });

  it("degrades to the lighter model when the heavy one cannot be served", async () => {
    // The real-world trigger: a 31B needs ~18.5GB, so a game holding VRAM makes
    // it unloadable while the ~7GB chat model still fits.
    const heavy = {
      chat: vi.fn(async () => {
        throw new Error("model requires more system memory than is available");
      }),
    };
    const light = { chat: vi.fn(async () => okResp("light")) };
    const c = new DelegateClient({
      baseUrl: "http://llm",
      model: "big",
      fallbackModel: "small",
    });
    (c as any).inner = heavy;
    (c as any).lighter = light;

    expect(await c.complete(MSGS)).toBe("light");
    expect(light.chat).toHaveBeenCalledTimes(1);
    expect(c.isDegraded()).toBe(true);
  });

  it("resets the degraded flag once the heavy model recovers", async () => {
    let fail = true;
    const heavy = {
      chat: vi.fn(async () => {
        if (fail) throw new Error("out of memory");
        return okResp("heavy");
      }),
    };
    const light = { chat: vi.fn(async () => okResp("light")) };
    const c = new DelegateClient({ baseUrl: "http://llm", model: "big", fallbackModel: "small" });
    (c as any).inner = heavy;
    (c as any).lighter = light;

    await c.complete(MSGS);
    expect(c.isDegraded()).toBe(true);
    fail = false;
    expect(await c.complete(MSGS)).toBe("heavy");
    expect(c.isDegraded()).toBe(false);
  });

  it("rethrows when no fallback model is configured", async () => {
    const heavy = {
      chat: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const c = new DelegateClient({ baseUrl: "http://llm", model: "big" });
    (c as any).inner = heavy;

    await expect(c.complete(MSGS)).rejects.toThrow("boom");
  });

  it("does not build a fallback client when it would duplicate the heavy model", async () => {
    // Same model on the same endpoint cannot succeed where the first attempt
    // failed — building it would just double every failure's latency.
    const c = new DelegateClient({
      baseUrl: "http://llm",
      model: "same",
      fallbackModel: " same ",
    });
    expect((c as any).lighter).toBeUndefined();
  });
});
