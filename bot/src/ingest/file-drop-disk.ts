import fs from "node:fs/promises";
import path from "node:path";
import type { ChannelFile } from "@moneypenny/ts6-client";

/** TS6 on-disk layout: `<root>/virtualserver_<sid>/channel_<cid>/…` */
export function channelFilesDir(
  tsFilesDir: string,
  virtualServerId: number | bigint,
  channelId: bigint,
): string {
  return path.join(tsFilesDir, `virtualserver_${virtualServerId}`, `channel_${channelId}`);
}

/** Map a TS file-repo path (`/foo/bar.md`) to an absolute path under the channel dir. */
export function diskPathForChannelFile(channelDir: string, filePath: string): string {
  const rel = filePath.replace(/^\/+/, "");
  const resolved = path.resolve(channelDir, rel);
  const base = path.resolve(channelDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("path escapes channel file directory");
  }
  return resolved;
}

/** One file entry discovered on disk (relative path mirrors the TS file-repo path). */
export interface DiskChannelEntry {
  filePath: string;
  file: ChannelFile;
}

/**
 * Recursively list files under a channel's on-disk directory. `filePath` uses the
 * same `/`-rooted shape as TS `ftgetfilelist` (e.g. `/recruitment spiel.md`).
 */
export async function listDiskChannelFiles(
  channelDir: string,
  dirPath = "/",
  depth = 0,
  maxDepth = 8,
): Promise<DiskChannelEntry[]> {
  const absDir = diskPathForChannelFile(channelDir, dirPath);
  let names: string[];
  try {
    names = await fs.readdir(absDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }

  const out: DiskChannelEntry[] = [];
  for (const name of names) {
    const filePath = dirPath === "/" ? `/${name}` : `${dirPath.replace(/\/+$/, "")}/${name}`;
    const abs = diskPathForChannelFile(channelDir, filePath);
    const st = await fs.stat(abs);
    if (st.isDirectory()) {
      if (depth < maxDepth) {
        out.push(...(await listDiskChannelFiles(channelDir, filePath, depth + 1, maxDepth)));
      }
      continue;
    }
    if (!st.isFile()) continue;
    out.push({
      filePath,
      file: {
        name,
        size: BigInt(st.size),
        datetime: Math.floor(st.mtimeMs / 1000),
        type: 1,
      },
    });
  }
  return out;
}

/** Read a channel file from disk with a byte cap (mirrors the FT download cap). */
export async function readDiskChannelFile(absPath: string, cap: number): Promise<Buffer> {
  const st = await fs.stat(absPath);
  if (st.size > cap) throw new Error(`file too large (${st.size} bytes, cap ${cap})`);
  return fs.readFile(absPath);
}
