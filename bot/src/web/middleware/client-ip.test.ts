import { describe, expect, it } from "vitest";
import { resolveClientIp } from "./client-ip.js";

function fakeReq(opts: {
  remoteAddress?: string;
  ip?: string;
  xff?: string | string[];
}): import("express").Request {
  return {
    socket: { remoteAddress: opts.remoteAddress },
    ip: opts.ip,
    headers: opts.xff != null ? { "x-forwarded-for": opts.xff } : {},
  } as import("express").Request;
}

describe("resolveClientIp (trustProxy hops)", () => {
  it("ignores XFF when trustProxy is false", () => {
    const ip = resolveClientIp(fakeReq({ remoteAddress: "10.0.0.5", xff: "1.2.3.4, 10.0.0.5" }), {
      trustProxy: false,
    });
    expect(ip).toBe("10.0.0.5");
  });

  it("uses rightmost XFF hop when hops=1", () => {
    const ip = resolveClientIp(
      fakeReq({ remoteAddress: "10.0.0.1", xff: "9.9.9.9, 8.8.8.8, 10.0.0.1" }),
      { trustProxy: true, trustProxyHops: 1 },
    );
    expect(ip).toBe("10.0.0.1");
  });

  it("uses second-from-right hop when hops=2 (spoofed left ignored)", () => {
    const ip = resolveClientIp(
      fakeReq({ remoteAddress: "10.0.0.1", xff: "evil.client, 203.0.113.5, 10.0.0.1" }),
      { trustProxy: true, trustProxyHops: 2 },
    );
    // hop 2 from right = 203.0.113.5 (client as seen by outer proxy)
    expect(ip).toBe("203.0.113.5");
  });

  it("falls back to socket when XFF missing", () => {
    const ip = resolveClientIp(fakeReq({ remoteAddress: "192.168.1.9" }), {
      trustProxy: true,
      trustProxyHops: 1,
    });
    expect(ip).toBe("192.168.1.9");
  });
});
