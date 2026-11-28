// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Auto-DJ seed: local library plus optional YouTube/stream hits.
//!
//! Candidates are sampled, not taken from the front of the index. `avoid`
//! is songs programmed or played recently; they come back only when nothing
//! fresh is left, so a restock cannot replay the same eighteen titles.

use std::collections::HashSet;

use mp_config::RadioProfile;
use mp_music::{
    MusicStation, Platform, PlayerState, QueueSource, QueuedSong, Track, YOUTUBE_MAX_DURATION_SEC,
    YoutubePolicy, is_streamable_url, stream_track,
};

const SEED_POOL_CAP: usize = 18;
const SEED_SEARCH_LIMIT: usize = 30;
const SEED_YT_SEARCH_LIMIT: usize = 5;
const EXTERNAL_SEED_SUFFIX: &str = "official audio";
const SEED_MAX_PER_ARTIST: usize = 2;
/// Tag hits fill first and leave room for a substring pass.
const SEED_TAG_CAP: usize = 30;

/// Local rows the tag index already resolved. `Exclusive` is the profile
/// `music.select` pool and does not mix YouTube. `Supplement` is phrase-tag
/// hits that still go through the seed queries.
#[derive(Debug, Clone)]
pub enum LocalSeedPlan {
    None,
    Exclusive(Vec<Track>),
    Supplement(Vec<Track>),
}

pub fn seed_local_tracks(station: &MusicStation, profile: &RadioProfile) -> Vec<Track> {
    seed_profile_tracks(station, profile)
}

pub fn seed_profile_tracks(station: &MusicStation, profile: &RadioProfile) -> Vec<Track> {
    seed_with_plan(station, profile, &LocalSeedPlan::None, &HashSet::new())
}

pub fn seed_with_plan(
    station: &MusicStation,
    profile: &RadioProfile,
    plan: &LocalSeedPlan,
    avoid: &HashSet<String>,
) -> Vec<Track> {
    seed_with_plan_parts(station, profile, plan, avoid, true)
}

/// Tag and library hits only. Auto-DJ starts these while YouTube search is
/// still running, so a restock does not sit on silence for a minute.
pub fn seed_local_only(
    station: &MusicStation,
    profile: &RadioProfile,
    plan: &LocalSeedPlan,
    avoid: &HashSet<String>,
) -> Vec<Track> {
    seed_with_plan_parts(station, profile, plan, avoid, false)
}

fn seed_with_plan_parts(
    station: &MusicStation,
    profile: &RadioProfile,
    plan: &LocalSeedPlan,
    avoid: &HashSet<String>,
    include_external: bool,
) -> Vec<Track> {
    if let LocalSeedPlan::Exclusive(tracks) = plan {
        let local = absorb_prefer_fresh(station, tracks, avoid);
        return finish(station, profile, local, Vec::new());
    }
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

    if let LocalSeedPlan::Supplement(tracks) = plan {
        absorb_until(station, &mut local, tracks.clone(), SEED_TAG_CAP, avoid);
    }

    for q in &queries {
        if want_local {
            absorb(
                station,
                &mut local,
                station.local.sample(q, SEED_SEARCH_LIMIT, avoid),
                avoid,
            );
        }
        if include_external && want_stream && is_streamable_url(q) {
            if let Some(t) = stream_track(q) {
                absorb(station, &mut external, vec![t], avoid);
            }
        }
        if include_external && want_yt && station.youtube.available() {
            let hits = station.youtube.search(
                &external_seed_query(q),
                SEED_YT_SEARCH_LIMIT,
                YoutubePolicy::Radio,
            );
            absorb(station, &mut external, hits, avoid);
        }
    }

    if local.is_empty() && want_local {
        let bag = station.local.sample("", SEED_POOL_CAP * 2, avoid);
        absorb(station, &mut local, bag.clone(), avoid);
        if local.is_empty() {
            absorb(station, &mut local, bag, &HashSet::new());
        }
    }

    finish(station, profile, local, external)
}

