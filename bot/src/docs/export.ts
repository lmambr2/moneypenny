import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Supported Pandoc output formats (DESIGN §R3). */
export type ExportFormat = "docx" | "pdf";

export class ExportError extends Error {
  constructor(
    public readonly code: "PANDOC_UNAVAILABLE" | "EMPTY" | "PANDOC_FAILED" | "INVALID_FORMAT",
    message: string,
  ) {
    super(message);
    this.name = "ExportError";
  }
}

const FORMAT_META: Record<
  ExportFormat,
  { ext: string; mime: string; pandocArgs: string[] }
> = {
  docx: {
    ext: ".docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pandocArgs: [],
  },
  pdf: {
    ext: ".pdf",
    mime: "application/pdf",
    pandocArgs: [],
  },
};

let pandocAvailable: boolean | null = null;

/** Test hook — reset cached pandoc probe between unit tests. */
export function resetPandocProbe(): void {
  pandocAvailable = null;
}

/** True when `pandoc` is on PATH and responds to `--version`. */
export async function isPandocAvailable(): Promise<boolean> {
  if (pandocAvailable != null) return pandocAvailable;
  try {
    await execFileAsync("pandoc", ["--version"], { timeout: 5000 });
    pandocAvailable = true;
  } catch {
    pandocAvailable = false;
  }
  return pandocAvailable;
}

/** Drop the deterministic citation footer before export or doctrine save. */
export function stripSourcesFooter(text: string): string {
  const marker = "\n\n📎 Sources:";
  const idx = text.indexOf(marker);
  return idx >= 0 ? text.slice(0, idx) : text;
}

/** Normalize markdown body for Pandoc (strip chat footers, trim). */
export function prepareMarkdownForExport(markdown: string): string {
  return stripSourcesFooter(markdown).trim();
}

/** Suggested download filename from a doctrine source path. */
export function exportFilename(source: string, format: ExportFormat): string {
  const base =
    source
      .replace(/\\/g, "/")
      .replace(/\.(md|markdown)$/i, "")
      .split("/")
      .pop() || "document";
  return `${base}${FORMAT_META[format].ext}`;
}

export function parseExportFormat(raw: unknown): ExportFormat | null {
  if (raw === "docx" || raw === "pdf") return raw;
  return null;
}

/**
 * Convert markdown to docx/pdf via Pandoc. Writes temp files under os.tmpdir();
 * never persists exports on disk beyond the call.
 */
export async function exportMarkdown(markdown: string, format: ExportFormat): Promise<Buffer> {
  if (!(await isPandocAvailable())) {
    throw new ExportError("PANDOC_UNAVAILABLE", "pandoc is not installed or not on PATH");
  }

  const body = prepareMarkdownForExport(markdown);
  if (!body) throw new ExportError("EMPTY", "document is empty");

  const meta = FORMAT_META[format];
  const dir = await mkdtemp(join(tmpdir(), "moneypenny-export-"));
  const inPath = join(dir, "input.md");
  const outPath = join(dir, `output${meta.ext}`);

  try {
    await writeFile(inPath, body, "utf8");
    await execFileAsync("pandoc", [inPath, "-o", outPath, ...meta.pandocArgs], {
      timeout: 60_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return await readFile(outPath);
  } catch (err) {
    if (err instanceof ExportError) throw err;
    const msg = err instanceof Error ? err.message : "pandoc export failed";
    throw new ExportError("PANDOC_FAILED", msg);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function exportContentType(format: ExportFormat): string {
  return FORMAT_META[format].mime;
}