// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Auto-DJ seed: local library plus optional YouTube/stream hits.

use mp_config::RadioProfile;
use mp_music::{
    is_streamable_url, stream_track, MusicStation, PlayMode, QueuedSong, QueueSource, Track,
    YoutubePolicy,
};

const SEED_POOL_CAP: usize = 18;
const SEED_SEARCH_LIMIT: usize = 30;
const SEED_YT_SEARCH_LIMIT: usize = 5;
const SEED_MAX_PER_ARTIST: usize = 2;

pub fn seed_local_tracks(station: &MusicStation, profile: &RadioProfile) -> Vec<Track> {
    seed_profile_tracks(station, profile)
}

pub fn seed_profile_tracks(station: &MusicStation, profile: &RadioProfile) -> Vec<Track> {
    let queries = if profile.music.seed_queries.is_empty() {
        vec!["chill".into(), "ambient".into()]
    } else {
        profile.music.seed_queries.clone()
    };
    let sources = normalize_seed_sources(&profile.music.seed_sources);
    let want_local = sources.iter().any(|s| s == "local");
    let want_yt = sources.iter().any(|s| s == "youtube");
    let want_stream = sources.iter().any(|s| s == "stream");

    let mut local: Vec<Track> = Vec::new();
    let mut external: Vec<Track> = Vec::new();

    for q in &queries {
        if want_local {
            absorb(station, &mut local, station.local.search(q, SEED_SEARCH_LIMIT));
        }
        if want_stream && is_streamable_url(q) {
            if let Some(t) = stream_track(q) {
                absorb(station, &mut external, vec![t]);
            }
        }
        if want_yt && station.youtube.available() {
            let hits = station
                .youtube
                .search(q, SEED_YT_SEARCH_LIMIT, YoutubePolicy::Radio);
            absorb(station, &mut external, hits);
        }
    }

    if local.is_empty() && want_local {
        local = station
            .local
            .search("", SEED_POOL_CAP * 2)
            .into_iter()
            .filter(|t| !station_blocked(station, t))
            .collect();
    }

    let ratio = profile.music.seed_external_ratio.clamp(0.0, 1.0);
    let mut mixed = mix_pools(local, external, ratio, SEED_POOL_CAP * 2);
    if profile.music.shuffle {
        shuffle(&mut mixed);
    }
    diversify_artists(mixed, SEED_MAX_PER_ARTIST)
        .into_iter()
        .take(SEED_POOL_CAP)
        .collect()
}

fn normalize_seed_sources(raw: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for s in raw {
        let t = s.trim().to_ascii_lowercase();
        if matches!(t.as_str(), "local" | "youtube" | "stream") && !out.iter().any(|x| x == &t) {
            out.push(t);
        }
    }
    if out.is_empty() {
        vec!["local".into(), "youtube".into()]
    } else {
        out
    }
}

fn absorb(station: &MusicStation, into: &mut Vec<Track>, songs: Vec<Track>) {
    for t in songs {
        if station_blocked(station, &t) {
            continue;
        }
        if into.iter().any(|x| x.id == t.id) {
            continue;
        }
        into.push(t);
        if into.len() >= SEED_POOL_CAP * 2 {
            break;
        }
    }
}

fn mix_pools(local: Vec<Track>, external: Vec<Track>, ratio: f64, cap: usize) -> Vec<Track> {
    if external.is_empty() {
        return local;
    }
    if local.is_empty() {
        return external;
    }
    let ext_n = ((cap as f64) * ratio).round() as usize;
    let ext_n = ext_n.min(external.len()).min(cap);
    let loc_n = cap.saturating_sub(ext_n).min(local.len());
    let mut out = Vec::with_capacity(ext_n + loc_n);
    out.extend(external.into_iter().take(ext_n));
    out.extend(local.into_iter().take(loc_n));
    out
}

fn station_blocked(station: &MusicStation, t: &Track) -> bool {
    station.blacklist.as_ref().is_some_and(|bl| {
        bl.is_blacklisted(Some(&t.id), Some(&t.title), Some(&t.artist))
    })
}

fn shuffle<T>(items: &mut [T]) {
    let n = items.len();
    if n < 2 {
        return;
    }
    let mut seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(1);
    for i in (1..n).rev() {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let j = (seed as usize) % (i + 1);
        items.swap(i, j);
    }
}

fn diversify_artists(songs: Vec<Track>, max_per: usize) -> Vec<Track> {
    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut out = Vec::new();
    for t in songs {
        let key = if t.artist.trim().is_empty() {
            format!("id:{}", t.id)
        } else {
            t.artist.to_lowercase()
        };
        let n = counts.entry(key).or_insert(0);
        if *n >= max_per {
            continue;
        }
        *n += 1;
        out.push(t);
    }
    out
}

/// Replace the queue with radio-fill tracks and start the first. 0 = untouched.
pub fn program_station(station: &MusicStation, tracks: Vec<Track>) -> usize {
    if tracks.is_empty() {
        return 0;
    }
    let n = tracks.len();
    let queued: Vec<QueuedSong> = tracks
        .into_iter()
        .map(|t| QueuedSong::from_track(t, QueueSource::Radio))
        .collect();
    let first = queued[0].clone();
    {
        let mut q = station.queue.lock().expect("queue");
        q.clear();
        q.set_mode(PlayMode::Sequential);
        for s in queued {
            q.add(s);
        }
        let _ = q.play_at(0);
    }
    station.player.reset_failures();
    if !station.resolve_and_play(&first) {
        return station.play_next().map(|_| n).unwrap_or(0);
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    use mp_config::RadioProfile;
    use mp_music::Platform;

    #[test]
    fn empty_profile_falls_back_to_library() {
        let dir = std::env::temp_dir().join(format!(
            "mp-radio-seed-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("sine.mp3"), b"x").unwrap();
        let station = MusicStation::new(&dir, None);
        station.set_dry_run(true);
        let profile = RadioProfile {
            name: "lobby".into(),
            music: Default::default(),
            bumper: Default::default(),
        };
        let tracks = seed_local_tracks(&station, &profile);
        assert!(!tracks.is_empty());
        let n = program_station(&station, tracks);
        assert!(n >= 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn stream_url_seed_when_source_allows() {
        let dir = std::env::temp_dir().join(format!(
            "mp-radio-stream-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("sine.mp3"), b"x").unwrap();
        let station = MusicStation::new(&dir, None);
        station.set_dry_run(true);
        let profile = RadioProfile {
            name: "lobby".into(),
            music: mp_config::RadioMusic {
                seed_queries: vec!["https://example.com/radio.mp3".into()],
                seed_sources: vec!["stream".into()],
                seed_external_ratio: 1.0,
                ..Default::default()
            },
            bumper: Default::default(),
        };
        let tracks = seed_profile_tracks(&station, &profile);
        assert!(
            tracks.iter().any(|t| t.platform == Platform::Stream),
            "{tracks:?}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
