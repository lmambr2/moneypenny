import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueuedSong } from "../audio/queue.js";
import type { TS3Client } from "../ts-protocol/client.js";
import { BotProfileManager } from "./profile.js";

function makeMockTs(): TS3Client & {
  uploadCalls: Buffer[];
  clearCalls: number;
} {
  const calls: Buffer[] = [];
  let clears = 0;
  const ts: any = {
    uploadCalls: calls,
    get clearCalls() {
      return clears;
    },
    getHost: () => "127.0.0.1",
    getHttpQuery: () => null,
    fileTransferInitUpload: vi.fn().mockResolvedValue({}),
    uploadFileData: vi.fn().mockImplementation(async (_h: any, _i: any, stream: any) => {
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      calls.push(Buffer.concat(chunks));
    }),
    fileTransferDeleteFile: vi.fn().mockResolvedValue(undefined),
    sendCommandNoWait: vi.fn().mockImplementation(async (cmd: string) => {
      if (/client_flag_avatar=$/.test(cmd)) clears++;
    }),
  };
  return ts;
}

const noopLogger: any = {
  child: () => noopLogger,
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

const cfgOn = {
  avatarEnabled: true,
  descriptionEnabled: false,
  nicknameEnabled: false,
  awayStatusEnabled: false,
  channelDescEnabled: false,
  nowPlayingMsgEnabled: false,
};
const cfgOff = { ...cfgOn, avatarEnabled: false };

const fakeSong: QueuedSong = {
  id: "1",
  name: "X",
  artist: "Y",
  album: "Z",
  platform: "youtube",
  url: "u",
  coverUrl: "c",
  duration: 100,
};

const flush = () => new Promise((r) => setImmediate(r));

describe("BotProfileManager custom avatar precedence", () => {
  let ts: ReturnType<typeof makeMockTs>;
  beforeEach(() => {
    ts = makeMockTs();
  });

  it("setCustomAvatar uploads immediately on a fresh idle bot (sync on)", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOn, "Bot");
    pm.setCustomAvatar(Buffer.from([1, 2, 3]));
    await flush();
    expect(ts.uploadCalls.length).toBe(1);
    expect(ts.uploadCalls[0].equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it("setCustomAvatar uploads immediately when sync is off (always idle)", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOff, "Bot");
    pm.setCustomAvatar(Buffer.from([7]));
    await flush();
    expect(ts.uploadCalls.length).toBe(1);
  });

  it("setCustomAvatar while playing + sync on does NOT push (cover wins)", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOn, "Bot");
    // Simulate the bot playing a song. We can't actually run updateAvatar's
    // full HTTP fetch path, but onSongChange records currentSong before
    // updateAvatar runs, which is enough for this assertion.
    void pm.onSongChange(fakeSong);
    await flush();
    const uploadsBefore = ts.uploadCalls.length;
    pm.setCustomAvatar(Buffer.from([42]));
    await flush();
    expect(ts.uploadCalls.length).toBe(uploadsBefore); // no new upload
  });

  it("setCustomAvatar while playing + sync off DOES push (sync-off is idle)", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOff, "Bot");
    void pm.onSongChange(fakeSong);
    await flush();
    const uploadsBefore = ts.uploadCalls.length;
    pm.setCustomAvatar(Buffer.from([42]));
    await flush();
    expect(ts.uploadCalls.length).toBe(uploadsBefore + 1);
  });

  it("setCustomAvatar(null) while idle clears the TS3 avatar", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOn, "Bot");
    pm.setCustomAvatar(Buffer.from([1]));
    await flush();
    const clearsBefore = ts.clearCalls;
    pm.setCustomAvatar(null);
    await flush();
    expect(ts.clearCalls).toBe(clearsBefore + 1);
  });

  it("on stop with custom avatar set + sync on, restores custom (does not clear)", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOn, "Bot");
    pm.setCustomAvatar(Buffer.from([1, 2, 3, 4]));
    await flush();
    const clearsBefore = ts.clearCalls;
    await pm.onSongChange(null);
    expect(ts.uploadCalls.at(-1)?.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
    expect(ts.clearCalls).toBe(clearsBefore); // no extra clear
  });

  it("on stop with no custom avatar, falls back to clear", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOn, "Bot");
    await pm.onSongChange(null);
    expect(ts.clearCalls).toBe(1);
    expect(ts.uploadCalls.length).toBe(0);
  });

  it("on connect with custom avatar set + sync ON, applies custom (spec matrix row 1)", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOn, "Bot");
    pm.setCustomAvatar(Buffer.from([5, 5]));
    await flush();
    ts.uploadCalls.length = 0; // reset
    pm.onConnect();
    await flush();
    expect(ts.uploadCalls.length).toBe(1);
    expect(ts.uploadCalls[0].equals(Buffer.from([5, 5]))).toBe(true);
  });

  it("on connect with custom avatar set + sync OFF, applies custom", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOff, "Bot");
    pm.setCustomAvatar(Buffer.from([9, 9]));
    await flush();
    ts.uploadCalls.length = 0;
    pm.onConnect();
    await flush();
    expect(ts.uploadCalls.length).toBe(1);
    expect(ts.uploadCalls[0].equals(Buffer.from([9, 9]))).toBe(true);
  });

  it("on connect with no custom avatar, does not touch avatar", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOff, "Bot");
    pm.onConnect();
    await flush();
    expect(ts.uploadCalls.length).toBe(0);
    expect(ts.clearCalls).toBe(0);
  });
});
