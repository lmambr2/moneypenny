import { describe, it, expect, vi } from "vitest";
import {
  conversationKey,
  allowedClassificationsFor,
  nicknameMatchesUsername,
  resolveSubject,
  resolveWebSubject,
} from "./subject.js";
import { RightsEngine } from "../../rights/index.js";

describe("rights/subject", () => {
  it("conversationKey scopes private messages per user", () => {
    expect(conversationKey({ targetMode: 1, invokerUid: "abc" } as any)).toBe("dm:abc");
    expect(conversationKey({ targetMode: 2, invokerUid: "abc" } as any)).toBe("channel");
  });

  it("allowedClassificationsFor returns undefined when rights are off", () => {
    expect(allowedClassificationsFor({ uid: "u", serverGroups: [] }, null)).toBeUndefined();
  });

  it("nicknameMatchesUsername links web logins to TS nicknames", () => {
    expect(nicknameMatchesUsername("Alice Field", "alice")).toBe(true);
    expect(nicknameMatchesUsername("Alice Field", "Alice Field")).toBe(true);
    expect(nicknameMatchesUsername("Bob Cadet", "bob")).toBe(true);
    expect(nicknameMatchesUsername("Bob Cadet", "cadet")).toBe(true);
    expect(nicknameMatchesUsername("Bob", "alice")).toBe(false);
  });

  it("resolveSubject falls back to HTTP server groups by clid", async () => {
    const tsClient = {
      getClientsInChannel: vi.fn(async () => [
        { id: 110, uid: "alice-uid", nickname: "Alice Field", serverGroups: [], channelID: 1n, type: 0 },
      ]),
      getServerGroupsForClient: vi.fn(async () => ["105", "106", "107", "108"]),
    };
    const subject = await resolveSubject("alice-uid", tsClient as any, console as any, [], 110);
    expect(subject.serverGroups).toEqual(["105", "106", "107", "108"]);
  });

  it("resolveWebSubject inherits TS server groups for matched channel members", async () => {
    const tsClient = {
      getClientsInChannel: vi.fn(async () => [
        {
          id: 144,
          uid: "bob-uid",
          nickname: "Bob Cadet",
          serverGroups: ["105", "106"],
          channelID: 1n,
          type: 0,
        },
      ]),
    };
    const subject = await resolveWebSubject(
      { id: "7", username: "bob", role: "member" },
      tsClient,
      ["107"],
      console as any,
    );
    expect(subject.serverGroups).toEqual(["105", "106"]);
    expect(subject.uid).toBe("bob-uid");
  });

  it("allowedClassificationsFor always includes unclassified", () => {
    const engine = new RightsEngine({
      rules: [{ match: { serverGroups: ["officer"] }, allow: ["doctrine:secret", "doctrine:confidential"] }],
    });
    const levels = allowedClassificationsFor({ uid: "u", serverGroups: ["officer"] }, engine)!;
    expect(levels).toContain("unclassified");
    expect(levels).toContain("secret");
    expect(levels).not.toContain("restricted");
  });
});