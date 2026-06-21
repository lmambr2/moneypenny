import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { getDefaultConfig, loadConfig, saveConfig } from "./config.js";

describe("config", () => {
  const dirs: string[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "moneypenny-test-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("returns default config when file does not exist", () => {
    const config = loadConfig("/nonexistent/path/config.json");
    expect(config).toEqual(getDefaultConfig());
  });

  it("creates config file on save", () => {
    const dir = makeTmpDir();
    const path = join(dir, "sub", "config.json");
    const config = getDefaultConfig();
    saveConfig(path, config);

    const loaded = loadConfig(path);
    expect(loaded).toEqual(config);
  });

  it("defaults to a localhost-only bind address (safe by default, §11)", () => {
    expect(getDefaultConfig().bindAddress).toBe("127.0.0.1");
  });

  it("merges partial config with defaults", () => {
    const dir = makeTmpDir();
    const path = join(dir, "config.json");

    // Save a partial config by writing only some fields
    const partial = { webPort: 8080, locale: "en" };
    writeFileSync(path, JSON.stringify(partial), "utf-8");

    const loaded = loadConfig(path);
    expect(loaded.webPort).toBe(8080);
    expect(loaded.locale).toBe("en");
    // defaults should fill in the rest
    expect(loaded.theme).toBe("dark");
    expect(loaded.commandPrefix).toBe("!");
    expect(loaded.autoPauseOnEmpty).toBe(true);
  });
});
