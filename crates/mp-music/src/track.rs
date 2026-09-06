// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Local,
    Youtube,
    Stream,
}

impl Platform {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Youtube => "youtube",
            Self::Stream => "stream",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "youtube" => Self::Youtube,
            "stream" => Self::Stream,
            _ => Self::Local,
        }
    }
}

impl fmt::Display for Platform {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone)]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub platform: Platform,
    pub url: String,
    pub duration: u32,
    pub cover_url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueSource {
    User,
    Radio,
    System,
}

impl QueueSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Radio => "radio",
            Self::System => "system",
        }
    }
}

#[derive(Debug, Clone)]
pub struct QueuedSong {
    pub id: String,
    pub name: String,
    pub artist: String,
    pub album: String,
    pub platform: Platform,
    pub url: String,
    pub cover_url: String,
    pub duration: u32,
    pub source: QueueSource,
}

impl QueuedSong {
    pub fn from_track(track: Track, source: QueueSource) -> Self {
        Self {
            id: track.id,
            name: track.title,
            artist: track.artist,
            album: track.album,
            platform: track.platform,
            url: track.url,
            cover_url: track.cover_url,
            duration: track.duration,
            source,
        }
    }

    pub fn is_radio_fill(&self) -> bool {
        self.source == QueueSource::Radio
    }
}
