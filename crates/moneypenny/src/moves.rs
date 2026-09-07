// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! !move / !moveclient / !moveall / !follow via TS6 HTTP Query (DESIGN §R4).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use mp_ts::QueryClient;

struct Pending {
    channel: String,
    cid: u64,
    targets: Vec<(i32, String)>,
    invoker_uid: String,
    expires: Instant,
}

pub struct MoveRuntime {
    query: Option<QueryClient>,
    pending: Mutex<Option<Pending>>,
    moves: Mutex<Vec<Instant>>,
}

impl MoveRuntime {
    pub fn new(query: Option<QueryClient>) -> Self {
        Self {
            query,
            pending: Mutex::new(None),
            moves: Mutex::new(Vec::new()),
        }
    }

    fn try_rate(&self) -> bool {
        let now = Instant::now();
        let mut g = self.moves.lock().expect("moves");
        g.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
        if g.len() >= 5 {
            return false;
        }
        g.push(now);
        true
    }

    pub async fn handle(
        &self,
        name: &str,
        args: &str,
        raw_args: &[String],
        invoker_clid: i32,
        invoker_uid: &str,
        own_clid: i32,
    ) -> String {
        match name {
            "move" => self.cmd_move(args, own_clid).await,
            "moveclient" => self.cmd_moveclient(raw_args).await,
            "moveall" => self.cmd_moveall(raw_args, invoker_uid, own_clid).await,
            "follow" => self.cmd_follow(invoker_clid, own_clid).await,
            _ => format!("{name} is not a move command."),
        }
    }

    pub async fn cmd_move(&self, args: &str, own_clid: i32) -> String {
        let Some(q) = self.query.as_ref() else {
            return "TeamSpeak Query is not configured (TS6_API_KEY).".into();
        };
        if args.trim().is_empty() {
            return "Usage: !move <channel name or ID>".into();
        }
        if own_clid <= 0 {
            return "Bot is not connected to TeamSpeak.".into();
        }
        match q.resolve_channel(args).await {
            Ok(ch) => match q.client_move(own_clid, ch.cid).await {
                Ok(()) => format!("Moved to channel: {}", ch.name),
                Err(e) => e,
            },
            Err(e) => e,
        }
    }

    pub async fn cmd_moveclient(&self, raw_args: &[String]) -> String {
        let Some(q) = self.query.as_ref() else {
            return "TeamSpeak Query is not configured (TS6_API_KEY).".into();
        };
        if raw_args.len() < 2 {
            return "Usage: !moveclient <nickname|clid> <channel>".into();
        }
        if !self.try_rate() {
            return "Too many moves — wait a minute and try again.".into();
        }
        let target = &raw_args[0];
        let channel = raw_args[1..].join(" ");
        let ch = match q.resolve_channel(&channel).await {
            Ok(c) => c,
            Err(e) => return e,
        };
        let clid = match resolve_clid(q, target).await {
            Ok(id) => id,
            Err(e) => return e,
        };
        match q.client_move(clid, ch.cid).await {
            Ok(()) => format!("Moved {target} → {}.", ch.name),
            Err(e) => e,
        }
    }

