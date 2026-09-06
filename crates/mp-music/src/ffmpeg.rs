// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! ffmpeg argv + stall classifier. Port of `bot/src/audio/player.ts`.

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
pub const FRAME_DURATION_MS: u64 = 20;
pub const FRAME_SIZE: usize = (SAMPLE_RATE as usize * FRAME_DURATION_MS as usize) / 1000; // 960
pub const PCM_FRAME_BYTES: usize = FRAME_SIZE * CHANNELS as usize * 2; // 3840
pub const MIN_STALL_GRACE_SEC: f64 = 2.0;
pub const MUSIC_OPUS_BITRATE_KBPS_MIN: u32 = 24;
pub const MUSIC_OPUS_BITRATE_KBPS_MAX: u32 = 160;
pub const MUSIC_OPUS_BITRATE_KBPS_DEFAULT: u32 = 64;

pub fn clamp_music_opus_bitrate_kbps(kbps: i32) -> u32 {
    if kbps == 0 {
        return 0;
    }
    if kbps < 0 {
        return MUSIC_OPUS_BITRATE_KBPS_DEFAULT;
    }
    (kbps as u32).clamp(MUSIC_OPUS_BITRATE_KBPS_MIN, MUSIC_OPUS_BITRATE_KBPS_MAX)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StallVerdict {
    Continue,
    NearEndStall,
    MidTrackStall,
}

pub struct StallCheckInput {
    pub empty_frame_attempts: u32,
    pub near_end_attempts: u32,
    pub mid_track_attempts: u32,
    pub is_near_end: bool,
    pub wall_elapsed_sec: f64,
}

pub fn classify_stall(input: StallCheckInput) -> StallVerdict {
    if input.empty_frame_attempts >= input.near_end_attempts && input.is_near_end {
        return StallVerdict::NearEndStall;
    }
    if input.empty_frame_attempts >= input.mid_track_attempts
        && input.wall_elapsed_sec >= MIN_STALL_GRACE_SEC
    {
        return StallVerdict::MidTrackStall;
    }
    StallVerdict::Continue
}

pub fn build_ffmpeg_args(
    url: &str,
    seek_seconds: f64,
    audio_filter: Option<&str>,
    max_seconds: Option<f64>,
) -> Vec<String> {
    let mut args = Vec::new();
    if url.starts_with("http://") || url.starts_with("https://") {
        args.extend(
            [
                "-reconnect",
                "1",
                "-reconnect_streamed",
                "1",
                "-reconnect_delay_max",
                "30",
                "-reconnect_on_network_error",
                "1",
                "-reconnect_on_http_error",
                "4xx,5xx",
            ]
            .into_iter()
            .map(str::to_string),
        );
    }
    if seek_seconds > 0.0 {
        args.push("-ss".into());
        args.push(seek_seconds.to_string());
    }
    args.push("-i".into());
    args.push(url.to_string());
    if let Some(max) = max_seconds {
        if max.is_finite() && max > 0.0 {
            args.push("-t".into());
            args.push((max.floor() as i64).to_string());
        }
    }
    if let Some(af) = audio_filter {
        let af = af.trim();
        if !af.is_empty()
            && af.len() < 2000
            && !af.chars().any(|c| c == '\n' || c == '\r' || c == '\0')
        {
            args.push("-af".into());
            args.push(af.to_string());
        }
    }
    args.extend(
        ["-f", "s16le", "-ar", "48000", "-ac", "2", "-acodec", "pcm_s16le", "-"]
            .into_iter()
            .map(str::to_string),
    );
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_frame_is_20ms_stereo_48k() {
        assert_eq!(PCM_FRAME_BYTES, 3840);
    }

    #[test]
    fn local_file_args() {
        let a = build_ffmpeg_args("/music/a.mp3", 0.0, None, None);
        assert_eq!(a[0], "-i");
        assert_eq!(a[1], "/music/a.mp3");
        assert!(a.windows(2).any(|w| w == ["-ar", "48000"]));
        assert!(a.windows(2).any(|w| w == ["-ac", "2"]));
        assert_eq!(a.last().unwrap(), "-");
    }

    #[test]
    fn http_reconnect_and_seek() {
        let a = build_ffmpeg_args("https://ex/a.mp3", 12.0, None, Some(30.0));
        assert!(a.contains(&"-reconnect".into()));
        assert!(a.windows(2).any(|w| w == ["-ss", "12"]));
        assert!(a.windows(2).any(|w| w == ["-t", "30"]));
    }

    #[test]
    fn stall_near_end() {
        assert_eq!(
            classify_stall(StallCheckInput {
                empty_frame_attempts: 250,
                near_end_attempts: 250,
                mid_track_attempts: 500,
                is_near_end: true,
                wall_elapsed_sec: 1.0,
            }),
            StallVerdict::NearEndStall
        );
    }

    #[test]
    fn stall_mid_track_needs_grace() {
        assert_eq!(
            classify_stall(StallCheckInput {
                empty_frame_attempts: 500,
                near_end_attempts: 250,
                mid_track_attempts: 500,
                is_near_end: false,
                wall_elapsed_sec: 1.0,
            }),
            StallVerdict::Continue
        );
        assert_eq!(
            classify_stall(StallCheckInput {
                empty_frame_attempts: 500,
                near_end_attempts: 250,
                mid_track_attempts: 500,
                is_near_end: false,
                wall_elapsed_sec: 2.0,
            }),
            StallVerdict::MidTrackStall
        );
    }
}
