import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuplexClient, KIND_TEXT } from "./duplex.js";
import { TALKER_VRAM_IDLE_MB } from "./duplex-watch.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../");
const SERVER = join(ROOT, "services/personaplex/server.py");

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      s.close((err) => {
        if (err) reject(err);
        else resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
    s.on("error", reject);
  });
}

describe("DuplexClient vs personaplex-mock", () => {
  let proc: ChildProcess | undefined;
  let client: DuplexClient;
  let port = 0;

  beforeAll(async () => {
    port = await freePort();
    proc = spawn("python3", [SERVER], {
      env: { ...process.env, PORT: String(port), MOCK_LOADED: "1", MOCK_RTF: "0.5" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    client = new DuplexClient(`http://127.0.0.1:${port}`);
    const deadline = Date.now() + 8000;
    let last = "";
    while (Date.now() < deadline) {
      const h = await client.health();
      if (h.ok) return;
      last = JSON.stringify(h);
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`mock did not start: ${last}`);
  });

  afterAll(() => {
    proc?.kill("SIGTERM");
  });

  it("health is mock engine with Talker-only vram_mb", async () => {
    const h = await client.health();
    expect(h.ok).toBe(true);
    expect(h.engine).toBe("mock");
    expect(h.loaded).toBe(true);
    expect(h.realtime).toBe(true);
    expect(h.vram_mb).toBeGreaterThan(0);
    expect(h.sample_rate).toBe(24000);
  });

  it("unload drops weights; warm restores fake working set", async () => {
    const down = await client.unload();
    expect(down.ok).toBe(true);
    expect(down.loaded).toBe(false);
    expect(down.realtime).toBe(false);
    expect(down.vram_mb ?? 0).toBeLessThanOrEqual(TALKER_VRAM_IDLE_MB);

    const waited = await client.waitUnloaded(2000);
    expect(waited.loaded).toBe(false);

    const up = await client.warm();
    expect(up.loaded).toBe(true);
    expect(up.ok).toBe(true);
    expect(up.vram_mb).toBeGreaterThan(0);
  });

  it("PCM round-trip: 0x02 is agent caption, never user bytes", async () => {
    await client.warm();
    const captions: string[] = [];
    const pcmOut: Buffer[] = [];
    const sess = client.connectPcm({
      onAgentText: (t) => captions.push(t),
      onPcm: (p) => pcmOut.push(p),
    });
    await sess.waitOpen();
    const user = Buffer.alloc(64, 7);
    sess.sendPcm(user);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && (captions.length === 0 || pcmOut.length === 0)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    sess.close();
    expect(pcmOut.length).toBeGreaterThan(0);
    expect(captions).toContain("mock-agent");
    expect(captions.some((c) => c.includes("skip") || c.includes("play"))).toBe(false);
    expect(KIND_TEXT).toBe(0x02);
  });

  it("unreachable adapter is ok=false", async () => {
    const dead = new DuplexClient("http://127.0.0.1:1");
    const h = await dead.health(400);
    expect(h.ok).toBe(false);
  });
});
