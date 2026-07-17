import { describe, expect, it } from "vitest";
import {
  asChannelId,
  filterClientsInChannel,
  resolveOwnChannelId,
  sameChannelId,
} from "./channel-presence.js";

describe("asChannelId / sameChannelId", () => {
  it("normalizes number string bigint", () => {
    expect(asChannelId(770)).toBe(770n);
    expect(asChannelId("770")).toBe(770n);
    expect(asChannelId(770n)).toBe(770n);
    expect(sameChannelId(770, "770")).toBe(true);
    expect(sameChannelId(770n, 1n)).toBe(false);
  });
});

describe("resolveOwnChannelId", () => {
  it("prefers clientlist self row over a stale library 0n", () => {
    expect(
      resolveOwnChannelId({
        selfClientId: 58,
        libraryChannelId: 0n,
        allClients: [
          { id: 58, channelID: 770n },
          { id: 48, channelID: 770n },
          { id: 54, channelID: 770n },
        ],
      }),
    ).toBe(770n);
  });

  it("falls back to library then http", () => {
    expect(
      resolveOwnChannelId({
        selfClientId: 1,
        libraryChannelId: 12n,
        allClients: [],
      }),
    ).toBe(12n);
    expect(
      resolveOwnChannelId({
        selfClientId: 1,
        libraryChannelId: 0n,
        httpChannelId: "99",
      }),
    ).toBe(99n);
  });
});

describe("filterClientsInChannel", () => {
  it("does not drop clients when library channel was wrong but list is fixed", () => {
    const all = [
      { id: 58, channelID: 770n },
      { id: 48, channelID: 770n },
      { id: 54, channelID: 770n },
      { id: 9, channelID: 1n },
    ];
    // Bug case: myChannelId 0n → empty
    expect(filterClientsInChannel(all, 0n)).toEqual([]);
    // Fixed: resolve 770 from self row first
    const mine = resolveOwnChannelId({
      selfClientId: 58,
      libraryChannelId: 0n,
      allClients: all,
    });
    expect(
      filterClientsInChannel(all, mine)
        .map((c) => c.id)
        .sort(),
    ).toEqual([48, 54, 58]);
  });
});
