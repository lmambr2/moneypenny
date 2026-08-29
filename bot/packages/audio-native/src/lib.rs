#![deny(clippy::all)]

mod opus_packet;
mod pcm;
mod voice_frame;

use audiopus::coder::{Decoder as OpusDecoder, Encoder as OpusEncoder};
use audiopus::{Application, Bitrate, Channels, SampleRate};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::opus_packet::{split_opus_frames, OPUS_DTX_MAX_BYTES};

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

#[napi(object)]
pub struct VoiceDecodeResult {
  pub ok: bool,
  /// Empty on success; `empty` | `dtx` | `corrupt` on failure.
  pub reason: String,
  pub pcm: Buffer,
  pub frames: u32,
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

  /// Set target Opus bitrate in bits/second.
  ///
  /// `bps <= 0` selects libopus Auto. Values are clamped to the Opus-meaningful
  /// range (500–512000). Used by the dashboard music stream bitrate slider so
  /// Starlink/uplink-constrained hosts can trade quality for bandwidth.
  #[napi]
  pub fn set_bitrate_bps(&mut self, bps: i32) -> Result<()> {
    let bitrate = if bps <= 0 {
      Bitrate::Auto
    } else {
      Bitrate::BitsPerSecond(bps.clamp(500, 512_000))
    };
    self
      .encoder
      .set_bitrate(bitrate)
      .map_err(|e| Error::from_reason(format!("opus set_bitrate: {e:?}")))?;
    Ok(())
  }

  /// Encode interleaved s16le PCM to a single Opus packet.
  #[napi]
  pub fn encode(&mut self, pcm: Buffer) -> Result<Buffer> {
    let samples: &[i16] = crate::pcm::samples_i16(pcm.as_ref())?;
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
    self.decode_bytes(opus.as_ref())
  }

  fn decode_bytes(&mut self, opus: &[u8]) -> Result<Buffer> {
    let max_samples = self.frame_size * 6; // allow multi-frame slack
    let mut pcm = vec![0i16; max_samples];
    let n = self
      .decoder
      .decode(Some(opus), &mut pcm, false)
      .map_err(|e| Error::from_reason(format!("opus decode: {e:?}")))?;
    let bytes = n * self.channels as usize * 2;
    let raw = unsafe { std::slice::from_raw_parts(pcm.as_ptr() as *const u8, bytes) };
    Ok(Buffer::from(raw.to_vec()))
  }

  /// Decode a TeamSpeak voice payload: try whole packet, then per-frame split.
  /// Never skip on size alone — tiny encoded silence is valid; DTX only after fail.
  #[napi]
  pub fn decode_voice(&mut self, packet: Buffer) -> Result<VoiceDecodeResult> {
    if packet.is_empty() {
      return Ok(VoiceDecodeResult {
        ok: false,
        reason: "empty".into(),
        pcm: Buffer::from(Vec::<u8>::new()),
        frames: 0,
      });
    }
    if let Ok(pcm) = self.decode_bytes(packet.as_ref()) {
      return Ok(VoiceDecodeResult {
        ok: true,
        reason: String::new(),
        pcm,
        frames: 1,
      });
    }
    if let Some(frames) = split_opus_frames(packet.as_ref()) {
      if frames.len() > 1 {
        let mut parts: Vec<u8> = Vec::new();
        let mut n = 0u32;
        for frame in &frames {
          if let Ok(pcm) = self.decode_bytes(frame) {
            parts.extend_from_slice(pcm.as_ref());
            n += 1;
          }
        }
        if n > 0 {
          return Ok(VoiceDecodeResult {
            ok: true,
            reason: String::new(),
            pcm: Buffer::from(parts),
            frames: n,
          });
        }
      }
    }
    let reason = if packet.len() as u32 <= OPUS_DTX_MAX_BYTES {
      "dtx"
    } else {
      "corrupt"
    };
    Ok(VoiceDecodeResult {
      ok: false,
      reason: reason.into(),
      pcm: Buffer::from(Vec::<u8>::new()),
      frames: 0,
    })
  }
}

/// Package probe for loaders / health checks.
#[napi]
pub fn native_audio_backend() -> String {
  "rust-libopus".to_string()
}
