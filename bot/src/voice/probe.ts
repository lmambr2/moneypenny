import axios from "axios";
import { KokoroTtsClient } from "./tts.js";

/** Probe a sidecar GET /health endpoint. */
export async function probeHttpHealth(baseUrl: string, timeoutMs = 5000): Promise<boolean> {
  const url = baseUrl.replace(/\/$/, "");
  try {
    const { data } = await axios.get(`${url}/health`, { timeout: timeoutMs });
    return !!data?.ok;
  } catch {
    return false;
  }
}

/** Probe Kokoro TTS with a one-word synthesis request. */
export async function probeKokoroTts(baseUrl: string, voice: string, timeoutMs = 15000): Promise<boolean> {
  try {
    const client = new KokoroTtsClient({ url: baseUrl, voice, timeoutMs });
    const { audio } = await client.synthesize("ok");
    return audio.length > 0;
  } catch {
    return false;
  }
}

/** Probe sherpa-style STT with a minimal non-silent PCM buffer. */
export async function probeSherpaStt(baseUrl: string, timeoutMs = 10000): Promise<boolean> {
  const url = baseUrl.replace(/\/$/, "");
  try {
    const pcm = Buffer.alloc(256, 1);
    const { data } = await axios.post(`${url}/asr`, pcm, {
      timeout: timeoutMs,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Sample-Rate": "16000",
        "X-Channels": "1",
      },
      responseType: "json",
    });
    return typeof data?.text === "string";
  } catch {
    return false;
  }
}