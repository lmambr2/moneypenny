//! Inbound TeamSpeak voice-frame helper: inspect + STT prep in one pass.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::pcm::{
  peak_i16, rms_i16, samples_i16, scale_to_vec, stt_gain, CLIP_DISPLAY_PEAK, MIN_PCM_BOOST_PEAK,
  STT_TARGET_PEAK,
};

#[napi(object)]
pub struct VoiceFrameAnalysis {
  pub peak: u32,
  pub rms: f64,
  pub speech: bool,
  pub clipped: bool,
}

#[napi(object)]
pub struct VoiceFrameProcessed {
  pub peak: u32,
  pub raw_peak: u32,
  pub rms: f64,
  pub speech: bool,
  pub clipped: bool,
  pub pcm_for_stt: Buffer,
}

/// One-shot inbound voice PCM helper (peak / RMS / clip / STT normalize).
///
/// Thresholds match `voice/pcm.ts` + `VoiceSession.MIN_SPEECH_PEAK`.
#[napi]
pub struct NativeVoiceFrame {
  speech_peak: u32,
  clip_peak: u32,
  stt_target: u32,
  max_gain: f64,
  min_boost: u32,
}

#[napi]
impl NativeVoiceFrame {
  #[napi(constructor)]
  pub fn new() -> Self {
    Self {
      speech_peak: MIN_PCM_BOOST_PEAK,
      clip_peak: CLIP_DISPLAY_PEAK,
      stt_target: STT_TARGET_PEAK,
      max_gain: 120.0,
      min_boost: MIN_PCM_BOOST_PEAK,
    }
  }

  #[napi]
  pub fn inspect(&self, pcm: Buffer) -> Result<VoiceFrameAnalysis> {
    let samples = samples_i16(pcm.as_ref())?;
    let peak = peak_i16(samples);
    Ok(VoiceFrameAnalysis {
      peak,
      rms: rms_i16(samples),
      speech: peak >= self.speech_peak,
      clipped: peak >= self.clip_peak,
    })
  }

  /// Normalize for STT; uses one peak scan (same as passing `knownPeak` in TS).
  #[napi]
  pub fn prepare_stt(&self, pcm: Buffer) -> Result<Buffer> {
    let samples = samples_i16(pcm.as_ref())?;
    let peak = peak_i16(samples);
    match stt_gain(peak, self.stt_target, self.max_gain, self.min_boost) {
      None => Ok(Buffer::from(pcm.to_vec())),
      Some(gain) => Ok(Buffer::from(scale_to_vec(samples, gain))),
    }
  }

  /// Inspect + STT prep without a second peak walk.
  #[napi]
  pub fn process(&self, pcm: Buffer) -> Result<VoiceFrameProcessed> {
    let samples = samples_i16(pcm.as_ref())?;
    let peak = peak_i16(samples);
    let rms = rms_i16(samples);
    let pcm_for_stt = match stt_gain(peak, self.stt_target, self.max_gain, self.min_boost) {
      None => pcm.to_vec(),
      Some(gain) => scale_to_vec(samples, gain),
    };
    let out_peak = if peak < self.min_boost {
      peak
    } else {
      // After normalize, peak is target (or 0.65*target when clipped).
      peak_i16(samples_i16(&pcm_for_stt)?)
    };
    Ok(VoiceFrameProcessed {
      peak: out_peak,
      raw_peak: peak,
      rms,
      speech: peak >= self.speech_peak,
      clipped: peak >= self.clip_peak,
      pcm_for_stt: Buffer::from(pcm_for_stt),
    })
  }
}
