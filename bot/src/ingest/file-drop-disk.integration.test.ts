import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileDropDeps } from "./file-drop.js";
import { scanDropChannel } from "./file-drop.js";

describe("scanDropChannel disk mount", () => {
  let tmp: string;
  let channelDir: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mp-fd-int-"));
    channelDir = path.join(tmp, "virtualserver_1", "channel_21");
    await fs.mkdir(channelDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("ingests a .md from the mounted channel dir without FT download", async () => {
    const content = "---\nclassification: secret\ntags: [intel]\n---\n# Doc\nbody";
    await fs.writeFile(path.join(channelDir, "intsum.md"), content);

    const recorded: Array<{ key: string; name: string; kind: string }> = [];
    const retrieval = { ingest: vi.fn().mockResolvedValue(2), purge: vi.fn() };
    const doctrine = { saveFile: vi.fn((n: string) => n), upsert: vi.fn() };

    const deps = {
      tsClient: {
        resolveChannelIdByName: vi.fn(),
        listChannelFiles: vi.fn(),
        fileTransferInitDownload: vi.fn(),
        downloadFileData: vi.fn(),
        getHost: () => "host",
        sendChannelMessage: vi.fn().mockResolvedValue(undefined),
      },
      localProvider: { platform: "local", uploadSong: vi.fn() },
      retrieval,
      doctrine,
      store: {
        seen: () => false,
        record: (e: { key: string; name: string; kind: string }) => recorded.push(e),
      },
      config: { ragEnabled: true, fileDropEnabled: true, fileDropPollSec: 30 },
      isConnected: () => true,
      tsFilesDir: tmp,
      tsVirtualServerId: 1,
    } as unknown as FileDropDeps;

    await scanDropChannel(deps, 21n);
    expect(retrieval.ingest).toHaveBeenCalledTimes(1);
    expect(deps.tsClient.listChannelFiles).not.toHaveBeenCalled();
    expect(deps.tsClient.fileTransferInitDownload).not.toHaveBeenCalled();
    expect(recorded[0]).toMatchObject({ name: "intsum.md", kind: "doctrine" });
  });
});
