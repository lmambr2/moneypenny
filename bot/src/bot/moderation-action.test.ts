/**
 * G4 — drive BotInstance.moderationAction (real method) with injectables.
 * Rights fail-closed; transport/disconnect fail-open (music never blocked).
 */
import { describe, expect, it, vi } from "vitest";
import { BotInstance } from "./instance.js";

const moderationAction = BotInstance.prototype.moderationAction;

function harness(opts: {
  connected?: boolean;
  clients?: Array<{ id?: number; clid?: number; nickname?: string; name?: string }>;
  getClientsThrows?: Error;
  pokeThrows?: Error;
}) {
  const pokeClient = vi.fn(async () => {
    if (opts.pokeThrows) throw opts.pokeThrows;
  });
  const getClientsInChannel = vi.fn(async () => {
    if (opts.getClientsThrows) throw opts.getClientsThrows;
    return opts.clients ?? [];
  });
  const self = {
    connected: opts.connected ?? true,
    tsClient: { getClientsInChannel, pokeClient },
  };
  return {
    self,
    pokeClient,
    getClientsInChannel,
    run: (action: "mute" | "kick", target: string, canRun: (c: string) => boolean) =>
      moderationAction.call(self, action, target, canRun),
  };
}

describe("BotInstance.moderationAction (G4)", () => {
  it("fails closed when invoker has no mute/kick/moveclient rights", async () => {
    const h = harness({ clients: [{ id: 7, nickname: "Alice" }] });
    const out = await h.run("mute", "Alice", () => false);
    expect(out).toMatch(/permission/i);
    expect(h.getClientsInChannel).not.toHaveBeenCalled();
    expect(h.pokeClient).not.toHaveBeenCalled();
  });

  it("fails closed on mute when only kick is allowed", async () => {
    const h = harness({ clients: [{ id: 7, nickname: "Alice" }] });
    const out = await h.run("mute", "Alice", (c) => c === "kick");
    expect(out).toMatch(/permission to mute/i);
    expect(h.pokeClient).not.toHaveBeenCalled();
  });

  it("fails closed on kick when only mute is allowed", async () => {
    const h = harness({ clients: [{ id: 7, nickname: "Alice" }] });
    const out = await h.run("kick", "Alice", (c) => c === "mute");
    expect(out).toMatch(/permission to kick/i);
    expect(h.pokeClient).not.toHaveBeenCalled();
  });

  it("fail-open when bot is disconnected (music unaffected)", async () => {
    const h = harness({ connected: false, clients: [{ id: 1, nickname: "Bob" }] });
    const out = await h.run("mute", "Bob", () => true);
    expect(out).toMatch(/not connected/i);
    expect(out).toMatch(/music unaffected/i);
    expect(h.getClientsInChannel).not.toHaveBeenCalled();
  });

  it("fail-open when getClientsInChannel throws (transport)", async () => {
    const h = harness({ getClientsThrows: new Error("query down") });
    const out = await h.run("kick", "x", (c) => c === "kick");
    expect(out).toMatch(/failed open/i);
    expect(out).toMatch(/query down/);
    expect(out).toMatch(/Music unaffected/i);
  });

  it("fail-open when pokeClient throws but still reports target", async () => {
    const h = harness({
      clients: [{ id: 42, nickname: "Dana" }],
      pokeThrows: new Error("poke rejected"),
    });
    const out = await h.run("mute", "Dana", (c) => c === "mute");
    // poke failure is swallowed; action still reports success path (fail-open poke)
    expect(out).toMatch(/Dana/);
    expect(out).toMatch(/mute requested/i);
    expect(h.pokeClient).toHaveBeenCalledWith(42, "Moderation: mute");
  });

  it("resolves target by nickname and pokes when allowed", async () => {
    const h = harness({ clients: [{ id: 9, nickname: "Eve-Ops" }] });
    const out = await h.run("kick", "eve", (c) => c === "kick" || c === "moveclient");
    expect(out).toMatch(/kick requested/i);
    expect(out).toMatch(/Eve-Ops/);
    expect(h.pokeClient).toHaveBeenCalledWith(9, "Moderation: kick");
  });

  it("reports no match without throwing (music unaffected)", async () => {
    const h = harness({ clients: [{ id: 1, nickname: "OnlyOne" }] });
    const out = await h.run("mute", "nobody", () => true);
    expect(out).toMatch(/No client matching/i);
    expect(out).toMatch(/Music unaffected/i);
    expect(h.pokeClient).not.toHaveBeenCalled();
  });

  it("allows mute via moveclient rights alone", async () => {
    const h = harness({ clients: [{ clid: 3, name: "Charlie" }] });
    const out = await h.run("mute", "3", (c) => c === "moveclient");
    expect(out).toMatch(/Charlie|3/);
    expect(h.pokeClient).toHaveBeenCalledWith(3, "Moderation: mute");
  });
});
