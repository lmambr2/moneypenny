/**
 * SSRF guard for URLs passed to ffmpeg / yt-dlp / axios.
 * Blocks loopback, link-local, cloud metadata, and Docker-internal hostnames.
 */

/** Sidecar hostnames from docker-compose — not valid public stream targets. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "qdrant",
  "ollama",
  "bot",
  "rkllama",
  "sherpa-stt",
  "kokoro",
  "stt-mock",
  "mempalace-bridge",
  "tidal-bridge",
  "teamspeak",
  "host.docker.internal",
  "metadata.google.internal",
]);

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function isPrivateOrReservedIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isBlockedIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1") return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  if (h.startsWith("fe80:")) return true;
  return false;
}

/** True when ffmpeg/yt-dlp may safely fetch this URL (no SSRF to internal services). */
export function isPublicPlaybackUrl(input: string): boolean {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (BLOCKED_HOSTNAMES.has(host)) return false;

  const ipv4 = parseIpv4(host);
  if (ipv4) return !isPrivateOrReservedIpv4(ipv4);
  if (host.includes(":")) return !isBlockedIpv6(host);

  return true;
}