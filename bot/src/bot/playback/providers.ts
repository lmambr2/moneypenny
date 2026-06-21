import type { MusicProvider } from "../../music/provider.js";

/** Pick a music provider from command flags and optional query auto-routing. */
export function pickProvider(
  flags: Set<string>,
  local: MusicProvider,
  youtube: MusicProvider,
  stream: MusicProvider,
  query?: string,
): MusicProvider {
  if (flags.has("l")) return local;
  if (flags.has("y")) return youtube;
  if (flags.has("s")) return stream;
  if (query) {
    const yp = youtube as MusicProvider & { canHandle?: (q: string) => boolean };
    if (yp.canHandle?.(query)) return youtube;
    const sp = stream as MusicProvider & { canHandle?: (q: string) => boolean };
    if (sp.canHandle?.(query)) return stream;
  }
  return local;
}

export function providerForPlatform(
  platform: "local" | "youtube" | "stream",
  local: MusicProvider,
  youtube: MusicProvider,
  stream: MusicProvider,
): MusicProvider {
  if (platform === "youtube") return youtube;
  if (platform === "stream") return stream;
  return local;
}

/** Extract a numeric media id from a URL or pass through the raw input. */
export function extractMediaId(input: string): string {
  const match = input.match(/[?&]id=(\d+)/);
  if (match) return match[1];
  const pathMatch = input.match(/\/(\d+)/);
  if (pathMatch) return pathMatch[1];
  return input;
}