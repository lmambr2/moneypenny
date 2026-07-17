/**
 * PR-B2 — lock the public barrel surface so hosts can rely on a stable API.
 * Adding a symbol is fine; removing/renaming requires a deliberate bump.
 */
import { describe, expect, it } from "vitest";
import * as api from "./index.js";

const REQUIRED_EXPORTS = [
  // Connect
  "TS3Client",
  "detectServerProtocol",
  // Text / encoding
  "escapeTS3",
  // Voice
  "CODEC_OPUS_VOICE",
  "CODEC_OPUS_MUSIC",
  "VoiceConnection",
  "VoiceTransportHealth",
  // File drop
  "parseFtFileList",
  "extractFileRows",
  // Query
  "HttpQueryError",
  "TS6HttpQuery",
  // Move / presence
  "resolveClientQuery",
  "resolveChannelQuery",
  "filterClientsInChannel",
  "asChannelId",
  // Identity / wire encoding
  "generateIdentity",
  "escapeValue",
  "encodeCommand",
] as const;

describe("public API surface (@moneypenny/ts6-client)", () => {
  it("exports the station-facing connect/text/voice/file-drop surface", () => {
    for (const name of REQUIRED_EXPORTS) {
      expect(api, `missing export: ${name}`).toHaveProperty(name);
      expect((api as Record<string, unknown>)[name], name).toBeDefined();
    }
  });

  it("exposes TS3Client as a constructible class", () => {
    expect(typeof api.TS3Client).toBe("function");
    expect(api.CODEC_OPUS_VOICE).toBe(4);
    expect(api.CODEC_OPUS_MUSIC).toBe(5);
  });
});