    pub async fn cmd_moveall(&self, raw_args: &[String], invoker_uid: &str, own_clid: i32) -> String {
        let Some(q) = self.query.as_ref() else {
            return "TeamSpeak Query is not configured (TS6_API_KEY).".into();
        };
        if invoker_uid.is_empty() {
            return "Mass move must be requested from TeamSpeak chat.".into();
        }
        if raw_args.first().map(|s| s.eq_ignore_ascii_case("confirm")).unwrap_or(false) {
            if !self.try_rate() {
                return "Too many moves — wait a minute and try again.".into();
            }
            let pending = {
                let mut g = self.pending.lock().expect("pending");
                match g.take() {
                    Some(p) if Instant::now() < p.expires && p.invoker_uid == invoker_uid => Some(p),
                    Some(p) => {
                        *g = Some(p);
                        None
                    }
                    None => None,
                }
            };
            let Some(p) = pending else {
                return "No pending mass move (or it expired). Run !moveall <channel> first.".into();
            };
            let mut ok = 0;
            for (clid, _) in &p.targets {
                if q.client_move(*clid, p.cid).await.is_ok() {
                    ok += 1;
                }
            }
            return format!(
                "Mass move complete: {ok}/{} → {}.",
                p.targets.len(),
                p.channel
            );
        }
        let channel = raw_args.join(" ");
        if channel.trim().is_empty() {
            return "Usage: !moveall <channel> — then !moveall confirm within 30s".into();
        }
        let ch = match q.resolve_channel(&channel).await {
            Ok(c) => c,
            Err(e) => return e,
        };
        let list = match q.client_list_groups().await {
            Ok(l) => l,
            Err(e) => return e,
        };
        let own_cid = list.iter().find(|r| r.clid == own_clid).map(|r| r.cid);
        let Some(own_cid) = own_cid else {
            return "Could not resolve the bot's channel.".into();
        };
        let targets: Vec<(i32, String)> = list
            .into_iter()
            .filter(|r| r.cid == own_cid && r.clid != own_clid)
            .map(|r| (r.clid, r.nickname))
            .collect();
        if targets.is_empty() {
            return "Nobody else is in this channel to move.".into();
        }
        if targets.len() > 10 {
            return format!(
                "Too many clients ({}) — max 10 per mass move. Move individuals with moveclient.",
                targets.len()
            );
        }
        let names: Vec<String> = targets.iter().map(|(_, n)| n.clone()).collect();
        *self.pending.lock().expect("pending") = Some(Pending {
            channel: ch.name.clone(),
            cid: ch.cid,
            targets,
            invoker_uid: invoker_uid.to_string(),
            expires: Instant::now() + Duration::from_secs(30),
        });
        format!(
            "Move {} client(s) ({}) → {}? Reply !moveall confirm within 30 seconds.",
            names.len(),
            names.join(", "),
            ch.name
        )
    }

    pub async fn cmd_follow(&self, invoker_clid: i32, own_clid: i32) -> String {
        let Some(q) = self.query.as_ref() else {
            return "TeamSpeak Query is not configured (TS6_API_KEY).".into();
        };
        if invoker_clid <= 0 {
            return "Follow can only be used in TeamSpeak".into();
        }
        if own_clid <= 0 {
            return "Bot is not connected to TeamSpeak.".into();
        }
        let list = match q.client_list_groups().await {
            Ok(l) => l,
            Err(e) => return e,
        };
        let Some(inv) = list.iter().find(|r| r.clid == invoker_clid) else {
            return "Could not find your channel.".into();
        };
        let already = list.iter().any(|r| r.clid == own_clid && r.cid == inv.cid);
        match q.client_move(own_clid, inv.cid).await {
            Ok(()) if already => "Already in your channel.".into(),
            Ok(()) => "Following you — moved to your channel.".into(),
            Err(e) => e,
        }
    }
}

async fn resolve_clid(q: &QueryClient, target: &str) -> Result<i32, String> {
    if let Ok(id) = target.parse::<i32>() {
        if id > 0 {
            return Ok(id);
        }
    }
    let list = q.client_list_groups().await?;
    let lower = target.to_ascii_lowercase();
    list.into_iter()
        .find(|r| r.nickname.eq_ignore_ascii_case(target) || r.nickname.to_ascii_lowercase().starts_with(&lower))
        .map(|r| r.clid)
        .ok_or_else(|| format!("No client matching '{target}'."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn no_query_is_honest() {
        let m = MoveRuntime::new(None);
        let s = m.cmd_move("Lobby", 1).await;
        assert!(s.contains("Query"));
        let s = m.cmd_follow(2, 1).await;
        assert!(s.contains("Query"));
    }
}
