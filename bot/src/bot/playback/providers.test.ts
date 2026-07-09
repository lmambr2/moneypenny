import { describe, expect, it } from "vitest";
import type { MusicProvider } from "../../music/provider.js";
import { extractMediaId, pickProvider } from "./providers.js";

function stub(
  platform: MusicProvider["platform"],
  canHandle?: (q: string) => boolean,
): MusicProvider {
  return { platform, canHandle } as unknown as MusicProvider;
}

describe("playback/providers", () => {
  it("extractMediaId pulls ids from URLs", () => {
    expect(extractMediaId("https://example.com/track?id=12345")).toBe("12345");
    expect(extractMediaId("https://example.com/album/999")).toBe("999");
    expect(extractMediaId("plain")).toBe("plain");
  });

  it("pickProvider honors flags before auto-routing", () => {
    const local = stub("local");
    const youtube = stub("youtube", (q) => q.includes("youtu"));
    const stream = stub("stream");
    expect(pickProvider(new Set(["y"]), local, youtube, stream).platform).toBe("youtube");
    expect(pickProvider(new Set(), local, youtube, stream, "https://youtu.be/x").platform).toBe(
      "youtube",
    );
    expect(pickProvider(new Set(), local, youtube, stream, "local only").platform).toBe("local");
  });
});
