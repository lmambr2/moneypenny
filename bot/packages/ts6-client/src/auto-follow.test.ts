import { describe, expect, it } from "vitest";
import { pickBusiestChannel, tallyChannelPopulations } from "./channel-presence.js";

/** clientlist row: type 1 is a serverquery session, not a person. */
const c = (id: number, channelID: bigint | number | string, type = 0) => ({ id, channelID, type });

const BOT = 1;
const LOBBY = 10n;
const OPS = 20n;
const AFK = 99n;

describe("tallyChannelPopulations", () => {
  it("counts people per channel", () => {
    const rows = tallyChannelPopulations([c(2, LOBBY), c(3, LOBBY), c(4, OPS)], BOT);
    expect(rows).toEqual(
      expect.arrayContaining([
        { channelId: LOBBY, humans: 2 },
        { channelId: OPS, humans: 1 },
      ]),
    );
  });

  it("never counts the bot as company", () => {
    expect(tallyChannelPopulations([c(BOT, LOBBY)], BOT)).toEqual([]);
  });

  it("ignores serverquery sessions", () => {
    expect(tallyChannelPopulations([c(7, LOBBY, 1)], BOT)).toEqual([]);
  });

  it("ignores rows with an unresolvable channel", () => {
    expect(tallyChannelPopulations([c(2, 0), c(3, "")], BOT)).toEqual([]);
  });

  it("accepts number and string channel ids from the wire", () => {
    const rows = tallyChannelPopulations([c(2, 10), c(3, "10")], BOT);
    expect(rows).toEqual([{ channelId: LOBBY, humans: 2 }]);
  });
});

describe("pickBusiestChannel", () => {
  it("follows the crowd to the busiest channel", () => {
    const all = [c(2, LOBBY), c(3, OPS), c(4, OPS), c(BOT, LOBBY)];
    expect(pickBusiestChannel(all, { selfClientId: BOT, currentChannelId: LOBBY })).toBe(OPS);
  });

  it("stays put when nobody is anywhere else", () => {
    expect(
      pickBusiestChannel([c(BOT, LOBBY)], { selfClientId: BOT, currentChannelId: LOBBY }),
    ).toBeNull();
  });

  it("never suggests the channel it is already in", () => {
    const all = [c(2, LOBBY), c(3, LOBBY), c(BOT, LOBBY)];
    expect(pickBusiestChannel(all, { selfClientId: BOT, currentChannelId: LOBBY })).toBeNull();
  });

  // The whole point of AFK is that nobody there wants a DJ.
  it("never follows people into an excluded (AFK) channel", () => {
    const all = [c(2, AFK), c(3, AFK), c(4, AFK), c(5, OPS)];
    expect(
      pickBusiestChannel(all, {
        selfClientId: BOT,
        currentChannelId: LOBBY,
        excludeChannelIds: [AFK],
      }),
    ).toBe(OPS);
  });

  it("stays put when the only people online are AFK", () => {
    const all = [c(2, AFK), c(3, AFK)];
    expect(
      pickBusiestChannel(all, {
        selfClientId: BOT,
        currentChannelId: LOBBY,
        excludeChannelIds: [AFK],
      }),
    ).toBeNull();
  });

  // Two equally busy channels must not make the bot hop on every poll.
  it("breaks ties deterministically", () => {
    const all = [c(2, OPS), c(3, LOBBY)];
    const pick = () => pickBusiestChannel(all, { selfClientId: BOT, currentChannelId: 5n });
    expect(pick()).toBe(LOBBY);
    expect(pick()).toBe(LOBBY);
    expect(
      pickBusiestChannel([...all].reverse(), { selfClientId: BOT, currentChannelId: 5n }),
    ).toBe(LOBBY);
  });

  it("ignores serverquery sessions when choosing", () => {
    const all = [c(2, OPS, 1), c(3, OPS, 1), c(4, LOBBY)];
    expect(pickBusiestChannel(all, { selfClientId: BOT, currentChannelId: 5n })).toBe(LOBBY);
  });

  it("returns null for an empty server", () => {
    expect(pickBusiestChannel([], { selfClientId: BOT, currentChannelId: LOBBY })).toBeNull();
  });
});
