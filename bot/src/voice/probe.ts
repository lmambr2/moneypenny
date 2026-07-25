import { fetchJson } from "../util/http.js";
import { HttpTtsClient } from "./tts.js";

/** Probe a sidecar GET /health endpoint. */
export async function probeHttpHealth(baseUrl: string, timeoutMs = 5000): Promise<boolean> {
  const url = baseUrl.replace(/\/$/, "");
  try {
    const data = await fetchJson<{ ok?: boolean }>(`${url}/health`, { timeoutMs });
    return !!data?.ok;
  } catch {
    return false;
  }
}

/** Probe TTS with a one-word synthesis request. */
export async function probeHttpTts(
  baseUrl: string,
  voice: string,
  timeoutMs = 15000,
): Promise<boolean> {
  try {
    const client = new HttpTtsClient({ url: baseUrl, voice, timeoutMs });
    const { audio } = await client.synthesize("ok");
    return audio.length > 0;
  } catch {
    return false;
  }
}

/** @deprecated Use probeHttpTts */
export const probeKokoroTts = probeHttpTts;

/** Probe STT with a minimal non-silent PCM buffer. */
export async function probeHttpStt(baseUrl: string, timeoutMs = 10000): Promise<boolean> {
  const url = baseUrl.replace(/\/$/, "");
  try {
    const pcm = Buffer.alloc(256, 1);
    const data = await fetchJson<{ text?: string }>(`${url}/asr`, {
      method: "POST",
      timeoutMs,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Sample-Rate": "16000",
        "X-Channels": "1",
      },
      body: new Uint8Array(pcm),
    });
    return typeof data?.text === "string";
  } catch {
    return false;
  }
}

/** @deprecated Use probeHttpStt */
export const probeSherpaStt = probeHttpStt;
