// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Local-library auto-DJ seed. YouTube/stream seed is later.

use mp_config::RadioProfile;
use mp_music::{MusicStation, PlayMode, QueuedSong, QueueSource, Track};

const SEED_POOL_CAP: usize = 18;
const SEED_SEARCH_LIMIT: usize = 30;
const SEED_MAX_PER_ARTIST: usize = 2;

pub fn seed_local_tracks(station: &MusicStation, profile: &RadioProfile) -> Vec<Track> {
    let mut out: Vec<Track> = Vec::new();
    let queries = if profile.music.seed_queries.is_empty() {
        vec!["chill".into(), "ambient".into()]
    } else {
        profile.music.seed_queries.clone()
    };
    for q in queries {
        for t in station.local.search(&q, SEED_SEARCH_LIMIT) {
            if station_blocked(station, &t) {
                continue;
            }
            if out.iter().any(|x| x.id == t.id) {
                continue;
            }
            out.push(t);
            if out.len() >= SEED_POOL_CAP * 2 {
                break;
            }
        }
    }
    if out.is_empty() {
        out = station
            .local
            .search("", SEED_POOL_CAP * 2)
            .into_iter()
            .filter(|t| !station_blocked(station, t))
            .collect();
    }
    if profile.music.shuffle {
        shuffle(&mut out);
    }
    diversify_artists(out, SEED_MAX_PER_ARTIST)
        .into_iter()
        .take(SEED_POOL_CAP)
        .collect()
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
}
