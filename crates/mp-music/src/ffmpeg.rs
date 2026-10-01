// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! ffmpeg argv + stall classifier. Port of `bot/src/audio/player.ts`.

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
pub const FRAME_DURATION_MS: u64 = 20;
pub const FRAME_SIZE: usize = (SAMPLE_RATE as usize * FRAME_DURATION_MS as usize) / 1000; // 960
pub const PCM_FRAME_BYTES: usize = FRAME_SIZE * CHANNELS as usize * 2; // 3840
pub const MIN_STALL_GRACE_SEC: f64 = 2.0;
/// yt-dlp / first-byte often takes longer than the mid-track 10s window.
/// Ending a play that never got PCM at 10s skips !add YouTube tracks.
pub const STARTUP_STALL_SEC: f64 = 45.0;
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
pub enum StallAction {
    Continue,
    Resume,
    End,
}

pub const MAX_STALL_RESUMES: u32 = 3;
pub const STALL_RESUME_MIN_REMAINING_SEC: f64 = 8.0;
/// Longer than ffmpeg `-reconnect_delay_max` (30s). Seeking a CDN URL drops the song.
pub const HTTP_MIDTRACK_STALL_ATTEMPTS: u32 = 2_250;

/// Known-length tracks in the last 5s. Duration `0` is unknown, not near the end.
pub fn is_near_end_of_track(duration_sec: f64, elapsed_sec: f64) -> bool {
    duration_sec > 0.0 && elapsed_sec.is_finite() && duration_sec - elapsed_sec <= 5.0
}

/// Mid-track PCM starve resumes the same URL. Near-end or too many resumes end the track.
pub fn decide_stall_action(
    verdict: StallVerdict,
    stall_resumes: u32,
    remaining_sec: f64,
    has_url: bool,
) -> StallAction {
    if verdict == StallVerdict::Continue {
        return StallAction::Continue;
    }
    if verdict == StallVerdict::MidTrackStall
        && has_url
        && stall_resumes < MAX_STALL_RESUMES
        && remaining_sec > STALL_RESUME_MIN_REMAINING_SEC
    {
        return StallAction::Resume;
    }
    StallAction::End
}

/// A network URL keeps the ffmpeg process so `-reconnect` can run. Seeking it ends the track.
pub fn stall_action_for_url(action: StallAction, url: &str) -> StallAction {
    let http = url.starts_with("http://") || url.starts_with("https://");
    if http && action == StallAction::Resume {
        StallAction::End
    } else {
        action
    }
}

