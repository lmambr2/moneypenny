#![deny(clippy::all)]

use audiopus::coder::{Decoder as OpusDecoder, Encoder as OpusEncoder};
use audiopus::{Application, Channels, SampleRate};
use napi::bindgen_prelude::*;
use napi_derive::napi;

fn map_channels(channels: u32) -> Result<Channels> {
  match channels {
    1 => Ok(Channels::Mono),
    2 => Ok(Channels::Stereo),
    _ => Err(Error::from_reason(format!(
      "unsupported channel count {channels} (want 1 or 2)"
    ))),
  }
}

fn map_sample_rate(rate: u32) -> Result<SampleRate> {
  match rate {
    8000 => Ok(SampleRate::Hz8000),
    12000 => Ok(SampleRate::Hz12000),
    16000 => Ok(SampleRate::Hz16000),
    24000 => Ok(SampleRate::Hz24000),
    48000 => Ok(SampleRate::Hz48000),
    _ => Err(Error::from_reason(format!(
      "unsupported sample rate {rate}"
    ))),
  }
}

/// Opus encoder/decoder pair backed by system libopus (PR-B4).
#[napi]
pub struct NativeOpus {
  encoder: OpusEncoder,
  decoder: OpusDecoder,
  channels: u32,
  frame_size: usize,
}

#[napi]
impl NativeOpus {
  /// Create a native Opus codec. Defaults match TeamSpeak music: 48kHz stereo, 20ms frames.
  #[napi(constructor)]
  pub fn new(sample_rate: u32, channels: u32) -> Result<Self> {
    let ch = map_channels(channels)?;
    let sr = map_sample_rate(sample_rate)?;
    let encoder = OpusEncoder::new(sr, ch, Application::Audio)
      .map_err(|e| Error::from_reason(format!("opus encoder: {e:?}")))?;
    let decoder = OpusDecoder::new(sr, ch)
      .map_err(|e| Error::from_reason(format!("opus decoder: {e:?}")))?;
    let frame_size = (sample_rate as usize / 50) * channels as usize; // 20ms
    Ok(Self {
      encoder,
      decoder,
      channels,
      frame_size,
    })
  }

  /// Encode interleaved s16le PCM to a single Opus packet.
  #[napi]
  pub fn encode(&mut self, pcm: Buffer) -> Result<Buffer> {
    let samples: &[i16] = bytemuck_i16(pcm.as_ref())?;
    let mut out = vec![0u8; 4000];
    let n = self
      .encoder
      .encode(samples, &mut out)
      .map_err(|e| Error::from_reason(format!("opus encode: {e:?}")))?;
    Ok(Buffer::from(out[..n].to_vec()))
  }

  /// Decode one Opus packet to interleaved s16le PCM.
  #[napi]
  pub fn decode(&mut self, opus: Buffer) -> Result<Buffer> {
    let max_samples = self.frame_size * 6; // allow multi-frame slack
    let mut pcm = vec![0i16; max_samples];
    let n = self
      .decoder
      .decode(Some(opus.as_ref()), &mut pcm, false)
      .map_err(|e| Error::from_reason(format!("opus decode: {e:?}")))?;
    let bytes = n * self.channels as usize * 2;
    let raw = unsafe {
      std::slice::from_raw_parts(pcm.as_ptr() as *const u8, bytes)
    };
    Ok(Buffer::from(raw.to_vec()))
  }
}

fn bytemuck_i16(bytes: &[u8]) -> Result<&[i16]> {
  if !bytes.len().is_multiple_of(2) {
    return Err(Error::from_reason("PCM length must be even (s16le)"));
  }
  let ptr = bytes.as_ptr() as *const i16;
  let len = bytes.len() / 2;
  Ok(unsafe { std::slice::from_raw_parts(ptr, len) })
}

/// RMS energy of interleaved s16le PCM (0..32768 scale). Used for energy VAD.
#[napi]
pub fn pcm_rms(pcm: Buffer) -> Result<f64> {
  let samples: &[i16] = bytemuck_i16(pcm.as_ref())?;
  if samples.is_empty() {
    return Ok(0.0);
  }
  let mut sum_sq: f64 = 0.0;
  for &s in samples {
    let v = f64::from(s);
    sum_sq += v * v;
  }
  Ok((sum_sq / samples.len() as f64).sqrt())
}

/// True when RMS is at or above the speech threshold (default 500 matches TS SilenceSegmenter).
#[napi]
pub fn is_speech_frame(pcm: Buffer, energy_threshold: f64) -> Result<bool> {
  let rms = pcm_rms(pcm)?;
  Ok(rms >= energy_threshold)
}

/// Package probe for loaders / health checks.
#[napi]
pub fn native_audio_backend() -> String {
  "rust-libopus".to_string()
}
