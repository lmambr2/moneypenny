/**
 * Multi-service network bind posture (DESIGN §11 / hardening).
 * Parses shipped docker-compose.yml so localhost-only publishes cannot drift.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Services that must publish to the host only on loopback (not 0.0.0.0). */
const LOCALHOST_PUBLISH_SERVICES = [
  "bot",
  "ollama",
  "rkllama",
  "stt-whisper",
  "stt-mock",
  "piper-tts",
  "spotify-bridge",
  "mempalace-bridge",
] as const;

/**
 * Extract `ports:` list items under a top-level compose service block.
 * Minimal YAML scrape — good enough for our hand-written compose files.
 */
export function extractServicePortMappings(composeYaml: string, service: string): string[] {
  const lines = composeYaml.split("\n");
  const svcRe = new RegExp(`^  ${service}:\\s*$`);
  let i = 0;
  while (i < lines.length && !svcRe.test(lines[i])) i++;
  if (i >= lines.length) return [];
  i++;
  // Collect until next top-level service (two-space key) or end
  const block: string[] = [];
  while (i < lines.length) {
    const line = lines[i];
    if (/^  [a-zA-Z0-9_-]+:\s*$/.test(line) && !line.startsWith("    ")) break;
    if (/^  [a-zA-Z0-9_-]+:\s*$/.test(line)) break;
    block.push(line);
    i++;
  }
  const text = block.join("\n");
  const portsIdx = text.search(/^\s{4}ports:\s*$/m);
  if (portsIdx < 0) return [];
  const after = text.slice(portsIdx).split("\n").slice(1);
  const mappings: string[] = [];
  for (const line of after) {
    if (/^\s{4}[a-zA-Z]/.test(line) && !line.trimStart().startsWith("-")) break;
    if (/^\s{2}[a-zA-Z]/.test(line) && !/^\s{4}/.test(line)) break;
    const m = line.match(/^\s+-\s*"?([^"#\n]+)"?/);
    if (m) mappings.push(m[1].trim());
  }
  return mappings;
}

function isLoopbackHostPublish(mapping: string): boolean {
  // "127.0.0.1:3000:3000" or "127.0.0.1:9001:9000"
  return mapping.startsWith("127.0.0.1:");
}

describe("docker-compose bind posture (multi-service)", () => {
  const compose = readFileSync(join(REPO_ROOT, "docker-compose.yml"), "utf-8");

  for (const svc of LOCALHOST_PUBLISH_SERVICES) {
    it(`${svc} host publish is loopback-only`, () => {
      const ports = extractServicePortMappings(compose, svc);
      expect(ports.length, `${svc} should publish at least one port`).toBeGreaterThan(0);
      for (const p of ports) {
        expect(isLoopbackHostPublish(p), `${svc} port mapping must be 127.0.0.1:… got ${p}`).toBe(
          true,
        );
      }
    });
  }

  it("qdrant and tidal-bridge stay off host publish (bridge-only)", () => {
    expect(extractServicePortMappings(compose, "qdrant")).toEqual([]);
    expect(extractServicePortMappings(compose, "tidal-bridge")).toEqual([]);
  });

  it("optional teamspeak profile publishes voice/query on all interfaces (intentional)", () => {
    const ports = extractServicePortMappings(compose, "teamspeak");
    expect(ports.some((p) => p.includes("9987"))).toBe(true);
    // Must NOT be loopback-only — clients need to reach the server
    expect(ports.every(isLoopbackHostPublish)).toBe(false);
  });

  it("ACE-Step overlay defaults to loopback host publish", () => {
    const ace = readFileSync(join(REPO_ROOT, "docker-compose.ace-step.yml"), "utf-8");
    const ports = extractServicePortMappings(ace, "ace-step");
    expect(ports.length).toBeGreaterThan(0);
    // Default ACE_STEP_PUBLISH=127.0.0.1 (audit M-2026-07-09-5 closed)
    expect(ports.some((p) => p.includes("127.0.0.1"))).toBe(true);
  });
});
