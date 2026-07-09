/**
 * TTS loudness normalization. Kokoro's raw output sits well below mastered
 * music (≈ −24 LUFS vs ≈ −14), so spoken replies and radio bumpers sound
 * "way quieter than the music" through the same player. One ffmpeg loudnorm
 * pass at synthesis time brings speech to music level; radio's bumper cache
 * then stores the normalized audio, so it costs once per line.
 *
 * Fail-open: any ffmpeg problem returns the original buffer — normalization
 * must never be the reason speech doesn't play (§14 spirit).
 */
import { spawn } from "node:child_process";
import { getFfmpegCommand } from "../audio/player.js";
import type { Logger } from "../logger.js";

/** Streaming-music loudness target; keep speech at parity with the queue. */
const TARGET = "loudnorm=I=-14:TP=-1.5:LRA=11";

export function normalizeLoudness(audio: Buffer, format: string, logger?: Logger): Promise<Buffer> {
  return new Promise((resolve) => {
    const fmt = format.replace(/[^a-z0-9]/gi, "").toLowerCase() || "wav";
    const ff = spawn(
      getFfmpegCommand(),
      ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-af", TARGET, "-f", fmt, "pipe:1"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const out: Buffer[] = [];
    const bail = (why: string) => {
      logger?.warn({ why }, "TTS loudness normalization skipped — using raw audio");
      resolve(audio);
    };
    const timer = setTimeout(() => {
      ff.kill("SIGKILL");
      bail("timeout");
    }, 15_000);
    ff.stdout.on("data", (c: Buffer) => out.push(c));
    ff.on("error", (err) => {
      clearTimeout(timer);
      bail(String(err));
    });
    ff.on("close", (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      if (code === 0 && buf.length > 0) resolve(buf);
      else bail(`ffmpeg exit ${code}, ${buf.length} bytes`);
    });
    ff.stdin.on("error", () => {
      /* EPIPE when ffmpeg dies early — close handles it */
    });
    ff.stdin.end(audio);
  });
}
