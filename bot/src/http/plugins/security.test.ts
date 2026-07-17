import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { securityHeadersMiddleware } from "./security.js";

/**
 * Clickjacking-defence middleware (mounted by registerSecurity in http/app).
 */
describe("security headers (anti-clickjacking)", () => {
  function buildApp() {
    const app = express();
    app.use(securityHeadersMiddleware);
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
