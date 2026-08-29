//! s16le PCM helpers: peak, RMS, scale, mix, playback duck, STT normalize.

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Matches `voice/pcm.ts`.
pub const MIN_PCM_BOOST_PEAK: u32 = 80;
pub const STT_TARGET_PEAK: u32 = 12_000;
pub const STT_CLIP_PEAK: u32 = 24_000;
pub const CLIP_DISPLAY_PEAK: u32 = 30_000;

/// Historical player curve: slider 100 → factor 0.2.
pub const PLAYBACK_VOLUME_CURVE: f64 = 0.2;

pub(crate) fn samples_i16(bytes: &[u8]) -> Result<&[i16]> {
  if !bytes.len().is_multiple_of(2) {
    return Err(Error::from_reason("PCM length must be even (s16le)"));
  }
  let ptr = bytes.as_ptr() as *const i16;
  let len = bytes.len() / 2;
  // Safety: even length, s16le view of the Node buffer for this call only.
  Ok(unsafe { std::slice::from_raw_parts(ptr, len) })
}

pub(crate) fn peak_i16(samples: &[i16]) -> u32 {
  let mut peak: u32 = 0;
  for &s in samples {
    let a = (s as i32).unsigned_abs();
    if a > peak {
      peak = a;
    }
  }
  peak
}

pub(crate) fn rms_i16(samples: &[i16]) -> f64 {
  if samples.is_empty() {
    return 0.0;
  }
  let mut sum_sq = 0.0;
  for &s in samples {
    let v = f64::from(s);
    sum_sq += v * v;
  }
  (sum_sq / samples.len() as f64).sqrt()
}

fn scale_sample(s: i16, gain: f64) -> i16 {
  let v = (f64::from(s) * gain).round();
  v.clamp(-32768.0, 32767.0) as i16
}

pub(crate) fn scale_to_vec(samples: &[i16], gain: f64) -> Vec<u8> {
  let mut out = vec![0u8; samples.len() * 2];
  for (i, &s) in samples.iter().enumerate() {
    let bytes = scale_sample(s, gain).to_le_bytes();
    out[i * 2] = bytes[0];
    out[i * 2 + 1] = bytes[1];
  }
  out
}

pub(crate) fn stt_gain(peak: u32, target_peak: u32, max_gain: f64, min_boost: u32) -> Option<f64> {
  if peak < min_boost {
    return None;
  }
  let peak_f = f64::from(peak);
  let target = f64::from(target_peak);
  let gain = if peak >= STT_CLIP_PEAK {
    (target * 0.65) / peak_f
  } else if peak > target_peak {
    target / peak_f
  } else {
    (target / peak_f).min(max_gain)
  };
  if (0.98..=1.02).contains(&gain) {
    None
  } else {
    Some(gain)
  }
}

/// Peak absolute amplitude of interleaved s16le PCM (0..32768).
#[napi]
pub fn pcm_peak(pcm: Buffer) -> Result<u32> {
  Ok(peak_i16(samples_i16(pcm.as_ref())?))
}

/// RMS energy of interleaved s16le PCM (0..32768 scale).
#[napi]
pub fn pcm_rms(pcm: Buffer) -> Result<f64> {
  Ok(rms_i16(samples_i16(pcm.as_ref())?))
}

/// True when RMS is at or above the speech threshold (default 500 matches TS SilenceSegmenter).
#[napi]
pub fn is_speech_frame(pcm: Buffer, energy_threshold: f64) -> Result<bool> {
  Ok(pcm_rms(pcm)? >= energy_threshold)
}

/// Scale s16le PCM by gain with hard int16 clamp.
#[napi]
pub fn pcm_scale(pcm: Buffer, gain: f64) -> Result<Buffer> {
  if !gain.is_finite() {
    return Err(Error::from_reason("gain must be finite"));
  }
  let samples = samples_i16(pcm.as_ref())?;
  Ok(Buffer::from(scale_to_vec(samples, gain)))
}

/// Mix two s16le buffers: `clamp(a*gain_a + b*gain_b)`. Length is max(a,b); the
/// shorter side is treated as zeros past its end.
#[napi]
pub fn pcm_mix(a: Buffer, gain_a: f64, b: Buffer, gain_b: f64) -> Result<Buffer> {
  if !gain_a.is_finite() || !gain_b.is_finite() {
    return Err(Error::from_reason("gains must be finite"));
  }
  let sa = samples_i16(a.as_ref())?;
  let sb = samples_i16(b.as_ref())?;
  let n = sa.len().max(sb.len());
  let mut out = vec![0u8; n * 2];
  for i in 0..n {
    let va = if i < sa.len() {
      f64::from(sa[i]) * gain_a
    } else {
      0.0
    };
    let vb = if i < sb.len() {
      f64::from(sb[i]) * gain_b
    } else {
      0.0
    };
    let v = (va + vb).round().clamp(-32768.0, 32767.0) as i16;
    let bytes = v.to_le_bytes();
    out[i * 2] = bytes[0];
    out[i * 2 + 1] = bytes[1];
  }
  Ok(Buffer::from(out))
}

/// Apply the AudioPlayer volume curve (slider 0–100, optional STT duck, speech floor).
///
/// `factor = effective/100 * 0.2`. Duck, when active, uses `max(duck_level, floor)`;
/// otherwise `max(volume_pct, floor)`. Floor beats duck so radio bumpers stay audible.
#[napi]
pub fn pcm_apply_playback_gain(
  pcm: Buffer,
  volume_pct: f64,
  duck_active: bool,
  duck_level: f64,
  floor_pct: f64,
) -> Result<Buffer> {
  let vol = volume_pct.clamp(0.0, 100.0);
  let duck = duck_level.clamp(0.0, 100.0);
  let floor = floor_pct.clamp(0.0, 100.0);
  let base = vol.max(floor);
  let effective = if duck_active { duck.max(floor) } else { base };
  let factor = (effective / 100.0) * PLAYBACK_VOLUME_CURVE;
  if factor >= 0.999 {
    return Ok(Buffer::from(pcm.to_vec()));
  }
  pcm_scale(pcm, factor)
}

/// Prepare TeamSpeak-decoded PCM for STT (same rules as `voice/pcm.ts`).
#[napi]
pub fn normalize_pcm_for_stt(
  pcm: Buffer,
  target_peak: u32,
  max_gain: f64,
  min_boost_peak: u32,
) -> Result<Buffer> {
  let samples = samples_i16(pcm.as_ref())?;
  let peak = peak_i16(samples);
  match stt_gain(peak, target_peak, max_gain, min_boost_peak) {
    None => Ok(Buffer::from(pcm.to_vec())),
    Some(gain) => Ok(Buffer::from(scale_to_vec(samples, gain))),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn peak_handles_i16_min() {
    let s = [i16::MIN];
    assert_eq!(peak_i16(&s), 32768);
  }

  #[test]
  fn stt_gain_skips_dtx() {
    assert_eq!(stt_gain(3, STT_TARGET_PEAK, 120.0, MIN_PCM_BOOST_PEAK), None);
  }

  #[test]
  fn stt_gain_boosts_quiet_speech() {
    let g = stt_gain(200, STT_TARGET_PEAK, 120.0, MIN_PCM_BOOST_PEAK).unwrap();
    assert!(g > 1.0);
  }
}
