// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! In-process Opus + PCM helpers, lifted from `bot/packages/audio-native`
//! without the N-API/cdylib surface.
//!
//! Node still builds `@moneypenny/audio-native` until cutover. This crate is
//! the library the Rust bot will use in-process.

mod opus_packet;
mod pcm;

#[cfg(feature = "opus")]
mod codec;

pub use opus_packet::{is_dtx_sized_packet, split_opus_frames, OPUS_DTX_MAX_BYTES};
pub use pcm::{
    is_speech_frame, normalize_pcm_for_stt, pcm_apply_playback_gain, pcm_mix, pcm_peak, pcm_rms,
    pcm_scale, samples_i16, CLIP_DISPLAY_PEAK, MIN_PCM_BOOST_PEAK, PLAYBACK_VOLUME_CURVE,
    STT_CLIP_PEAK, STT_TARGET_PEAK,
};

#[cfg(feature = "opus")]
pub use codec::{NativeOpus, VoiceDecodeResult};

/// Package probe for loaders / health checks. Matches the N-API export.
pub fn native_audio_backend() -> &'static str {
    if cfg!(feature = "opus") {
        "rust-libopus"
    } else {
        "pcm-only"
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("PCM length must be even (s16le)")]
    OddPcmLength,
    #[error("unsupported channel count {0} (want 1 or 2)")]
    Channels(u32),
    #[error("unsupported sample rate {0}")]
    SampleRate(u32),
    #[error("gain must be finite")]
    NonFiniteGain,
    #[error("opus: {0}")]
    Opus(String),
}

pub type Result<T> = std::result::Result<T, AudioError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_id() {
        assert_eq!(
            native_audio_backend(),
            if cfg!(feature = "opus") {
                "rust-libopus"
            } else {
                "pcm-only"
            }
        );
    }

    #[test]
    fn pcm_rms_silence_is_low() {
        let pcm = vec![0u8; 960 * 2];
        assert!(pcm_rms(&pcm).unwrap() < 1.0);
        assert!(!is_speech_frame(&pcm, 500.0).unwrap());
    }

    #[test]
    fn pcm_rms_rejects_odd_length() {
        assert!(matches!(pcm_rms(&[0]), Err(AudioError::OddPcmLength)));
    }

    #[test]
    fn peak_handles_i16_min() {
        let bytes = i16::MIN.to_le_bytes();
        assert_eq!(pcm_peak(&bytes).unwrap(), 32768);
    }

    #[test]
    fn dtx_size_threshold_is_twelve() {
        assert!(is_dtx_sized_packet(&[0; 12]));
        assert!(!is_dtx_sized_packet(&[0; 13]));
        assert!(is_dtx_sized_packet(&[]));
    }
}

#[cfg(all(test, feature = "opus"))]
mod opus_tests {
    use super::*;

    #[test]
    fn encode_decode_silence_mono_48k() {
        let mut codec = NativeOpus::new(48_000, 1).expect("libopus");
        let pcm = vec![0u8; 960 * 2];
        let opus = codec.encode(&pcm).expect("encode");
        assert!(!opus.is_empty());
        let decoded = codec.decode(&opus).expect("decode");
        assert!(decoded.len() >= 960 * 2);
    }

    #[test]
    fn decode_voice_empty_is_empty_reason() {
        let mut codec = NativeOpus::new(48_000, 1).unwrap();
        let r = codec.decode_voice(&[]).unwrap();
        assert!(!r.ok);
        assert_eq!(r.reason, "empty");
        assert_eq!(r.frames, 0);
    }

    #[test]
    fn bitrate_slider_auto_and_clamp() {
        let mut codec = NativeOpus::new(48_000, 2).unwrap();
        codec.set_bitrate_bps(0).unwrap();
        codec.set_bitrate_bps(64_000).unwrap();
        codec.set_bitrate_bps(i32::MAX).unwrap();
    }
}
