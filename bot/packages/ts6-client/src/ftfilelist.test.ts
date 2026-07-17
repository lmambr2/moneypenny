import { describe, expect, it } from "vitest";
import { extractFileRows, parseFtFileList } from "./client.js";

describe("parseFtFileList", () => {
  it("coerces TS3 string rows into typed entries", () => {
    const rows = [
      { cid: "5", path: "/", name: "intsum.md", size: "2048", datetime: "1700000000", type: "1" },
      { cid: "5", path: "/", name: "subdir", size: "0", datetime: "1700000001", type: "0" },
    ];
    const out = parseFtFileList(rows);
    expect(out).toEqual([
      { name: "intsum.md", size: 2048n, datetime: 1700000000, type: 1 },
      { name: "subdir", size: 0n, datetime: 1700000001, type: 0 },
    ]);
    expect(typeof out[0].size).toBe("bigint");
  });

  it("drops rows with no name and tolerates missing/garbage fields", () => {
    const out = parseFtFileList([
      { name: "", size: "10", type: "1" } as any,
      { name: "ok.flac", size: "not-a-number", type: "1" } as any,
      { name: "bare.mp3" } as any,
    ]);
    expect(out.map((f) => f.name)).toEqual(["ok.flac", "bare.mp3"]);
    expect(out[0].size).toBe(0n); // garbage size → 0n, not a throw
    expect(out[1]).toMatchObject({ size: 0n, datetime: 0, type: 1 }); // defaults
  });

  it("returns [] for empty/nullish input", () => {
    expect(parseFtFileList([])).toEqual([]);
    expect(parseFtFileList(null as any)).toEqual([]);
  });

  it("coerces TS6 HTTP-query rows where size/type are JSON numbers", () => {
    const rows = [
      { name: "recruitment spiel.md", size: 1234, datetime: 1700000000, type: 1 },
      { name: "sub", size: 0, datetime: 1700000001, type: 0 },
    ];
    const out = parseFtFileList(rows as any);
    expect(out).toEqual([
      { name: "recruitment spiel.md", size: 1234n, datetime: 1700000000, type: 1 },
      { name: "sub", size: 0n, datetime: 1700000001, type: 0 },
    ]);
  });
});

describe("extractFileRows (TS6 HTTP-query envelope)", () => {
  it("pulls rows from the { body: [...] } wrapper", () => {
    const body = { status: { code: 0, message: "ok" }, body: [{ name: "a.md", type: 1 }] };
    expect(extractFileRows(body)).toEqual([{ name: "a.md", type: 1 }]);
  });

  it("accepts a bare array", () => {
    expect(extractFileRows([{ name: "b.mp3" }])).toEqual([{ name: "b.mp3" }]);
  });

  it("returns [] for an error envelope / non-list body", () => {
    expect(
      extractFileRows({ status: { code: 1281, message: "database empty result set" } }),
    ).toEqual([]);
    expect(extractFileRows("nope")).toEqual([]);
    expect(extractFileRows(null)).toEqual([]);
  });
});
