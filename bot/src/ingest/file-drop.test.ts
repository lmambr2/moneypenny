import type { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ChannelFile } from "@moneypenny/ts6-client";
import { type FileDropDeps, scanDropChannel } from "./file-drop.js";

function file(name: string, extra: Partial<ChannelFile> = {}): ChannelFile {
  return { name, size: 10n, datetime: 1000, type: 1, ...extra };
}

function makeDeps(opts: {
  files: ChannelFile[];
  content?: string;
  ragEnabled?: boolean;
  seeded?: string[];
}) {
  const recorded: Array<{ key: string; name: string; kind: string; result: string }> = [];
  const seen = new Set<string>(opts.seeded ?? []);
  const store = {
    seen: (k: string) => seen.has(k),
    record: (e: any) => {
      recorded.push(e);
      seen.add(e.key);
    },
  };
  const uploadSong = vi.fn().mockResolvedValue({ name: "Track", artist: "Artist" });
  const retrieval = { ingest: vi.fn().mockResolvedValue(3), purge: vi.fn() };
  const doctrine = { saveFile: vi.fn((n: string) => n), upsert: vi.fn() };
  const sendChannelMessage = vi.fn().mockResolvedValue(undefined);
  const content = opts.content ?? "---\nclassification: secret\ntags: [intel]\n---\n# Doc\nbody";

  const tsClient = {
    resolveChannelIdByName: vi.fn().mockResolvedValue(5n),
    listChannelFiles: vi.fn().mockResolvedValue(opts.files),
    fileTransferInitDownload: vi.fn().mockResolvedValue({
      size: BigInt(content.length || 4),
      fileTransferKey: "k",
      clientFileTransferID: 1,
      serverFileTransferID: 1,
      port: 1,
    }),
    downloadFileData: vi.fn(async (_host: string, _info: unknown, dest: Writable) => {
      dest.write(Buffer.from(content));
      dest.end();
    }),
    getHost: () => "host",
    sendChannelMessage,
  };

  const deps = {
    tsClient,
    localProvider: { platform: "local", uploadSong } as any,
    retrieval: retrieval as any,
    doctrine: doctrine as any,
    store: store as any,
    config: {
      ragEnabled: opts.ragEnabled ?? true,
      fileDropEnabled: true,
      fileDropPollSec: 30,
    } as any,
    isConnected: () => true,
  } as unknown as FileDropDeps;

  return { deps, recorded, uploadSong, retrieval, doctrine, sendChannelMessage };
}

describe("scanDropChannel routing", () => {
  it("routes a .md into doctrine RAG (not the music library)", async () => {
    const t = makeDeps({ files: [file("intsum.md")] });
    await scanDropChannel(t.deps, 5n);
    expect(t.retrieval.ingest).toHaveBeenCalledTimes(1);
    expect(t.uploadSong).not.toHaveBeenCalled();
    expect(t.recorded[0]).toMatchObject({ name: "intsum.md", kind: "doctrine" });
    expect(t.sendChannelMessage).toHaveBeenCalledWith(
      5n,
      expect.stringContaining("classification: secret"),
    );
  });

  it("routes audio into the music library (not RAG)", async () => {
    const t = makeDeps({ files: [file("banger.mp3")], content: "ID3-bytes" });
    await scanDropChannel(t.deps, 5n);
    expect(t.uploadSong).toHaveBeenCalledTimes(1);
    expect(t.uploadSong.mock.calls[0][0]).toBe("banger.mp3");
    expect(t.retrieval.ingest).not.toHaveBeenCalled();
    expect(t.recorded[0]).toMatchObject({ name: "banger.mp3", kind: "music" });
    expect(t.sendChannelMessage).toHaveBeenCalledWith(
      5n,
      '🎵 Added "Track — Artist" to the library.',
    );
  });

  it("skips unsupported types without downloading", async () => {
    const t = makeDeps({ files: [file("notes.txt")] });
    await scanDropChannel(t.deps, 5n);
    expect(t.deps.tsClient.fileTransferInitDownload as any).not.toHaveBeenCalled();
    expect(t.recorded[0]).toMatchObject({ kind: "skipped", result: "unsupported type" });
  });

  it("skips .md when RAG is disabled", async () => {
    const t = makeDeps({ files: [file("intsum.md")], ragEnabled: false });
    await scanDropChannel(t.deps, 5n);
    expect(t.retrieval.ingest).not.toHaveBeenCalled();
    expect(t.recorded[0]).toMatchObject({ kind: "skipped", result: "RAG disabled" });
  });

  it("does not re-ingest an already-seen file", async () => {
    const seenKey = `5:/intsum.md:10:1000`;
    const t = makeDeps({ files: [file("intsum.md")], seeded: [seenKey] });
    await scanDropChannel(t.deps, 5n);
    expect(t.retrieval.ingest).not.toHaveBeenCalled();
    expect(t.recorded).toHaveLength(0);
  });

  it("ignores empty directories", async () => {
    const t = makeDeps({ files: [file("subdir", { type: 0 })] });
    await scanDropChannel(t.deps, 5n);
    expect(t.recorded).toHaveLength(0);
  });
});

describe("scanDropChannel hardening", () => {
  it("recurses into subdirectories and downloads via the full nested path", async () => {
    const t = makeDeps({ files: [] });
    (t.deps.tsClient.listChannelFiles as any).mockImplementation(
      async (_cid: bigint, dir: string) => {
        if (dir === "/") return [file("sub", { type: 0 })];
        if (dir === "/sub") return [file("nested.md")];
        return [];
      },
    );
    await scanDropChannel(t.deps, 5n);
    expect(t.retrieval.ingest).toHaveBeenCalledTimes(1);
    expect(t.recorded[0]).toMatchObject({ name: "nested.md", kind: "doctrine" });
    expect((t.deps.tsClient.fileTransferInitDownload as any).mock.calls[0][1]).toBe(
      "/sub/nested.md",
    );
  });

  it("retries a transient download failure (not recorded), then gives up after the cap", async () => {
    const t = makeDeps({ files: [file("intsum.md")] });
    (t.deps.tsClient.fileTransferInitDownload as any).mockRejectedValue(new Error("transfer hung"));
    const attempts = new Map<string, number>();

    await scanDropChannel(t.deps, 5n, attempts); // attempt 1 → retry
    await scanDropChannel(t.deps, 5n, attempts); // attempt 2 → retry
    expect(t.recorded).toHaveLength(0); // nothing recorded while retrying
    expect(t.retrieval.ingest).not.toHaveBeenCalled();

    await scanDropChannel(t.deps, 5n, attempts); // attempt 3 → give up
    expect(t.recorded).toHaveLength(1);
    expect(t.recorded[0].kind).toBe("skipped");
    expect(t.recorded[0].result).toMatch(/read failed after 3 attempts/);
  });
});
