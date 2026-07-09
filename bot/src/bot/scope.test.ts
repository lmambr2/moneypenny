import { describe, expect, it } from "vitest";
import { defaultBotScope, parseBotScope, resolveScope } from "./scope.js";

describe("bot scope (H6)", () => {
  it("defaults are free-roam", () => {
    const r = resolveScope(defaultBotScope(), { botName: "Penny" });
    expect(r.channelPinned).toBe(false);
    expect(r.channelHint).toBeNull();
    expect(r.serverLabel).toBe("Penny");
  });

  it("pins channel when hint set", () => {
    const r = resolveScope(
      parseBotScope({ channelHint: " Ops Lobby ", serverLabel: "SC-TS", virtualServerId: "1" }),
    );
    expect(r.channelPinned).toBe(true);
    expect(r.channelHint).toBe("Ops Lobby");
    expect(r.serverLabel).toBe("SC-TS");
    expect(r.virtualServerId).toBe("1");
  });

  it("parseBotScope rejects garbage", () => {
    expect(parseBotScope(null)).toEqual(defaultBotScope());
    expect(parseBotScope("x")).toEqual(defaultBotScope());
  });
});
