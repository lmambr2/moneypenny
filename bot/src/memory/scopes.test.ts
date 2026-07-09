import { describe, expect, it } from "vitest";
import {
  buildScopesSnapshot,
  describeMemoryScopes,
  filterOrgBroadcastFacts,
  isBroadcastSafeSource,
} from "./scopes.js";

describe("memory scopes (H3)", () => {
  it("describes private as never broadcast", () => {
    const scopes = describeMemoryScopes({
      memoryEnabled: true,
      kgEnabled: true,
      memoryBroadcastOptIn: true,
    });
    const priv = scopes.find((s) => s.id === "private")!;
    const org = scopes.find((s) => s.id === "org")!;
    expect(priv.broadcastOk).toBe(false);
    expect(org.broadcastOk).toBe(true);
    expect(priv.commands.join(" ")).toMatch(/remember/);
    expect(org.commands.join(" ")).toMatch(/kg/);
  });

  it("org broadcastOk follows opt-in", () => {
    const off = describeMemoryScopes({ memoryBroadcastOptIn: false }).find((s) => s.id === "org")!;
    expect(off.broadcastOk).toBe(false);
  });

  it("rejects private source strings for broadcast", () => {
    expect(isBroadcastSafeSource("your memory")).toBe(false);
    expect(isBroadcastSafeSource("your memory (MemPalace)")).toBe(false);
    expect(isBroadcastSafeSource("private room")).toBe(false);
    expect(isBroadcastSafeSource("org knowledge graph")).toBe(true);
    expect(isBroadcastSafeSource("org memory (intel)")).toBe(true);
  });

  it("filters mixed hits so private never becomes bumper material", () => {
    const out = filterOrgBroadcastFacts([
      { fact: "I fly a Prospector", source: "your memory" },
      { fact: "FC is Alice", source: "org knowledge graph" },
      { fact: "secret", source: "private" },
    ]);
    expect(out).toEqual([{ fact: "FC is Alice" }]);
  });

  it("snapshot carries isolation rule", () => {
    const snap = buildScopesSnapshot({
      privateCount: 2,
      orgCount: 5,
      memoryBroadcastOptIn: false,
    });
    expect(snap.privateCount).toBe(2);
    expect(snap.orgCount).toBe(5);
    expect(snap.isolationRule).toMatch(/never/i);
  });
});
