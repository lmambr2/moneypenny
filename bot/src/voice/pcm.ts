/** Opus DTX / comfort-noise frames — boosting these drowns out real speech in STT. */
export const MIN_PCM_BOOST_PEAK = 80;

/** Moonshine sweet spot — leave headroom below int16 clip. */
export const STT_TARGET_PEAK = 12_000;

/** Samples at or above this are treated as clipped/hot and attenuated, never boosted. */
export const STT_CLIP_PEAK = 24_000;

/** Peak absolute amplitude of 16-bit LE PCM (0..32768). */
export function peakAmplitude16(pcm: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const s = Math.abs(pcm.readInt16LE(i));
    if (s > peak) peak = s;
  }
  return peak;
}

/** True when decoded PCM is pinned at int16 limits (Opus/TS hot level or prior clip). */
export function isPcmClipped(pcm: Buffer, threshold = 30_000): boolean {
  return peakAmplitude16(pcm) >= threshold;
}

/**
 * Scale 16-bit LE PCM by gain with hard clamp (implicit limiter).
 */
function scalePcm16(pcm: Buffer, gain: number): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const boosted = Math.round(pcm.readInt16LE(i) * gain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, boosted)), i);
  }
  return out;
}

/**
 * Prepare TeamSpeak-decoded PCM for STT:
 * - ignore DTX comfort noise (no boost)
 * - boost quiet real speech toward STT_TARGET_PEAK
 * - attenuate hot/clipped input instead of passing it through saturated
 */
export function normalizePcmForStt(
  pcm: Buffer,
  targetPeak = STT_TARGET_PEAK,
  maxGain = 120,
  minBoostPeak = MIN_PCM_BOOST_PEAK,
): Buffer {
  const peak = peakAmplitude16(pcm);
  if (peak < minBoostPeak) return pcm;

  let gain: number;
  if (peak >= STT_CLIP_PEAK) {
    // Hot/clipped mic — attenuate aggressively; never boost distorted frames.
    gain = (targetPeak * 0.65) / peak;
  } else if (peak > targetPeak) {
    gain = targetPeak / peak;
  } else {
    gain = Math.min(targetPeak / peak, maxGain);
  }

  if (gain >= 0.98 && gain <= 1.02) return pcm;
  return scalePcm16(pcm, gain);
}