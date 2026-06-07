import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAvatarStore } from "./avatars.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "avatar-test-"));
});

describe("createAvatarStore", () => {
  it("write returns a relative path under the store dir", () => {
    const store = createAvatarStore(dir);
    const buf = Buffer.from("fake-png");
    const rel = store.write("bot-1", "image/png", buf);
    expect(rel).toBe("bot-1.png");
    expect(readFileSync(join(dir, "bot-1.png")).equals(buf)).toBe(true);
  });

  it("write picks correct extension for jpeg / webp", () => {
    const store = createAvatarStore(dir);
    expect(store.write("a", "image/jpeg", Buffer.from(""))).toBe("a.jpg");
    expect(store.write("b", "image/webp", Buffer.from(""))).toBe("b.webp");
  });

  it("write rejects unsupported MIME types", () => {
    const store = createAvatarStore(dir);
    expect(() => store.write("c", "image/gif", Buffer.from(""))).toThrow(/unsupported/i);
  });

  it("read returns the bytes for an existing file", () => {
    const store = createAvatarStore(dir);
    store.write("bot-1", "image/png", Buffer.from("hello"));
    const buf = store.read("bot-1.png");
    expect(buf?.equals(Buffer.from("hello"))).toBe(true);
  });

  it("read returns null when path is missing", () => {
    const store = createAvatarStore(dir);
    expect(store.read("missing.png")).toBeNull();
  });

  it("remove deletes the file (idempotent)", () => {
    const store = createAvatarStore(dir);
    store.write("bot-1", "image/png", Buffer.from("x"));
    store.remove("bot-1.png");
    expect(existsSync(join(dir, "bot-1.png"))).toBe(false);
    expect(() => store.remove("bot-1.png")).not.toThrow();
  });

  it("write replaces any existing file for the same botId regardless of old extension", () => {
    const store = createAvatarStore(dir);
    store.write("bot-1", "image/png", Buffer.from("old"));
    const rel = store.write("bot-1", "image/jpeg", Buffer.from("new"));
    expect(rel).toBe("bot-1.jpg");
    expect(existsSync(join(dir, "bot-1.png"))).toBe(false);
    expect(existsSync(join(dir, "bot-1.jpg"))).toBe(true);
  });
});
