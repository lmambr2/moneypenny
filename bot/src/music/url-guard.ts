/**
 * SSRF guard for URLs passed to ffmpeg / yt-dlp / outbound HTTP.
 * Blocks loopback, link-local, cloud metadata, private ranges, and Docker-internal hostnames.
 */

import { lookup } from "node:dns/promises";

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
  "stt-whisper",
  "piper-tts",
  "mempalace-bridge",
  "tidal-bridge",
  "spotify-bridge",
  "ace-step",
  "teamspeak",
  "turbovec",
  "host.docker.internal",
  "metadata.google.internal",
  "metadata",
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
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/** Parse IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:aabb:ccdd). */
function ipv4MappedFromV6(host: string): number[] | null {
  const h = host.toLowerCase();
  const dotted = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return parseIpv4(dotted[1]);
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
  }
  return null;
}

function isUnspecifiedIpv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::" || h === "::0" || h === "0:0:0:0:0:0:0:0") return true;
  // Compressed leftovers Node still hands us as "::".
  return /^0(:0)+$/.test(h);
}

function isBlockedIpv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (isUnspecifiedIpv6(h)) return true; // [::] binds/connects locally
  if (h.startsWith("fe80:")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // ULA
  if (h.startsWith("ff")) return true; // multicast
  const mapped = ipv4MappedFromV6(h);
  if (mapped) return isPrivateOrReservedIpv4(mapped);
  return false;
}

function hostIsBlockedLiteral(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (BLOCKED_HOSTNAMES.has(h)) return true;

  const ipv4 = parseIpv4(h);
  if (ipv4) return isPrivateOrReservedIpv4(ipv4);
  if (h.includes(":")) return isBlockedIpv6(h);
  return false;
}

/** True when the hostname/IP literal itself is not a private/reserved target. */
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
  if (hostIsBlockedLiteral(host)) return false;

  // Non-literal hostnames: allow here; callers that need DNS rebinding protection
  // should use assertPublicPlaybackUrl (resolves A/AAAA).
  return true;
}

/**
 * Like isPublicPlaybackUrl, but also resolves the hostname and rejects if any
 * address is private/reserved. Use before ffmpeg/yt-dlp on user-supplied URLs
 * and on final stream/CDN hops (DNS rebinding defense).
 */
export async function assertPublicPlaybackUrl(input: string): Promise<boolean> {
  if (!isPublicPlaybackUrl(input)) return false;
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // Literal IPs already checked by isPublicPlaybackUrl.
  if (parseIpv4(host) || host.includes(":")) return true;

  try {
    const records = await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("dns lookup timeout")), 1500),
      ),
    ]);
    if (!records.length) return false;
    for (const r of records) {
      if (r.family === 4) {
        const octets = parseIpv4(r.address);
        if (!octets || isPrivateOrReservedIpv4(octets)) return false;
      } else if (r.family === 6) {
        if (isBlockedIpv6(r.address)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * True for a MUSIC_DIR filesystem path. Rejects URL schemes (file:, rtmp:, …)
 * and protocol-relative / UNC targets that ffmpeg would open as a network I/O.
 */
export function isLocalLibraryPath(input: string): boolean {
  const s = input.trim();
  if (!s) return false;
  if (s.includes("://")) return false;
  if (s.startsWith("//") || s.startsWith("\\\\")) return false;
  // `file:/etc/passwd` (one slash) and other scheme: forms, but not `C:\music`.
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[a-zA-Z]:[\\/]/.test(s)) return false;
  return true;
}

/**
 * Final gate before handing a URL to ffmpeg / axios playback.
 * Fail-closed on DNS error or private resolution (DNS rebinding defense).
 * Local filesystem paths (non-http) are allowed for library playback.
 */
export async function assertSafePlaybackTarget(input: string): Promise<boolean> {
  const s = input.trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return assertPublicPlaybackUrl(s);
  return isLocalLibraryPath(s);
}
