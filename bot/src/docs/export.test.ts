import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const execFileMock = vi.mocked(execFile);

function mockExec(cb: (err: Error | null, stdout?: string) => void): ChildProcess {
  return {} as ChildProcess;
}

import {
  exportFilename,
  exportMarkdown,
  isPandocAvailable,
  prepareMarkdownForExport,
  resetPandocProbe,
  stripSourcesFooter,
} from "./export.js";

describe("docs/export", () => {
  beforeEach(() => {
    resetPandocProbe();
    execFileMock.mockReset();
  });

  afterEach(() => {
    resetPandocProbe();
  });

  it("stripSourcesFooter removes citation block", () => {
    expect(stripSourcesFooter("# Doc\n\nbody\n\n📎 Sources: a.md")).toBe("# Doc\n\nbody");
  });

  it("exportFilename derives basename with extension", () => {
    expect(exportFilename("intel/intsum-2026-06-21.md", "docx")).toBe("intsum-2026-06-21.docx");
  });

  it("prepareMarkdownForExport trims and strips sources", () => {
    expect(prepareMarkdownForExport("  # Hi\n\n📎 Sources: x  ")).toBe("# Hi");
  });

  it("isPandocAvailable caches probe result", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as (err: null, stdout: string) => void)(null, "pandoc 3.0");
      return mockExec(() => {});
    });
    await expect(isPandocAvailable()).resolves.toBe(true);
    await expect(isPandocAvailable()).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("exportMarkdown throws when pandoc is missing", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as (err: Error) => void)(new Error("ENOENT"));
      return mockExec(() => {});
    });
    await expect(exportMarkdown("# Doc", "docx")).rejects.toMatchObject({
      code: "PANDOC_UNAVAILABLE",
    });
  });

  it("exportMarkdown runs pandoc and returns output bytes", async () => {
    let call = 0;
    execFileMock.mockImplementation((cmd, args, _opts, cb) => {
      call++;
      if (call === 1 && cmd === "pandoc" && (args as string[])[0] === "--version") {
        (cb as (err: null, stdout: string) => void)(null, "pandoc 3.0");
        return mockExec(() => {});
      }
      if (call === 2 && cmd === "pandoc" && (args as string[]).includes("-o")) {
        const outPath = (args as string[])[(args as string[]).indexOf("-o") + 1];
        void import("node:fs/promises").then(({ writeFile }) =>
          writeFile(outPath, Buffer.from("PK-docx")),
        ).then(() => {
          (cb as (err: null) => void)(null);
        });
        return mockExec(() => {});
      }
      (cb as (err: Error) => void)(new Error(`unexpected execFile call ${call}`));
      return mockExec(() => {});
    });

    const buf = await exportMarkdown("---\nclassification: secret\n---\n\n# INTSUM", "docx");
    expect(buf.toString()).toBe("PK-docx");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});