// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use mp_music::{QueuedSong, Track};
use serde_json::{json, Value};

pub fn track_json(t: &Track) -> Value {
    json!({
        "id": t.id,
        "name": t.title,
        "artist": t.artist,
        "album": t.album,
        "duration": t.duration,
        "coverUrl": t.cover_url,
        "platform": t.platform.as_str(),
    })
}

pub fn queued_json(s: &QueuedSong) -> Value {
    json!({
        "id": s.id,
        "name": s.name,
        "artist": s.artist,
        "album": s.album,
        "duration": s.duration,
        "coverUrl": s.cover_url,
        "platform": s.platform.as_str(),
        "source": s.source.as_str(),
    })
}

pub fn queued_from_body(v: &Value) -> Option<QueuedSong> {
    let id = v.get("id")?.as_str()?.to_string();
    let platform = v
        .get("platform")
        .and_then(|x| x.as_str())
        .unwrap_or("local");
    Some(QueuedSong {
        id,
        name: v
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("Unknown")
            .to_string(),
        artist: v
            .get("artist")
            .and_then(|x| x.as_str())
            .unwrap_or("Unknown")
            .to_string(),
        album: v
            .get("album")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        duration: v.get("duration").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
        cover_url: v
            .get("coverUrl")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        platform: mp_music::Platform::parse(platform),
        url: v
            .get("url")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        source: mp_music::QueueSource::User,
    })
}
