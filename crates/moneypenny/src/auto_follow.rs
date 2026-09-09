// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Follow the crowd when the bot's own channel empties.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use mp_http::FollowRuntime;
use mp_ts::{count_channel_humans, pick_busiest_channel, TsSessionExt};

pub struct AutoFollow {
    settings: std::sync::Arc<FollowRuntime>,
    last_move: Mutex<Option<Instant>>,
    afk_id_cache: Mutex<HashMap<String, Option<u64>>>,
    cached_afk_names: Mutex<String>,
}

impl AutoFollow {
    pub fn new(settings: std::sync::Arc<FollowRuntime>) -> Self {
        Self {
            settings,
            last_move: Mutex::new(None),
            afk_id_cache: Mutex::new(HashMap::new()),
            cached_afk_names: Mutex::new(String::new()),
        }
    }

    async fn afk_ids<S: TsSessionExt>(&self, session: &S) -> Vec<u64> {
        let names = self.settings.afk_channels();
        let key = names
            .iter()
            .map(|n| n.trim().to_ascii_lowercase())
            .collect::<String>();
        {
            let mut cached = self.cached_afk_names.lock().expect("afk names");
            if *cached != key {
                self.afk_id_cache.lock().expect("afk cache").clear();
                *cached = key;
            }
        }
        let mut ids = Vec::new();
        for name in names {
            let k = name.trim().to_ascii_lowercase();
            if k.is_empty() {
                continue;
            }
            let cached = self.afk_id_cache.lock().expect("afk cache").get(&k).copied();
            if let Some(Some(id)) = cached {
                ids.push(id);
                continue;
            }
            if cached == Some(None) {
                continue;
            }
            match session.resolve_channel_id_by_name(&name).await {
                Some(id) if id != 0 => {
                    self.afk_id_cache.lock().expect("afk cache").insert(k, Some(id));
                    ids.push(id);
                }
                _ => {
                    // Miss is not sticky — a name that fails now may resolve later.
                }
            }
        }
        ids
    }

    /// Move to the busiest occupied channel when the current one is empty.
    pub async fn maybe_follow<S: TsSessionExt>(&self, session: &S, human_count: u32) -> Option<u64> {
        if !self.settings.enabled() {
            return None;
        }
        if !session.is_connected() {
            return None;
        }
        if human_count > 0 {
            return None;
        }
        let cooldown = Duration::from_secs(self.settings.cooldown_sec());
        {
            let last = self.last_move.lock().expect("last move");
            if let Some(at) = *last {
                if at.elapsed() < cooldown {
                    return None;
                }
            }
        }
        let all = session.list_clients().await;
        if all.is_empty() {
            return None;
        }
        let exclude = self.afk_ids(session).await;
        let target = pick_busiest_channel(&all, session.client_id(), session.channel_id(), &exclude)?;
        if !session.join_channel(target).await {
            tracing::debug!(channel_id = target, "auto-follow: join refused");
            return None;
        }
        *self.last_move.lock().expect("last move") = Some(Instant::now());
        tracing::info!(
            channel_id = target,
            "auto-follow: channel was empty — moved to where people are"
        );
        Some(target)
    }

    pub fn humans_in_own<S: TsSessionExt>(session: &S, all: &[mp_ts::PresenceClient]) -> u32 {
        count_channel_humans(all, session.client_id(), session.channel_id())
    }
}
