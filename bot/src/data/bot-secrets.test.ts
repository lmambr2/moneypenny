import { describe, it, expect } from "vitest";
import { mergeBotSecret, redactBotInstanceSecrets } from "./bot-secrets.js";
import type { BotInstance } from "./database.js";

const sample: BotInstance = {
  id: "b1",
  name: "Test",
  serverAddress: "ts.example.com",
  serverPort: 9987,
  nickname: "Bot",
  defaultChannel: "",
  channelPassword: "chan-secret",
  autoStart: true,
  serverProtocol: "ts6",
  ts6ApiKey: "api-key-secret",
  serverPassword: "server-secret",
  identity: '{"privateKey":"abc"}',
};

describe("redactBotInstanceSecrets", () => {
  it("strips secrets and reports presence flags", () => {
    const view = redactBotInstanceSecrets(sample);
    expect(view.serverPassword).toBe("");
    expect(view.channelPassword).toBe("");
    expect(view.ts6ApiKey).toBe("");
    expect(view.identity).toBeUndefined();
    expect(view.hasServerPassword).toBe(true);
    expect(view.hasChannelPassword).toBe(true);
    expect(view.hasTs6ApiKey).toBe(true);
    expect(view.hasIdentity).toBe(true);
  });
});

describe("mergeBotSecret", () => {
  it("keeps existing when incoming is empty or undefined", () => {
    expect(mergeBotSecret(undefined, "keep")).toBe("keep");
    expect(mergeBotSecret("", "keep")).toBe("keep");
  });

  it("replaces when incoming is non-empty", () => {
    expect(mergeBotSecret("new", "old")).toBe("new");
  });
});