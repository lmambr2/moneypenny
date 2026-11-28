// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Tag index → radio seed. `music.select` is an exclusive local pool.
//! Seed phrases supplement the substring search when they hit genre,
//! subgenre, or mood. Installed after the station is bound.

use std::collections::HashSet;
use std::sync::Arc;

use mp_config::{AutoDjRepeat, RadioProfile, RadioTagSelect};
use mp_db::{Database, TagSelect};
use mp_music::{MusicStation, Track};
use mp_radio::LocalSeedPlan;

use crate::AppState;

const PHRASE_LIMIT: usize = 80;
const RESOLVE_CAP: usize = 160;

pub fn install_local_seed(state: &AppState) {
    let Some(station) = state.station.clone() else {
        return;
    };
    let db = Arc::clone(&state.db);
    state
        .radio
        .set_local_seed(Arc::new(move |profile: &RadioProfile| {
            local_seed_plan(&db, &station, profile)
        }));
    let db = Arc::clone(&state.db);
    state
        .radio
        .set_avoid_hook(Arc::new(move |policy: &AutoDjRepeat| {
            saturated_ids(&db, policy)
        }));
}

fn saturated_ids(db: &Database, policy: &AutoDjRepeat) -> HashSet<String> {
    if !policy.enabled || policy.max_plays < 1 || !(policy.cooldown_hours > 0.0) {
        return HashSet::new();
    }
    let bot_id = db.profile().active_id();
    match db
        .play_history()
        .saturated_song_ids(&bot_id, policy.max_plays, policy.cooldown_hours)
    {
        Ok(ids) => ids,
        Err(e) => {
            tracing::debug!(error = %e, "radio: repeat lookup failed");
            HashSet::new()
        }
    }
}

fn local_seed_plan(db: &Database, station: &MusicStation, profile: &RadioProfile) -> LocalSeedPlan {
    if let Some(sel) = profile.music.select.as_ref().filter(|s| s.is_active()) {
        let filter = to_tag_select(sel);
        if let Ok(keys) = db.tags().select_tracks(&filter) {
            let tracks = resolve(station, &keys, RESOLVE_CAP);
            if !tracks.is_empty() {
                return LocalSeedPlan::Exclusive(tracks);
            }
        }
    }
    let mut keys = Vec::new();
    for query in &profile.music.seed_queries {
        let Ok(found) = db.tags().sample_keys_for_phrase(query, PHRASE_LIMIT) else {
            continue;
        };
        for key in found {
            if !keys.iter().any(|k| k == &key) {
                keys.push(key);
            }
        }
    }
    let tracks = resolve(station, &keys, RESOLVE_CAP);
    if tracks.is_empty() {
        LocalSeedPlan::None
    } else {
        LocalSeedPlan::Supplement(tracks)
    }
}

fn to_tag_select(sel: &RadioTagSelect) -> TagSelect {
    TagSelect {
        mood: sel.mood.clone(),
        genre_any: sel.genre_any.clone(),
        subgenre_any: sel.subgenre_any.clone(),
        bpm_min: sel.bpm_min,
        bpm_max: sel.bpm_max,
        musical_key: sel.musical_key.clone(),
        energy_min: sel.energy_min,
        energy_max: sel.energy_max,
        rating_min: sel.rating_min,
        limit: sel.limit,
    }
}

fn resolve(station: &MusicStation, keys: &[String], cap: usize) -> Vec<Track> {
    let mut out = Vec::new();
    for key in keys {
        if out.len() >= cap {
            break;
        }
        if out.iter().any(|t: &Track| t.id == *key) {
            continue;
        }
        if let Some(track) = station.local.song_by_id(key) {
            out.push(track);
        }
    }
    out
}
