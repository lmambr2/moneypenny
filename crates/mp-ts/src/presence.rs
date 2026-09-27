// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Server-wide channel occupancy (Node `channel-presence.ts` / auto-follow).

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresenceClient {
    pub id: i32,
    pub channel_id: u64,
    pub client_type: i32,
    pub nickname: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelPopulation {
    pub channel_id: u64,
    pub humans: u32,
}

pub fn tally_channel_populations(
    all: &[PresenceClient],
    self_client_id: i32,
) -> Vec<ChannelPopulation> {
    let mut out: Vec<ChannelPopulation> = Vec::new();
    for c in all {
        if c.client_type == 1 {
            continue;
        }
        if self_client_id > 0 && c.id == self_client_id {
            continue;
        }
        if c.channel_id == 0 {
            continue;
        }
        if let Some(row) = out.iter_mut().find(|r| r.channel_id == c.channel_id) {
            row.humans += 1;
        } else {
            out.push(ChannelPopulation {
                channel_id: c.channel_id,
                humans: 1,
            });
        }
    }
    out
}

pub fn count_channel_humans(all: &[PresenceClient], self_client_id: i32, channel_id: u64) -> u32 {
    if channel_id == 0 {
        return 0;
    }
    all.iter()
        .filter(|c| {
            c.client_type != 1
                && !(self_client_id > 0 && c.id == self_client_id)
                && c.channel_id == channel_id
        })
        .count() as u32
}

/// Busiest occupied channel that is not `current` and not in `exclude`.
/// Ties break toward the lowest channel id (deterministic, no hop-flop).
pub fn pick_busiest_channel(
    all: &[PresenceClient],
    self_client_id: i32,
    current_channel_id: u64,
    exclude: &[u64],
) -> Option<u64> {
    let mut eligible: Vec<ChannelPopulation> = tally_channel_populations(all, self_client_id)
        .into_iter()
        .filter(|p| {
            p.humans > 0
                && (current_channel_id == 0 || p.channel_id != current_channel_id)
                && !exclude.contains(&p.channel_id)
        })
        .collect();
    if eligible.is_empty() {
        return None;
    }
    eligible.sort_by(|a, b| {
        b.humans
            .cmp(&a.humans)
            .then_with(|| a.channel_id.cmp(&b.channel_id))
    });
    Some(eligible[0].channel_id)
}

/// Own channel: clientlist row for this clid, else the library's channel id.
/// TeamSpeak often reports `channel_id() == 0` after join.
pub fn resolve_own_channel_id(
    self_client_id: i32,
    library_channel_id: u64,
    all: &[PresenceClient],
) -> u64 {
    if self_client_id > 0 {
        if let Some(row) = all.iter().find(|c| c.id == self_client_id) {
            if row.channel_id != 0 {
                return row.channel_id;
            }
        }
    }
    if library_channel_id != 0 {
        return library_channel_id;
    }
    0
}

/// Result of a clientlist used for `!vote` (Node `getClientsInChannel`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelCensus {
    /// clientlist failed, or the server has clients but our channel id is unknown.
    Failed,
    /// People in the bot's channel, excluding the bot (`length - 1`).
    Humans(u32),
}

pub fn vote_listener_census(
    all: &[PresenceClient],
    self_client_id: i32,
    library_channel_id: u64,
    list_ok: bool,
) -> ChannelCensus {
    if !list_ok {
        return ChannelCensus::Failed;
    }
    let cid = resolve_own_channel_id(self_client_id, library_channel_id, all);
    if cid == 0 && !all.is_empty() {
        return ChannelCensus::Failed;
    }
    if cid == 0 {
        return ChannelCensus::Humans(0);
    }
    let in_channel = all.iter().filter(|c| c.channel_id == cid).count();
    ChannelCensus::Humans(in_channel.saturating_sub(1) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOT: i32 = 1;
    const LOBBY: u64 = 10;
    const OPS: u64 = 20;
    const AFK: u64 = 99;

    fn c(id: i32, channel: u64, typ: i32) -> PresenceClient {
        PresenceClient {
            id,
            channel_id: channel,
            client_type: typ,
            nickname: format!("u{id}"),
        }
    }

    #[test]
    fn picks_busiest_when_own_empty() {
        let all = [c(2, OPS, 0), c(3, OPS, 0), c(4, 30, 0), c(BOT, LOBBY, 0)];
        assert_eq!(pick_busiest_channel(&all, BOT, LOBBY, &[]), Some(OPS));
    }

    #[test]
    fn skips_query_clients_and_self() {
        let all = [c(BOT, LOBBY, 0), c(9, OPS, 1)];
        assert_eq!(pick_busiest_channel(&all, BOT, LOBBY, &[]), None);
    }

    #[test]
    fn never_follows_into_afk() {
        let all = [c(2, AFK, 0), c(3, AFK, 0), c(BOT, LOBBY, 0)];
        assert_eq!(pick_busiest_channel(&all, BOT, LOBBY, &[AFK]), None);
    }

    #[test]
    fn tie_breaks_lowest_id() {
        let all = [c(2, 30, 0), c(3, 20, 0), c(BOT, 5, 0)];
        assert_eq!(pick_busiest_channel(&all, BOT, 5, &[]), Some(20));
    }

    #[test]
    fn humans_in_own_channel() {
        let all = [
            c(BOT, LOBBY, 0),
            c(2, LOBBY, 0),
            c(3, OPS, 0),
            c(4, LOBBY, 1),
        ];
        assert_eq!(count_channel_humans(&all, BOT, LOBBY), 1);
    }

    #[test]
    fn vote_census_uses_self_row_when_library_cid_is_zero() {
        let all = [
            c(BOT, LOBBY, 0),
            c(2, LOBBY, 0),
            c(3, LOBBY, 0),
            c(4, OPS, 0),
        ];
        assert_eq!(
            vote_listener_census(&all, BOT, 0, true),
            ChannelCensus::Humans(2)
        );
    }

    #[test]
    fn vote_census_refuses_unknown_channel_on_a_populated_server() {
        let all = [c(2, OPS, 0)];
        assert_eq!(
            vote_listener_census(&all, BOT, 0, true),
            ChannelCensus::Failed
        );
    }

    #[test]
    fn vote_census_failed_list() {
        assert_eq!(
            vote_listener_census(&[], BOT, LOBBY, false),
            ChannelCensus::Failed
        );
    }
}
