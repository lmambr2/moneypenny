import { describe, expect, it } from "vitest";
import {
  extractQueryRows,
  parseChannelRows,
  parseClientRows,
  resolveChannelQuery,
  resolveClientQuery,
  serverGroupsByClidFromRows,
} from "./move-resolver.js";

describe("move-resolver", () => {
  const clients = parseClientRows([
    { clid: "10", client_nickname: "James Bond" },
    { clid: "11", client_nickname: "Moneypenny" },
  ]);

  const channels = parseChannelRows([
    { cid: "1", channel_name: "Lobby" },
    { cid: "42", channel_name: "Briefing Room" },
  ]);

  it("extractQueryRows reads TS6 envelopes", () => {
    expect(extractQueryRows({ body: [{ clid: "1" }] })).toEqual([{ clid: "1" }]);
  });

  it("serverGroupsByClidFromRows parses TS6 clientlist -groups rows", () => {
    const map = serverGroupsByClidFromRows([
      { clid: "110", client_servergroups: "105,106,107,108" },
      { clid: "144", client_servergroups: "105,106,109,110" },
    ]);
    expect(map.get(110)).toEqual(["105", "106", "107", "108"]);
    expect(map.get(144)).toEqual(["105", "106", "109", "110"]);
  });

  it("resolves client by clid and nickname", () => {
    expect(resolveClientQuery("10", clients)).toEqual({
      ok: true,
      value: { clid: 10, nickname: "James Bond" },
    });
    expect(resolveClientQuery("Moneypenny", clients).ok).toBe(true);
  });

  it("rejects ambiguous client prefix", () => {
    const ambiguous = parseClientRows([
      { clid: "1", client_nickname: "Agent Alpha" },
      { clid: "2", client_nickname: "Agent Bravo" },
    ]);
    const r = resolveClientQuery("Agent", ambiguous);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Ambiguous/i);
  });

  it("resolves channel by cid and name", () => {
    expect(resolveChannelQuery("42", channels).ok).toBe(true);
    expect(resolveChannelQuery("Briefing Room", channels)).toEqual({
      ok: true,
      value: { cid: 42, name: "Briefing Room" },
    });
  });
});
