import { describe, it, expect } from "vitest";
import {
  detectServerProtocol,
  type ServerProtocol,
  type ProtocolDetectResult,
} from "./protocol-detect.js";

describe("protocol-detect", () => {
  it("returns unknown for unreachable hosts", async () => {
    const result = await detectServerProtocol("192.0.2.1", 9987, 1000);
    expect(result.protocol).toBe("unknown");
    expect(result.queryPort).toBeNull();
    expect(result.voicePort).toBe(9987);
  });

  it("result shape matches ProtocolDetectResult interface", async () => {
    const result = await detectServerProtocol("127.0.0.1", 9987, 500);
    expect(result).toHaveProperty("protocol");
    expect(result).toHaveProperty("queryPort");
    expect(result).toHaveProperty("voicePort");
    expect(["ts3", "ts6", "unknown"]).toContain(result.protocol);
  });
});
