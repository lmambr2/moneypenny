// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Music providers. Platforms are `local | youtube | stream` only.
//! Live: LocalProvider (realpath+prefix), PlayQueue, ffmpeg→Opus player,
//! playback blacklist + protected artists. YouTube via yt-dlp (CDN at play
//! time); direct HTTP/Icecast streams after the SSRF guard.

mod blacklist;
mod enrich;
mod ffmpeg;
mod local;
mod player;
mod queue;
mod speech;
mod station;
mod stream;
mod track;
mod url_guard;
mod youtube;
mod ytlibrary;

pub use enrich::{
    id3_enrich_due, is_in_local_hour_window, ms_until_window_closes, ms_until_window_opens,
    parse_id3v2, CivilClock, HourWindow, Id3Tags, NIGHT_INDEX_WINDOW,
};
pub use blacklist::{
    BlacklistEntry, CONTENT_KEY_PREFIX, PlaybackBlacklist, ban_protected_message,
    blacklist_content_key, extract_video_id, is_ban_protected, normalize_blacklist_artist,
    normalize_blacklist_text,
};
pub use ffmpeg::{
    FRAME_DURATION_MS, MUSIC_OPUS_BITRATE_KBPS_DEFAULT, PCM_FRAME_BYTES, STARTUP_STALL_SEC,
    StallAction, StallCheckInput, StallVerdict, build_ffmpeg_args, clamp_music_opus_bitrate_kbps,
    classify_stall, decide_stall_action,
};
pub use local::{DeleteSongError, LocalProvider, Playlist, ResolveHit};
pub use player::{AudioPlayer, PlayerEvent, PlayerState};
pub use queue::{PlayMode, PlayQueue, replace_queue_with_song, replace_queue_with_tracks};
pub use speech::{ChannelSpeech, TrackEndKind};
pub use station::{MusicStation, ReplaceResult, UserPause, VoteAudience};
pub use stream::{
    StreamBridge, is_bandcamp_url, is_spotify_ref, is_streamable_url, is_tidal_url,
    is_x_twitter_url, is_youtube_url, stream_track,
};
pub use track::{Platform, QueueSource, QueuedSong, Track};
pub use youtube::{
    DEFAULT_DEMO_VIDEO_ID, DEFAULT_DEMO_VIDEO_URL, SG1_THEME_URL, SG1_THEME_VIDEO_ID,
    YoutubeClient, YoutubePolicy, is_demo_test_track, is_youtube_full_album_title,
    is_youtube_livestream_radio_title, should_block_youtube_song,
};
pub use ytlibrary::{SAVE_SUBDIR, YtLibrary, sanitize_base};

#[derive(Debug, thiserror::Error)]
pub enum MusicError {
    #[error("{0}")]
    Message(String),
    #[error("path escapes library")]
    PathGuard,
}

pub trait MusicProvider: Send + Sync {
    fn resolve(
        &self,
        input: &str,
    ) -> impl std::future::Future<Output = Result<Track, MusicError>> + Send;
}
