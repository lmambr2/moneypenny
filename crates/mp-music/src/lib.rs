// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Music providers. Platforms are `local | youtube | stream` only.
//! Live: LocalProvider (realpath+prefix), PlayQueue, ffmpeg→Opus player,
//! playback blacklist + protected artists. YouTube via yt-dlp (CDN at play
//! time); direct HTTP/Icecast streams after the SSRF guard.

mod blacklist;
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

pub use blacklist::{
    ban_protected_message, blacklist_content_key, extract_video_id, is_ban_protected,
    normalize_blacklist_artist, normalize_blacklist_text, BlacklistEntry, PlaybackBlacklist,
    CONTENT_KEY_PREFIX,
};
pub use ffmpeg::{
    build_ffmpeg_args, classify_stall, clamp_music_opus_bitrate_kbps, StallCheckInput, StallVerdict,
    FRAME_DURATION_MS, MUSIC_OPUS_BITRATE_KBPS_DEFAULT, PCM_FRAME_BYTES, STARTUP_STALL_SEC,
};
pub use local::{LocalProvider, Playlist, ResolveHit};
pub use player::{AudioPlayer, PlayerEvent, PlayerState};
pub use queue::{replace_queue_with_song, PlayMode, PlayQueue};
pub use speech::{ChannelSpeech, TrackEndKind};
pub use station::{MusicStation, ReplaceResult, UserPause};
pub use stream::{
    is_bandcamp_url, is_spotify_ref, is_streamable_url, is_tidal_url, is_x_twitter_url,
    is_youtube_url, stream_track, StreamBridge,
};
pub use ytlibrary::{sanitize_base, YtLibrary, SAVE_SUBDIR};
pub use track::{Platform, QueuedSong, QueueSource, Track};
pub use youtube::{
    is_youtube_full_album_title, is_youtube_livestream_radio_title, should_block_youtube_song,
    YoutubeClient, YoutubePolicy, DEFAULT_DEMO_VIDEO_ID, DEFAULT_DEMO_VIDEO_URL,
};

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

#[cfg(test)]
mod tests {
    #[test]
    fn crate_compiles() {
        assert_eq!(env!("CARGO_PKG_NAME"), "mp-music");
    }
}
