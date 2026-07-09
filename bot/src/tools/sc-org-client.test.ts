import { describe, expect, it, vi } from "vitest";
import {
  formatScOrgStatusLine,
  parseStatusPayload,
  ScOrgClient,
} from "./sc-org-client.js";
import {
  createStarCitizenOrgStatusPlugin,
  ExternalStatusRegistry,
} from "./external-status.js";

describe("ScOrgClient (G2 depth)", () => {
  it("parses status payload flexibly", () => {
    const st = parseStatusPayload(
      { state: "standing-by", online: 3, summary: "ops quiet", org: "RSI" },
      "org",
    );
    expect(st.status).toBe("standing-by");
    expect(st.membersOnline).toBe(3);
    expect(formatScOrgStatusLine(st)).toMatch(/RSI.*standing-by.*3 online/);
  });

  it("fetches status + members via injectable fetch", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/status")) {
        return {
          ok: true,
          json: async () => ({
            status: "active",
            membersOnline: 2,
            summary: "mining ops",
            org: "Aegis",
          }),
        };
      }
      if (url.endsWith("/members")) {
        return {
          ok: true,
          json: async () => ({
            members: [
              { name: "Alice", online: true, rank: "FC" },
              { name: "Bob", online: false },
            ],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const client = new ScOrgClient({
      baseUrl: "http://sc-bridge:9100",
      fetchImpl: fetchImpl as any,
    });
    const brief = await client.formatBrief();
    expect(brief).toMatch(/Aegis/);
    expect(brief).toMatch(/mining ops/);
    expect(brief).toMatch(/Alice/);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("plugin uses client and fail-opens on network error", async () => {
    const reg = new ExternalStatusRegistry({ cacheTtlMs: 0 });
    reg.register(
      createStarCitizenOrgStatusPlugin({
        baseUrl: "http://sc-bridge:9100",
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    );
    const r = await reg.get("sc-org");
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/unavailable|ECONNREFUSED/i);
  });

  it("plugin succeeds with full status contract", async () => {
    const reg = new ExternalStatusRegistry({ cacheTtlMs: 0 });
    reg.register(
      createStarCitizenOrgStatusPlugin({
        baseUrl: "http://sc-bridge:9100",
        orgName: "TestOrg",
        fetchImpl: (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith("/status")) {
            return {
              ok: true,
              json: async () => ({ status: "green", membersOnline: 4, summary: "fleet up" }),
            } as Response;
          }
          if (url.endsWith("/members")) {
            return {
              ok: true,
              json: async () => ({ members: [{ name: "Zed", online: true }] }),
            } as Response;
          }
          return { ok: false, status: 404, json: async () => ({}) } as Response;
        }) as typeof fetch,
      }),
    );
    const r = await reg.get("sc-org");
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/green|fleet up|Zed/i);
  });
});