fn finish(
    _station: &MusicStation,
    profile: &RadioProfile,
    local: Vec<Track>,
    external: Vec<Track>,
) -> Vec<Track> {
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

fn absorb(
    station: &MusicStation,
    into: &mut Vec<Track>,
    songs: Vec<Track>,
    avoid: &HashSet<String>,
) {
    absorb_until(station, into, songs, SEED_POOL_CAP * 2, avoid);
}

fn absorb_prefer_fresh(
    station: &MusicStation,
    tracks: &[Track],
    avoid: &HashSet<String>,
) -> Vec<Track> {
    let mut local = Vec::new();
    absorb(station, &mut local, tracks.to_vec(), avoid);
    if local.is_empty() {
        absorb(station, &mut local, tracks.to_vec(), &HashSet::new());
    }
    local
}

fn absorb_until(
    station: &MusicStation,
    into: &mut Vec<Track>,
    songs: Vec<Track>,
    cap: usize,
    avoid: &HashSet<String>,
) {
    for t in songs {
        if avoid.contains(&t.id) {
            continue;
        }
        if !seed_keeps(&t) {
            continue;
        }
        if station_blocked(station, &t) {
            continue;
        }
        if into.iter().any(|x| x.id == t.id) {
            continue;
        }
        into.push(t);
        if into.len() >= cap {
            break;
        }
    }
}

/// Bias a YouTube seed toward a single upload. URLs and queries that already
/// ask for audio are left alone.
fn external_seed_query(seed: &str) -> String {
    let q = seed.trim();
    if q.is_empty() || q.contains("://") {
        return q.to_string();
    }
    let lower = q.to_ascii_lowercase();
    if lower.contains(EXTERNAL_SEED_SUFFIX)
        || lower.contains("official video")
        || lower.contains("official music video")
        || lower.contains("lyric")
    {
        return q.to_string();
    }
    format!("{q} {EXTERNAL_SEED_SUFFIX}")
}

/// Hour-long and mix-shaped YouTube videos stay out of the auto-DJ pool.
/// Local files and an explicit user play do not come through here.
fn seed_keeps(t: &Track) -> bool {
    if t.platform != Platform::Youtube {
        return true;
    }
    if t.duration > YOUTUBE_MAX_DURATION_SEC {
        return false;
    }
    !long_mix_title(&t.title)
}

fn long_mix_title(title: &str) -> bool {
    let t = title.to_ascii_lowercase();
    const NEEDLES: &[&str] = &[
        "full album",
        "ultimate cut",
        "complete soundtrack",
        "full soundtrack",
        " hours",
        " hour ",
        " hour of",
    ];
    NEEDLES.iter().any(|n| t.contains(n))
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
    station
        .blacklist
        .as_ref()
        .is_some_and(|bl| bl.is_blacklisted(Some(&t.id), Some(&t.title), Some(&t.artist)))
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

/// Restock from the active profile.
///
/// A song ffmpeg is still playing stays on the stream. Upcoming user picks stay
/// ahead of the new fill. A user request that arrives during the rebuild is
/// left untouched (0). Otherwise returns the radio pool size.
pub fn program_station(station: &MusicStation, tracks: Vec<Track>) -> usize {
    if tracks.is_empty() {
        return 0;
    }
    let n = tracks.len();
    let queued: Vec<QueuedSong> = tracks
        .into_iter()
        .map(|t| QueuedSong::from_track(t, QueueSource::Radio))
        .collect();
    let epoch = station.playback_epoch();
    let restock = {
        let mut q = station.queue.lock().expect("queue");
        if station.playback_epoch() != epoch {
            tracing::info!("radio: restock dropped — user selected a track");
            return 0;
        }
        let keep_stream = matches!(
            station.player.get_state(),
            PlayerState::Playing | PlayerState::Paused
        );
        q.restock_radio(queued, keep_stream)
    };
    if station.playback_epoch() != epoch {
        tracing::info!("radio: restock dropped — user selected a track");
        return n;
    }
    if restock.preserved_current {
        tracing::info!("radio: restock preserved now-playing + user queue");
        return n;
    }
    let Some(first) = restock.start else {
        return 0;
    };
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

    #[test]
    fn local_only_seed_skips_external_sources() {
        let dir = std::env::temp_dir().join(format!(
            "mp-radio-local-only-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("yachtrock-marker.mp3"), b"x").unwrap();
        let station = MusicStation::new(&dir, None);
        station.set_dry_run(true);
        let profile = RadioProfile {
            name: "lobby".into(),
            music: mp_config::RadioMusic {
                seed_queries: vec!["yachtrock-marker".into()],
                seed_sources: vec!["local".into(), "youtube".into(), "stream".into()],
                seed_external_ratio: 1.0,
                ..Default::default()
            },
            bumper: Default::default(),
        };
        let tracks = seed_local_only(&station, &profile, &LocalSeedPlan::None, &HashSet::new());
        assert!(
            tracks.iter().any(|t| t.title.contains("yachtrock-marker")),
            "{tracks:?}"
        );
        assert!(
            tracks.iter().all(|t| t.platform == Platform::Local),
            "{tracks:?}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    fn track(id: &str, title: &str, platform: Platform, duration: u32) -> Track {
        Track {
            id: id.into(),
            title: title.into(),
            artist: "Tester".into(),
            album: String::new(),
            platform,
            url: String::new(),
            duration,
            cover_url: String::new(),
        }
    }

    fn tiny_station() -> (MusicStation, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "mp-radio-seed-plan-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("sine.mp3"), b"x").unwrap();
        let station = MusicStation::new(&dir, None);
        station.set_dry_run(true);
        (station, dir)
    }

    fn local_only(queries: &[&str]) -> RadioProfile {
        RadioProfile {
            name: "lobby".into(),
            music: mp_config::RadioMusic {
                seed_queries: queries.iter().map(|s| (*s).to_string()).collect(),
                seed_sources: vec!["local".into()],
                ..Default::default()
            },
            bumper: Default::default(),
        }
    }

    #[test]
    fn exclusive_plan_stays_on_the_given_tracks() {
        let (station, dir) = tiny_station();
        let profile = local_only(&["zzzz-no-match"]);
        let kept = track("only-me", "Kept Local", Platform::Local, 180);
        let tracks = seed_with_plan(
            &station,
            &profile,
            &LocalSeedPlan::Exclusive(vec![kept]),
            &HashSet::new(),
        );
        assert_eq!(tracks.len(), 1, "{tracks:?}");
        assert_eq!(tracks[0].id, "only-me");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn radio_seed_drops_long_and_mix_shaped_youtube() {
        let (station, dir) = tiny_station();
        let profile = local_only(&["zzzz-no-match"]);
        let long = track("long", "A normal ballad", Platform::Youtube, 3_600);
        let mix = track("mix", "The Complete Soundtrack", Platform::Youtube, 0);
        let short = track("short", "Choosin Texas", Platform::Youtube, 200);
        let local_mix = track("local-mix", "Complete Soundtrack", Platform::Local, 4_000);
        assert!(
            seed_with_plan(
                &station,
                &profile,
                &LocalSeedPlan::Exclusive(vec![long]),
                &HashSet::new(),
            )
            .is_empty()
        );
        assert!(
            seed_with_plan(
                &station,
                &profile,
                &LocalSeedPlan::Exclusive(vec![mix]),
                &HashSet::new(),
            )
            .is_empty()
        );
        let kept = seed_with_plan(
            &station,
            &profile,
            &LocalSeedPlan::Exclusive(vec![short, local_mix]),
            &HashSet::new(),
        );
        let ids: Vec<_> = kept.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"short"), "{ids:?}");
        assert!(ids.contains(&"local-mix"), "{ids:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn supplement_is_used_before_the_library_fallback() {
        let (station, dir) = tiny_station();
        let profile = local_only(&["zzzz-no-match"]);
        let tagged = track("tagged", "From Tags", Platform::Local, 200);
        let tracks = seed_with_plan(
            &station,
            &profile,
            &LocalSeedPlan::Supplement(vec![tagged]),
            &HashSet::new(),
        );
        assert_eq!(tracks.len(), 1, "{tracks:?}");
        assert_eq!(tracks[0].id, "tagged");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn avoided_supplement_is_not_replayed() {
        let (station, dir) = tiny_station();
        let profile = local_only(&["zzzz-no-match"]);
        let kept = track("kept", "Kept", Platform::Local, 180);
        let tired = track("tired", "Tired", Platform::Local, 180);
        let mut avoid = HashSet::new();
        avoid.insert("tired".into());
        let tracks = seed_with_plan(
            &station,
            &profile,
            &LocalSeedPlan::Supplement(vec![tired, kept]),
            &avoid,
        );
        let ids: Vec<_> = tracks.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"kept"), "{ids:?}");
        assert!(!ids.contains(&"tired"), "{ids:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn exclusive_pool_replays_only_when_nothing_fresh_remains() {
        let (station, dir) = tiny_station();
        let profile = local_only(&["zzzz-no-match"]);
        let only = track("only", "Only", Platform::Local, 180);
        let mut avoid = HashSet::new();
        avoid.insert("only".into());
        let tracks = seed_with_plan(
            &station,
            &profile,
            &LocalSeedPlan::Exclusive(vec![only]),
            &avoid,
        );
        assert_eq!(tracks.len(), 1, "{tracks:?}");
        assert_eq!(tracks[0].id, "only");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn program_station_does_not_cut_a_playing_user_track() {
        let (station, dir) = tiny_station();
        let user = QueuedSong::from_track(
            track("user", "West Point", Platform::Youtube, 180),
            QueueSource::User,
        );
        let next = QueuedSong::from_track(
            track("next", "Mansions", Platform::Youtube, 200),
            QueueSource::User,
        );
        {
            let mut q = station.queue.lock().expect("queue");
            q.add(user);
            q.add(next);
            let _ = q.play();
        }
        station
            .player
            .play("https://www.youtube.com/watch?v=user", 0.0, 180.0);
        let mut events = station.player.subscribe();
        let n = program_station(
            &station,
            vec![track("radio", "Game of Thrones", Platform::Local, 90)],
        );
        assert!(n >= 1);
        assert!(
            events.try_recv().is_err(),
            "restock must not restart ffmpeg over a user track"
        );
        let q = station.queue.lock().expect("queue");
        assert_eq!(q.current().expect("current").id, "user");
        let listed = q.list();
        let ids: Vec<_> = listed.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["user", "next", "radio"]);
        assert_eq!(station.player.get_state(), PlayerState::Playing);
        drop(q);
        let _ = std::fs::remove_dir_all(dir);
    }
}
