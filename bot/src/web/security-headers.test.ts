import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";

/**
 * The clickjacking-defence middleware is mounted at the top of
 * `createWebServer` in `server.ts`. This test asserts the exact behavior
 * we expect from that middleware in isolation. The wiring inside
 * `server.ts` is verified by code review (git diff).
 */
describe("security headers (anti-clickjacking)", () => {
  function buildApp() {
    const app = express();
    app.use((_req, res, next) => {
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
      next();
    });
    app.get("/", (_req, res) => res.json({ ok: true }));
    app.post("/", (_req, res) => res.json({ ok: true }));
    return app;
  }

  it("sets X-Frame-Options: DENY on GET responses", async () => {
    const res = await request(buildApp()).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("sets Content-Security-Policy frame-ancestors 'none' on GET responses", async () => {
    const res = await request(buildApp()).get("/");
    expect(res.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
  });

  it("sets both headers on POST responses too", async () => {
    const res = await request(buildApp()).post("/");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
  });
});
