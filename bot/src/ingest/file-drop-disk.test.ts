import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  channelFilesDir,
  diskPathForChannelFile,
  listDiskChannelFiles,
  readDiskChannelFile,
} from "./file-drop-disk.js";

describe("file-drop-disk", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mp-fd-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("maps channel id to TS on-disk layout", () => {
    expect(channelFilesDir("/ts6-files", 1, 21n)).toBe("/ts6-files/virtualserver_1/channel_21");
  });

  it("rejects path traversal out of the channel dir", () => {
    const channelDir = path.join(tmp, "channel_21");
    expect(() => diskPathForChannelFile(channelDir, "/../escape.md")).toThrow(/escapes/);
  });

  it("lists nested files with TS-style paths", async () => {
    const channelDir = path.join(tmp, "virtualserver_1", "channel_5");
    await fs.mkdir(path.join(channelDir, "sub"), { recursive: true });
    await fs.writeFile(path.join(channelDir, "top.md"), "# top");
    await fs.writeFile(path.join(channelDir, "sub", "nested.md"), "# nested");

    const entries = await listDiskChannelFiles(channelDir);
    const paths = entries.map((e) => e.filePath).sort();
    expect(paths).toEqual(["/sub/nested.md", "/top.md"]);
    expect(entries[0].file.type).toBe(1);
  });

  it("reads a file with a size cap", async () => {
    const f = path.join(tmp, "small.md");
    await fs.writeFile(f, "hello");
    const buf = await readDiskChannelFile(f, 1024);
    expect(buf.toString()).toBe("hello");
    await expect(readDiskChannelFile(f, 2)).rejects.toThrow(/too large/);
  });
});
