/**
 * Talker PCM → dedicated Opus (K14). 24 kHz mono in, 48 kHz stereo 20 ms out.
 * Does not touch the music player's encoder. Sends only while the floor allows.
 */
import { PCM_FRAME_BYTES } from "../audio/encoder.js";

export interface OpusFrameEncoder {
  encode(pcm: Buffer): Buffer;
}

/** Duplicate each 24 kHz mono sample into a 48 kHz stereo pair. */
export function talkerMono24kToStereo48k(pcm: Buffer): Buffer {
  const samples = Math.floor(pcm.length / 2);
  const out = Buffer.alloc(samples * 8);
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2);
    const base = i * 8;
    out.writeInt16LE(s, base);
    out.writeInt16LE(s, base + 2);
    out.writeInt16LE(s, base + 4);
    out.writeInt16LE(s, base + 6);
  }
  return out;
}

/** 48 kHz interleaved → 24 kHz mono (left if stereo). For user PCM into the Talker. */
export function downsample48kTo24kMono(pcm: Buffer, channels: number): Buffer {
  const ch = Math.max(1, channels | 0);
  const frameBytes = ch * 2;
  const frames = Math.floor(pcm.length / frameBytes);
  const outFrames = Math.floor(frames / 2);
  const out = Buffer.alloc(outFrames * 2);
  for (let i = 0; i < outFrames; i++) {
    out.writeInt16LE(pcm.readInt16LE(i * 2 * frameBytes), i * 2);
  }
  return out;
}

export class DuplexPcmPump {
  private pending = Buffer.alloc(0);

  constructor(
    private encoder: OpusFrameEncoder,
    private send: (opus: Buffer) => void,
    private allowsSend: () => boolean,
  ) {}

  pushTalkerPcm(mono24k: Buffer): number {
    if (!this.allowsSend() || mono24k.length < 2) {
      this.pending = Buffer.alloc(0);
      return 0;
    }
    this.pending = Buffer.concat([this.pending, talkerMono24kToStereo48k(mono24k)]);
    let sent = 0;
    while (this.pending.length >= PCM_FRAME_BYTES) {
      if (!this.allowsSend()) {
        this.pending = Buffer.alloc(0);
        return sent;
      }
      const frame = Buffer.from(this.pending.subarray(0, PCM_FRAME_BYTES));
      this.pending = this.pending.subarray(PCM_FRAME_BYTES);
      this.send(this.encoder.encode(frame));
      sent += 1;
    }
    return sent;
  }
}
