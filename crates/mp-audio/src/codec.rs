// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! libopus encoder/decoder pair. TeamSpeak music defaults: 48 kHz stereo, 20 ms.

use audiopus::coder::{Decoder as OpusDecoder, Encoder as OpusEncoder};
use audiopus::{Application, Bitrate, Channels, SampleRate};

use crate::opus_packet::{split_opus_frames, OPUS_DTX_MAX_BYTES};
use crate::pcm::samples_i16;
use crate::{AudioError, Result};

fn map_channels(channels: u32) -> Result<Channels> {
    match channels {
        1 => Ok(Channels::Mono),
        2 => Ok(Channels::Stereo),
        n => Err(AudioError::Channels(n)),
    }
}

fn map_sample_rate(rate: u32) -> Result<SampleRate> {
    match rate {
        8000 => Ok(SampleRate::Hz8000),
        12000 => Ok(SampleRate::Hz12000),
        16000 => Ok(SampleRate::Hz16000),
        24000 => Ok(SampleRate::Hz24000),
        48000 => Ok(SampleRate::Hz48000),
        n => Err(AudioError::SampleRate(n)),
    }
}

/// Opus encoder/decoder pair backed by system libopus (PR-B4).
pub struct NativeOpus {
    encoder: OpusEncoder,
    decoder: OpusDecoder,
    channels: u32,
    frame_size: usize,
}

/// Result of `decode_voice`: never skip on size alone.
pub struct VoiceDecodeResult {
    pub ok: bool,
    /// Empty on success; `empty` | `dtx` | `corrupt` on failure.
    pub reason: String,
    pub pcm: Vec<u8>,
    pub frames: u32,
}

impl NativeOpus {
    /// Create a native Opus codec. Defaults match TeamSpeak music: 48kHz stereo, 20ms frames.
    pub fn new(sample_rate: u32, channels: u32) -> Result<Self> {
        let ch = map_channels(channels)?;
        let sr = map_sample_rate(sample_rate)?;
        let encoder = OpusEncoder::new(sr, ch, Application::Audio)
            .map_err(|e| AudioError::Opus(format!("encoder: {e:?}")))?;
        let decoder = OpusDecoder::new(sr, ch)
            .map_err(|e| AudioError::Opus(format!("decoder: {e:?}")))?;
        let frame_size = (sample_rate as usize / 50) * channels as usize;
        Ok(Self {
            encoder,
            decoder,
            channels,
            frame_size,
        })
    }

    /// Set target Opus bitrate in bits/second.
    ///
    /// `bps <= 0` selects libopus Auto. Values are clamped to 500–512000.
    pub fn set_bitrate_bps(&mut self, bps: i32) -> Result<()> {
        let bitrate = if bps <= 0 {
            Bitrate::Auto
        } else {
            Bitrate::BitsPerSecond(bps.clamp(500, 512_000))
        };
        self.encoder
            .set_bitrate(bitrate)
            .map_err(|e| AudioError::Opus(format!("set_bitrate: {e:?}")))?;
        Ok(())
    }

    /// Encode interleaved s16le PCM to a single Opus packet.
    pub fn encode(&mut self, pcm: &[u8]) -> Result<Vec<u8>> {
        let samples = samples_i16(pcm)?;
        let mut out = vec![0u8; 4000];
        let n = self
            .encoder
            .encode(&samples, &mut out)
            .map_err(|e| AudioError::Opus(format!("encode: {e:?}")))?;
        out.truncate(n);
        Ok(out)
    }

    /// Decode one Opus packet to interleaved s16le PCM.
    pub fn decode(&mut self, opus: &[u8]) -> Result<Vec<u8>> {
        self.decode_bytes(opus)
    }

    fn decode_bytes(&mut self, opus: &[u8]) -> Result<Vec<u8>> {
        let max_samples = self.frame_size * 6;
        let mut pcm = vec![0i16; max_samples];
        let n = self
            .decoder
            .decode(Some(opus), &mut pcm, false)
            .map_err(|e| AudioError::Opus(format!("decode: {e:?}")))?;
        let sample_count = n * self.channels as usize;
        let mut raw = Vec::with_capacity(sample_count * 2);
        for s in &pcm[..sample_count] {
            raw.extend_from_slice(&s.to_le_bytes());
        }
        Ok(raw)
    }

    /// Decode a TeamSpeak voice payload: try whole packet, then per-frame split.
    /// Never skip on size alone — tiny encoded silence is valid; DTX only after fail.
    pub fn decode_voice(&mut self, packet: &[u8]) -> Result<VoiceDecodeResult> {
        if packet.is_empty() {
            return Ok(VoiceDecodeResult {
                ok: false,
                reason: "empty".into(),
                pcm: Vec::new(),
                frames: 0,
            });
        }
        if let Ok(pcm) = self.decode_bytes(packet) {
            return Ok(VoiceDecodeResult {
                ok: true,
                reason: String::new(),
                pcm,
                frames: 1,
            });
        }
        if let Some(frames) = split_opus_frames(packet) {
            if frames.len() > 1 {
                let mut parts = Vec::new();
                let mut n = 0u32;
                for frame in &frames {
                    if let Ok(pcm) = self.decode_bytes(frame) {
                        parts.extend_from_slice(&pcm);
                        n += 1;
                    }
                }
                if n > 0 {
                    return Ok(VoiceDecodeResult {
                        ok: true,
                        reason: String::new(),
                        pcm: parts,
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
            pcm: Vec::new(),
            frames: 0,
        })
    }
}
