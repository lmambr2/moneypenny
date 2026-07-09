import { describe, it, expect, vi } from "vitest";
import { AceStepClient } from "./ace-step-client.js";
import type { AxiosInstance } from "axios";

function mockHttp(handlers: {
  get?: (url: string) => { status: number; data: unknown };
  post?: (url: string, body: unknown) => { status: number; data: unknown };
}): AxiosInstance {
  return {
    get: vi.fn(async (url: string) => handlers.get?.(url) ?? { status: 404, data: {} }),
    post: vi.fn(async (url: string, body: unknown) => handlers.post?.(url, body) ?? { status: 404, data: {} }),
  } as unknown as AxiosInstance;
}

describe("AceStepClient", () => {
  it("health returns ok when sidecar is up", async () => {
    const client = new AceStepClient({
      url: "http://ace:7865",
      http: mockHttp({
        get: (u) =>
          u === "/health"
            ? { status: 200, data: { ok: true, engine: "ace-step", busy: false } }
            : { status: 404, data: {} },
      }),
    });
    expect(await client.health()).toEqual({ ok: true, engine: "ace-step", busy: false });
    expect(await client.isAvailable()).toBe(true);
  });

  it("health fails closed on network/HTTP errors", async () => {
    const client = new AceStepClient({
      url: "http://ace:7865",
      http: mockHttp({ get: () => { throw new Error("ECONNREFUSED"); } }),
    });
    const h = await client.health();
    expect(h.ok).toBe(false);
    expect(h.error).toMatch(/ECONNREFUSED/);
  });

  it("generate posts prompt and returns job id", async () => {
    const post = vi.fn((_u: string, body: unknown) => {
      expect((body as { prompt: string }).prompt).toBe("focus ambient 110bpm");
      return { status: 200, data: { id: "job-1", status: "queued" } };
    });
    const client = new AceStepClient({
      url: "http://ace:7865",
      http: mockHttp({ post: (u, b) => post(u, b) }),
    });
    const job = await client.generate({ prompt: "focus ambient 110bpm", durationSec: 90 });
    expect(job).toEqual({ id: "job-1", status: "queued", path: null, error: null, progress: undefined });
    expect(post).toHaveBeenCalled();
  });

  it("generate rejects empty prompt", async () => {
    const client = new AceStepClient({ url: "http://ace:7865", http: mockHttp({}) });
    await expect(client.generate({ prompt: "  " })).rejects.toThrow(/prompt/i);
  });

  it("waitForJob polls until done", async () => {
    let n = 0;
    const client = new AceStepClient({
      url: "http://ace:7865",
      http: mockHttp({
        get: (u) => {
          if (!u.startsWith("/v1/jobs/")) return { status: 404, data: {} };
          n += 1;
          if (n < 3) return { status: 200, data: { id: "j", status: "running" } };
          return {
            status: 200,
            data: { id: "j", status: "done", path: "generated/ace-step/x.mp3" },
          };
        },
      }),
    });
    const job = await client.waitForJob("j", { pollMs: 1, maxWaitMs: 500 });
    expect(job.status).toBe("done");
    expect(job.path).toContain("generated/ace-step");
    expect(n).toBeGreaterThanOrEqual(3);
  });
});
