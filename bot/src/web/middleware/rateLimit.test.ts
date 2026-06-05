import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createRateLimit } from "./rateLimit.js";

describe("createRateLimit", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    // capacity=3, refill=1/sec → first 3 succeed, then 429 until refill.
    app.use(createRateLimit({ capacity: 3, refillPerSec: 1 }));
    app.get("/", (_req, res) => res.json({ ok: true }));
  });

  it("allows up to capacity bursts then rejects with 429", async () => {
    expect((await request(app).get("/")).status).toBe(200);
    expect((await request(app).get("/")).status).toBe(200);
    expect((await request(app).get("/")).status).toBe(200);
    const denied = await request(app).get("/");
    expect(denied.status).toBe(429);
    expect(denied.body).toEqual({ error: "rate limit exceeded" });
    expect(denied.headers["retry-after"]).toBeDefined();
  });

  it("uses per-key buckets when keyFn is provided", async () => {
    const customApp = express();
    customApp.use(
      createRateLimit({
        capacity: 1,
        refillPerSec: 0.001,
        keyFn: (req) => req.get("x-user") ?? "anon",
      })
    );
    customApp.get("/", (_req, res) => res.json({ ok: true }));
    expect((await request(customApp).get("/").set("X-User", "alice")).status).toBe(200);
    expect((await request(customApp).get("/").set("X-User", "alice")).status).toBe(429);
    // Different user, separate bucket → still has a token.
    expect((await request(customApp).get("/").set("X-User", "bob")).status).toBe(200);
  });
});