pub fn mid_track_stall_attempts(url: &str) -> u32 {
    if url.starts_with("http://") || url.starts_with("https://") {
        HTTP_MIDTRACK_STALL_ATTEMPTS
    } else {
        500
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StallVerdict {
    Continue,
    NearEndStall,
    MidTrackStall,
}

#[derive(Clone, Copy)]
pub struct StallCheckInput {
    pub empty_frame_attempts: u32,
    pub near_end_attempts: u32,
    pub mid_track_attempts: u32,
    pub is_near_end: bool,
    pub wall_elapsed_sec: f64,
    /// True once at least one PCM frame was decoded this play().
    pub has_decoded_audio: bool,
}

pub fn classify_stall(input: StallCheckInput) -> StallVerdict {
    if input.empty_frame_attempts >= input.near_end_attempts && input.is_near_end {
        return StallVerdict::NearEndStall;
    }
    if input.empty_frame_attempts < input.mid_track_attempts {
        return StallVerdict::Continue;
    }
    if input.has_decoded_audio && input.wall_elapsed_sec >= MIN_STALL_GRACE_SEC {
        return StallVerdict::MidTrackStall;
    }
    if !input.has_decoded_audio && input.wall_elapsed_sec >= STARTUP_STALL_SEC {
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
    args.push("-protocol_whitelist".into());
    args.push("file,http,https,tcp,tls,crypto".into());
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
        [
            "-f",
            "s16le",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-acodec",
            "pcm_s16le",
            "-",
        ]
        .into_iter()
        .map(str::to_string),
    );
    args
}

/// Decode a yt-dlp stdout pipe. `-ss` is after `-i` because a pipe cannot seek.
pub fn build_ffmpeg_pipe_args(seek_seconds: f64) -> Vec<String> {
    let mut args = vec!["-nostdin".into(), "-i".into(), "pipe:0".into()];
    if seek_seconds > 0.0 {
        args.push("-ss".into());
        args.push(seek_seconds.to_string());
    }
    args.extend(
        [
            "-f",
            "s16le",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-acodec",
            "pcm_s16le",
            "-",
        ]
        .into_iter()
        .map(str::to_string),
    );
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_file_args() {
        let a = build_ffmpeg_args("/music/a.mp3", 0.0, None, None);
        assert!(
            a.windows(2)
                .any(|w| w == ["-protocol_whitelist", "file,http,https,tcp,tls,crypto"])
        );
        assert!(a.windows(2).any(|w| w == ["-i", "/music/a.mp3"]));
        assert!(!a.iter().any(|s| s.contains("concat")));
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
    fn pipe_does_not_open_the_cdn_url() {
        let a = build_ffmpeg_pipe_args(12.0);
        assert!(a.windows(2).any(|w| w == ["-i", "pipe:0"]));
        let i = a.iter().position(|s| s == "pipe:0").unwrap();
        let ss = a.iter().position(|s| s == "-ss").unwrap();
        assert!(ss > i);
        assert!(
            !a.iter()
                .any(|s| s.contains("reconnect") || s.contains("http"))
        );
        assert_eq!(
            build_ffmpeg_pipe_args(0.0).iter().any(|s| s == "-ss"),
            false
        );
    }

    #[test]
    fn mid_track_stall_resumes_until_the_cap() {
        assert_eq!(
            decide_stall_action(StallVerdict::MidTrackStall, 0, 90.0, true),
            StallAction::Resume
        );
        assert_eq!(
            decide_stall_action(StallVerdict::MidTrackStall, 0, f64::INFINITY, true),
            StallAction::Resume
        );
        assert_eq!(
            decide_stall_action(StallVerdict::MidTrackStall, MAX_STALL_RESUMES, 90.0, true),
            StallAction::End
        );
        assert_eq!(
            decide_stall_action(StallVerdict::MidTrackStall, 0, 4.0, true),
            StallAction::End
        );
        assert_eq!(
            decide_stall_action(StallVerdict::Continue, 0, 90.0, true),
            StallAction::Continue
        );
        assert_eq!(
            classify_stall(StallCheckInput {
                empty_frame_attempts: 250,
                near_end_attempts: 250,
                mid_track_attempts: 500,
                is_near_end: true,
                wall_elapsed_sec: 1.0,
                has_decoded_audio: true,
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
                has_decoded_audio: true,
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
                has_decoded_audio: true,
            }),
            StallVerdict::MidTrackStall
        );
    }

    #[test]
    fn stall_startup_waits_for_youtube_first_byte() {
        let starving = StallCheckInput {
            empty_frame_attempts: 500,
            near_end_attempts: 250,
            mid_track_attempts: 500,
            is_near_end: false,
            wall_elapsed_sec: 10.0,
            has_decoded_audio: false,
        };
        assert_eq!(classify_stall(starving), StallVerdict::Continue);
        let mut late = starving;
        late.wall_elapsed_sec = STARTUP_STALL_SEC;
        assert_eq!(classify_stall(late), StallVerdict::MidTrackStall);
    }

    #[test]
    fn unknown_duration_is_not_near_end() {
        assert!(!is_near_end_of_track(0.0, 45.0));
        assert!(!is_near_end_of_track(0.0, 600.0));
        assert!(!is_near_end_of_track(180.0, 170.0));
        assert!(is_near_end_of_track(180.0, 176.0));
    }

    #[test]
    fn http_silence_waits_out_reconnect_then_ends_without_a_seek() {
        assert_eq!(
            mid_track_stall_attempts("https://cdn.example/a"),
            HTTP_MIDTRACK_STALL_ATTEMPTS
        );
        assert_eq!(mid_track_stall_attempts("/tmp/a.mp3"), 500);
        let verdict = classify_stall(StallCheckInput {
            empty_frame_attempts: HTTP_MIDTRACK_STALL_ATTEMPTS,
            near_end_attempts: 250,
            mid_track_attempts: HTTP_MIDTRACK_STALL_ATTEMPTS,
            is_near_end: false,
            wall_elapsed_sec: 50.0,
            has_decoded_audio: true,
        });
        let action = decide_stall_action(verdict, 0, 1_000.0, true);
        assert_eq!(
            stall_action_for_url(action, "https://cdn.example/a"),
            StallAction::End
        );
        assert_eq!(
            stall_action_for_url(action, "/tmp/a.mp3"),
            StallAction::Resume
        );
    }
}
