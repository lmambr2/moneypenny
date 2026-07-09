/**
 * Dashboard recording store — admin capture/upload under a contained data dir.
 * Never auto-promotes into radio bumper / private memory pools.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";

const ALLOWED_EXT = new Set([".webm", ".ogg", ".wav", ".mp3", ".m4a", ".opus"]);

export interface RecordingMeta {
  id: string;
  filename: string;
  bytes: number;
  createdAt: number;
  mime?: string;
}

export function safeRecordingBasename(name: string): string | null {
  const raw = String(name || "").trim();
  if (!raw) return null;
  // Reject path separators / traversal in the *raw* name (basename alone would strip them).
  if (/[/\\]/.test(raw) || raw.includes("..")) return null;
  if (raw === "." || raw === "..") return null;
  const base = basename(raw);
  if (base !== raw) return null;
  const ext = extname(base).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return null;
  // Collapse odd characters
  const cleaned = base.replace(/[^\w.\-()+ ]+/g, "_").slice(0, 120);
  if (!cleaned || cleaned.startsWith(".")) return null;
  return cleaned;
}

export function recordingsRoot(dataDir: string): string {
  const root = resolve(join(dataDir, "recordings"));
  mkdirSync(root, { recursive: true });
  return root;
}

export function resolveRecordingPath(dataDir: string, filename: string): string | null {
  const safe = safeRecordingBasename(filename);
  if (!safe) return null;
  const root = recordingsRoot(dataDir);
  const full = resolve(join(root, safe));
  if (!full.startsWith(root + (root.endsWith("/") ? "" : "/")) && full !== root) {
    // ensure containment
    if (!full.startsWith(root)) return null;
  }
  if (!full.startsWith(root)) return null;
  return full;
}

export function writeRecording(
  dataDir: string,
  filename: string,
  bytes: Buffer,
  opts?: { mime?: string },
): RecordingMeta | null {
  const path = resolveRecordingPath(dataDir, filename);
  if (!path) return null;
  if (bytes.length === 0 || bytes.length > 50 * 1024 * 1024) return null;
  writeFileSync(path, bytes);
  const st = statSync(path);
  return {
    id: basename(path),
    filename: basename(path),
    bytes: st.size,
    createdAt: st.mtimeMs,
    mime: opts?.mime,
  };
}

export function listRecordings(dataDir: string): RecordingMeta[] {
  const root = recordingsRoot(dataDir);
  if (!existsSync(root)) return [];
  const out: RecordingMeta[] = [];
  for (const name of readdirSync(root)) {
    const safe = safeRecordingBasename(name);
    if (!safe) continue;
    const full = join(root, safe);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      out.push({
        id: safe,
        filename: safe,
        bytes: st.size,
        createdAt: st.mtimeMs,
      });
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function readRecording(dataDir: string, filename: string): Buffer | null {
  const path = resolveRecordingPath(dataDir, filename);
  if (!path || !existsSync(path)) return null;
  return readFileSync(path);
}

export function deleteRecording(dataDir: string, filename: string): boolean {
  const path = resolveRecordingPath(dataDir, filename);
  if (!path || !existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
