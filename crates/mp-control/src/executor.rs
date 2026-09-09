// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Deterministic `!command` implementations. Rights live outside this module.
//!
//! `!skip` / `!next` advance one track only and MUST NOT emit a reply that
//! starts with the command prefix (self-echo flood).

use std::sync::Arc;

use mp_music::{
    ban_protected_message, blacklist_content_key, extract_video_id, is_ban_protected, PlayMode,
    QueuedSong, QueueSource, ReplaceResult,
};

use crate::manifest::{is_audio_command, ParsedCommand};

#[derive(Clone)]
pub struct CommandExecutor {
    pub station: Arc<mp_music::MusicStation>,
    pub prefix: String,
    pub protected_artists: Vec<String>,
}

impl CommandExecutor {
    pub fn new(station: Arc<mp_music::MusicStation>, prefix: impl Into<String>) -> Self {
        Self {
            station,
            prefix: prefix.into(),
            protected_artists: Vec::new(),
        }
    }

    pub async fn execute(&self, cmd: &ParsedCommand) -> Option<String> {
        if !self.station.is_connected() && is_audio_command(&cmd.name) {
            return Some("Bot is not connected to TeamSpeak".into());
        }
        let out = match cmd.name.as_str() {
            "play" => self.cmd_play(cmd).await,
            "add" => self.cmd_add(cmd).await,
            "playnext" | "pn" => self.cmd_playnext(cmd).await,
            "pause" => self.station.pause_playback(),
            "resume" => self.station.resume_playback(),
            "stop" => self.cmd_stop(),
            "next" | "skip" => self.cmd_skip().await,
            "jump" | "go" => self.cmd_jump(cmd).await,
            "prev" => self.cmd_prev().await,
            "vol" => self.cmd_vol(cmd),
            "now" => self.cmd_now(),
            "queue" | "list" => self.cmd_queue(),
            "clear" => self.cmd_clear(),
            "remove" => self.cmd_remove(cmd),
            "mode" => self.cmd_mode(cmd),
            "ban" => self.cmd_ban(cmd).await,
            "unban" => self.cmd_unban(cmd),
            "help" => self.cmd_help(),
            "test" => self.cmd_test().await,
            "playlist" => self.cmd_playlist(cmd).await,
            "album" => self.cmd_album(cmd).await,
            "artist" => self.cmd_artist(cmd).await,
            "lyrics" => self.cmd_lyrics(),
            "mute" | "kick" => format!(
                "Usage: {}{other} <nickname|clid> — run this from TeamSpeak chat.",
                self.prefix,
                other = cmd.name
            ),
            other if crate::manifest::is_known_command(other) => {
                format!("{other} is not ported yet.")
            }
            other => format!(
                "Unknown command: {other}. Type {}help for help.",
                self.prefix
            ),
        };
        Some(out)
    }

    async fn cmd_play(&self, cmd: &ParsedCommand) -> String {
        if cmd.args.is_empty() {
            return format!("Usage: {}play <song name or URL>", self.prefix);
        }
        match self
            .station
            .replace_with_first_hit_flags_async(&cmd.args, &cmd.flags)
            .await
        {
            ReplaceResult::Ok(t) => format!("Now playing: {} - {}", t.title, t.artist),
            ReplaceResult::NoResults => format!("No results found for: {}", cmd.args),
            ReplaceResult::CantPlay(t) => format!("Cannot play: {}", t.title),
        }
    }

    async fn cmd_add(&self, cmd: &ParsedCommand) -> String {
        if cmd.args.is_empty() {
            return format!("Usage: {}add <song name>", self.prefix);
        }
        let Some(track) = self
            .station
            .search_first_flags_async(&cmd.args, &cmd.flags)
            .await
        else {
            return format!("No results found for: {}", cmd.args);
        };
        let was_idle = self.station.player.get_state() == mp_music::PlayerState::Idle;
        let queued = QueuedSong::from_track(track.clone(), QueueSource::User);
        let at = {
            let mut q = self.station.queue.lock().expect("queue");
            q.add(queued.clone())
        };
        if was_idle {
            {
                let mut q = self.station.queue.lock().expect("queue");
                q.play_at(at);
            }
            self.station.player.reset_failures();
            let _ = self.station.resolve_and_play_async(&queued).await;
            return format!("Now playing: {} - {}", track.title, track.artist);
        }
        let cur = self.station.queue.lock().expect("queue").get_current_index();
        let upcoming = if cur < 0 {
            at + 1
        } else {
            (at as i32 - cur).max(1) as usize
        };
        format!(
            "Added to queue: {} - {} (up next #{upcoming})",
            track.title, track.artist
        )
    }

    async fn cmd_playnext(&self, cmd: &ParsedCommand) -> String {
        if cmd.args.is_empty() {
            return format!("Usage: {}playnext <song name>", self.prefix);
        }
        let Some(track) = self
            .station
            .search_first_flags_async(&cmd.args, &cmd.flags)
            .await
        else {
            return format!("No results found for: {}", cmd.args);
        };
        let was_idle = self.station.player.get_state() == mp_music::PlayerState::Idle;
        let queued = QueuedSong::from_track(track.clone(), QueueSource::User);
        let inserted_at = {
            let q = self.station.queue.lock().expect("queue");
            if q.get_current_index() < 0 {
                q.size()
            } else {
                q.get_current_index() as usize + 1
            }
        };
        self.station.queue.lock().expect("queue").add_next(queued.clone());
        if was_idle {
            {
                let mut q = self.station.queue.lock().expect("queue");
                q.play_at(inserted_at);
            }
            self.station.player.reset_failures();
            if !self.station.resolve_and_play_async(&queued).await {
                return format!("Cannot play: {}", track.title);
            }
            return format!("Now playing: {} - {}", track.title, track.artist);
        }
        format!("Up next: {} - {}", track.title, track.artist)
    }

    fn cmd_stop(&self) -> String {
        self.station.clear_user_pause();
        self.station.player.stop();
        self.station.queue.lock().expect("queue").clear();
        "Stopped and queue cleared".into()
    }

    /// Bare advance only. Args ignored. Never emit a prefix-led usage string.
    async fn cmd_skip(&self) -> String {
        self.station.clear_user_pause();
        self.advance_one_track().await
    }

    async fn advance_one_track(&self) -> String {
        let current = self.station.play_next_async().await;
        match current {
            Some(s) => format!("Skipped — now playing: {} - {}", s.name, s.artist),
            None => "Queue is empty".into(),
        }
    }

    async fn cmd_jump(&self, cmd: &ParsedCommand) -> String {
        self.station.clear_user_pause();
        let query = cmd.args.trim();
        let p = &self.prefix;
        if query.is_empty() {
            return format!(
                "Usage: {p}jump <query|url> — start that track now (or {p}go). Bare advance: {p}skip."
            );
        }
        let idx = {
            let q = self.station.queue.lock().expect("queue");
            find_queue_index_by_query(&q, query)
        };
        if let Some(idx) = idx {
            let song = {
                let mut q = self.station.queue.lock().expect("queue");
                q.play_at(idx)
            };
            let Some(song) = song else {
                return "Queue is empty".into();
            };
            self.station.player.reset_failures();
            if !self.station.resolve_and_play_async(&song).await {
                return format!("Cannot play: {}", song.name);
            }
            return format!("Jumped to: {} - {}", song.name, song.artist);
        }
        let current = self.station.queue.lock().expect("queue").current();
        if current
            .as_ref()
            .is_some_and(|c| song_matches_query(c, query))
        {
            return self.advance_one_track().await;
        }
        let Some(track) = self
            .station
            .search_first_flags_async(query, &cmd.flags)
            .await
        else {
            return format!("No results found for: {query}");
        };
        if current
            .as_ref()
            .is_some_and(|c| is_same_playback_track(c, &track.id, &track.title, &track.artist))
        {
            return self.advance_one_track().await;
        }
        let queued = QueuedSong::from_track(track.clone(), QueueSource::User);
        let was_idle = {
            let q = self.station.queue.lock().expect("queue");
            q.get_current_index() < 0 || q.size() == 0
        };
        self.station.queue.lock().expect("queue").add_next(queued);
        let target_idx = {
            let q = self.station.queue.lock().expect("queue");
            if was_idle {
                q.size() - 1
            } else {
                q.get_current_index() as usize + 1
            }
        };
        let target = {
            let mut q = self.station.queue.lock().expect("queue");
            q.play_at(target_idx)
        };
        let Some(target) = target else {
            return format!("Cannot play: {}", track.title);
        };
        self.station.player.reset_failures();
        if !self.station.resolve_and_play_async(&target).await {
            return format!("Cannot play: {}", track.title);
        }
        format!("Now playing: {} - {}", track.title, track.artist)
    }

    async fn cmd_prev(&self) -> String {
        for _ in 0..4 {
            let prev = {
                let mut q = self.station.queue.lock().expect("queue");
                q.prev()
            };
            let Some(prev) = prev else {
                return "No previous song".into();
            };
            if self.station.resolve_and_play_async(&prev).await {
                return format!("Now playing: {} - {}", prev.name, prev.artist);
            }
        }
        "Cannot play any previous songs (all failed to resolve)".into()
    }

    fn cmd_vol(&self, cmd: &ParsedCommand) -> String {
        let Ok(vol) = cmd.args.trim().parse::<i32>() else {
            return format!("Usage: {}vol <0-100>", self.prefix);
        };
        if !(0..=100).contains(&vol) {
            return format!("Usage: {}vol <0-100>", self.prefix);
        }
        self.station.player.set_volume(vol);
        format!("Volume set to {vol}%")
    }

    fn cmd_now(&self) -> String {
        match self.station.queue.lock().expect("queue").current() {
            Some(s) => format!(
                "Now playing: {} - {} [{}] ({})",
                s.name, s.artist, s.album, s.platform
            ),
            None => "Nothing is playing".into(),
        }
    }

    fn cmd_queue(&self) -> String {
        let q = self.station.queue.lock().expect("queue");
        let songs = q.list();
        if songs.is_empty() {
            return "Queue is empty".into();
        }
        let cur = q.get_current_index();
        let lines: Vec<String> = songs
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let marker = if i as i32 == cur { "▶ " } else { "  " };
                format!("{marker}{}. {} - {}", i + 1, s.name, s.artist)
            })
            .collect();
        format!(
            "Queue ({} songs, mode: {}):\n{}",
            songs.len(),
            q.get_mode(),
            lines.join("\n")
        )
    }

    fn cmd_clear(&self) -> String {
        self.station.player.stop();
        self.station.queue.lock().expect("queue").clear();
        "Queue cleared".into()
    }

    fn cmd_remove(&self, cmd: &ParsedCommand) -> String {
        let Ok(n) = cmd.args.trim().parse::<i32>() else {
            return format!("Usage: {}remove <number>", self.prefix);
        };
        let index = n - 1;
        if index < 0 {
            return format!("Usage: {}remove <number>", self.prefix);
        }
        match self
            .station
            .queue
            .lock()
            .expect("queue")
            .remove(index as usize)
        {
            Some(r) => format!("Removed: {}", r.name),
            None => "Invalid position".into(),
        }
    }

    fn cmd_mode(&self, cmd: &ParsedCommand) -> String {
        let Some(mode) = PlayMode::parse(cmd.args.trim()) else {
            return format!("Usage: {}mode <seq|loop|random|rloop>", self.prefix);
        };
        self.station.queue.lock().expect("queue").set_mode(mode);
        format!("Play mode set to: {}", cmd.args.trim())
    }

    async fn cmd_ban(&self, cmd: &ParsedCommand) -> String {
        let Some(bl) = self.station.blacklist.as_ref() else {
            return "Playback ban list is not available.".into();
        };
        let p = &self.prefix;
        let arg = cmd.args.trim();
        if arg.eq_ignore_ascii_case("list") {
            let entries = bl.list();
            if entries.is_empty() {
                return "Ban list is empty.".into();
            }
            let lines: Vec<String> = entries
                .iter()
                .take(15)
                .enumerate()
                .map(|(i, e)| {
                    let label = [e.name.as_deref(), e.artist.as_deref()]
                        .into_iter()
                        .flatten()
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                        .join(" — ");
                    let label = if label.is_empty() {
                        e.track_key.clone()
                    } else {
                        label
                    };
                    format!("{}. {label}", i + 1)
                })
                .collect();
            return format!("Banned tracks (latest {}):\n{}", lines.len(), lines.join("\n"));
        }
        let Some(song) = self.station.queue.lock().expect("queue").current() else {
            return format!("Nothing is playing. Start a track, then {p}ban — or {p}ban list.");
        };
        if is_ban_protected(
            Some(&song.name),
            Some(&song.artist),
            &self.protected_artists,
        ) {
            return ban_protected_message(Some(&song.name), Some(&song.artist));
        }
        if bl.is_blacklisted(Some(&song.id), Some(&song.name), Some(&song.artist)) {
            return format!(
                "Already banned: {} — {}. Use {p}skip if it's still playing.",
                song.name, song.artist
            );
        }
        let reason = if arg.is_empty() { "chat !ban" } else { arg };
        let mut keys = vec![song.id.clone()];
        if let Some(vid) = extract_video_id(&song.id) {
            keys.push(vid);
        }
        if let Some(vid) = song.name.find('[').and_then(|_| extract_video_id_from_name(&song.name))
        {
            keys.push(vid);
        }
        for k in &keys {
            let _ = bl.add(
                k,
                Some(song.platform.as_str()),
                Some(&song.name),
                Some(&song.artist),
                Some(reason),
                None,
            );
        }
        let next_msg = self.cmd_skip().await;
        format!("Banned: {} — {}. {next_msg}", song.name, song.artist)
    }

    fn cmd_unban(&self, cmd: &ParsedCommand) -> String {
        let Some(bl) = self.station.blacklist.as_ref() else {
            return "Playback ban list is not available.".into();
        };
        let p = &self.prefix;
        let arg = cmd.args.trim();
        if arg.is_empty() {
            let Some(song) = self.station.queue.lock().expect("queue").current() else {
                return format!("Nothing playing. Usage: {p}unban <track id or name> · {p}ban list");
            };
            if !bl.is_blacklisted(Some(&song.id), Some(&song.name), Some(&song.artist)) {
                return format!("Current track is not banned: {}", song.name);
            }
            if bl.remove(&song.id) {
                return format!("Unbanned: {} — {}", song.name, song.artist);
            }
            return format!("Could not unban: {} — {}", song.name, song.artist);
        }
        if bl.remove(arg) {
            return format!("Unbanned: {arg}");
        }
        let q = arg.to_lowercase();
        if let Some(hit) = bl.list().into_iter().find(|e| {
            format!("{} {} {}", e.track_key, e.name.as_deref().unwrap_or(""), e.artist.as_deref().unwrap_or(""))
                .to_lowercase()
                .contains(&q)
        }) {
            if bl.remove(&hit.track_key) {
                let label = [hit.name.as_deref(), hit.artist.as_deref()]
                    .into_iter()
                    .flatten()
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(" — ");
                return format!("Unbanned: {}", if label.is_empty() { hit.track_key } else { label });
            }
        }
        format!("Not on ban list: {arg}. Try {p}ban list.")
    }

    async fn cmd_playlist(&self, cmd: &ParsedCommand) -> String {
        let p = &self.prefix;
        if cmd.args.trim().is_empty() {
            return format!("Usage: {p}playlist <playlist name or ID>");
        }
        let Some((_pl, songs)) = self.station.local.find_playlist(&cmd.args) else {
            return format!("Playlist is empty or not found: {}", cmd.args);
        };
        if songs.is_empty() {
            return format!("Playlist is empty or not found: {}", cmd.args);
        }
        let n = songs.len();
        match self
            .station
            .play_tracks(songs, PlayMode::Sequential)
            .await
        {
            Some(first) => format!(
                "Loaded {n} songs. Now playing: {} - {}",
                first.name, first.artist
            ),
            None => format!("Playlist is empty or not found: {}", cmd.args),
        }
    }

    async fn cmd_album(&self, cmd: &ParsedCommand) -> String {
        let p = &self.prefix;
        if cmd.args.trim().is_empty() {
            return format!("Usage: {p}album <album name>");
        }
        let songs = self.station.local.album_songs(&cmd.args);
        if songs.is_empty() {
            return format!("No albums found for: {}", cmd.args);
        }
        let n = songs.len();
        match self
            .station
            .play_tracks(songs, PlayMode::Sequential)
            .await
        {
            Some(first) => format!(
                "Loaded {n} songs. Now playing: {} - {}",
                first.name, first.artist
            ),
            None => "Album is empty or not found".into(),
        }
    }

    async fn cmd_artist(&self, cmd: &ParsedCommand) -> String {
        let p = &self.prefix;
        if cmd.args.trim().is_empty() {
            return format!("Usage: {p}artist <artist name>");
        }
        let mut songs = self.station.local.artist_songs(&cmd.args, 50);
        if songs.is_empty() && !cmd.flags.contains(&'l') {
            songs = self
                .station
                .youtube
                .search_async(&cmd.args, 20, mp_music::YoutubePolicy::Search)
                .await
                .into_iter()
                .filter(|t| t.artist.to_ascii_lowercase().contains(&cmd.args.to_ascii_lowercase()))
                .collect();
            if songs.is_empty() {
                songs = self
                    .station
                    .youtube
                    .search_async(&cmd.args, 20, mp_music::YoutubePolicy::Search)
                    .await;
            }
        }
        if songs.is_empty() {
            return format!("No results found for artist: {}", cmd.args);
        }
        let n = songs.len();
        match self.station.play_tracks(songs, PlayMode::Loop).await {
            Some(first) => format!(
                "Artist mode: {} — {n} songs loaded. Now playing: {} - {}",
                cmd.args, first.name, first.artist
            ),
            None => format!("No results found for artist: {}", cmd.args),
        }
    }

    fn cmd_lyrics(&self) -> String {
        let Some(cur) = self.station.queue.lock().expect("queue").current() else {
            return "Nothing is playing".into();
        };
        format!("No lyrics available for {}.", cur.name)
    }

    async fn cmd_test(&self) -> String {
        match self.station.play_demo_track_async().await {
            ReplaceResult::Ok(t) => {
                let via = match t.platform {
                    mp_music::Platform::Local => "local",
                    mp_music::Platform::Youtube => "youtube",
                    mp_music::Platform::Stream => "stream",
                };
                format!("Now playing: {} - {} ({via})", t.title, t.artist)
            }
            ReplaceResult::NoResults => {
                format!("No results found for: {}", mp_music::DEFAULT_DEMO_VIDEO_URL)
            }
            ReplaceResult::CantPlay(t) => format!("Cannot play: {}", t.title),
        }
    }

    fn cmd_help(&self) -> String {
        let p = &self.prefix;
        [
            "Moneypenny Commands:",
            "",
            "Music",
            &format!("{p}play <query> — Start now (local library)."),
            &format!("{p}add <query> — Append to human queue (starts if idle)"),
            &format!("{p}playnext <query> ({p}pn) — Insert after current"),
            &format!("{p}skip ({p}s / {p}n) — Advance one track · {p}prev · {p}pause · {p}resume · {p}stop"),
            &format!("{p}jump <query> ({p}go) — Jump to queue match or search+start now"),
            &format!("{p}queue ({p}list) · {p}now · {p}clear · {p}remove <n> · {p}vol <0-100> · {p}mode <seq|loop|random|rloop>"),
            &format!("{p}ban [reason] · {p}ban list · {p}unban"),
            &format!("{p}test — Demo track (Ella Langley Choosin' Texas, local then YouTube)"),
            &format!("{p}playlist <name> · {p}album <name> · {p}artist <name> · {p}lyrics"),
            &format!("{p}rate <1-5> [song] · {p}unrate — Rate the current (or a searched) track"),
            &format!("{p}karaoke [on|off] — Keep music loud while listening (duck 80 instead of 15; karyoke/kareoke work)"),
            "",
            "Ask / memory",
            &format!("{p}ask <question> — Grounded Q&A (RAG when enabled)"),
            &format!("{p}analyst <task> · {p}agent <task> — Delegate to the analysis model"),
            &format!("{p}remember <fact> · {p}recall · {p}forget <n|all> — Per-user memory"),
            &format!("{p}reindex [source.md] — Re-embed doctrine"),
            "",
            "Radio",
            &format!("{p}radio [on|off|status|ops <profile>] — Autonomous DJ (local seed)"),
            "",
            &format!("{p}mute <nick|clid> · {p}kick <nick|clid> — Channel moderation"),
            &format!("{p}help — This message"),
        ]
        .join("\n")
    }
}

fn extract_video_id_from_name(name: &str) -> Option<String> {
    let start = name.find('[')?;
    let end = name[start + 1..].find(']')?;
    let inner = &name[start + 1..start + 1 + end];
    extract_video_id(inner)
}

pub fn query_tokens(query: &str) -> Vec<String> {
    query
        .to_lowercase()
        .split_whitespace()
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn song_matches_query(song: &QueuedSong, query: &str) -> bool {
    let tokens = query_tokens(query);
    if tokens.is_empty() {
        return false;
    }
    let hay = format!("{} {} {}", song.name, song.artist, song.album).to_lowercase();
    tokens.iter().all(|t| hay.contains(t))
}

pub fn is_same_playback_track(a: &QueuedSong, b_id: &str, b_name: &str, b_artist: &str) -> bool {
    if a.id == b_id {
        return true;
    }
    let va = extract_video_id(&a.id);
    let vb = extract_video_id(b_id);
    if va.is_some() && va == vb {
        return true;
    }
    let ka = blacklist_content_key(Some(&a.name), Some(&a.artist));
    let kb = blacklist_content_key(Some(b_name), Some(b_artist));
    ka.is_some() && ka == kb
}

pub fn find_queue_index_by_query(queue: &mp_music::PlayQueue, query: &str) -> Option<usize> {
    let tokens = query_tokens(query);
    if tokens.is_empty() {
        return None;
    }
    let songs = queue.list();
    let cur = queue.get_current_index();
    let matches = |i: usize| song_matches_query(&songs[i], query);
    let start = if cur < 0 { 0 } else { cur as usize + 1 };
    for i in start..songs.len() {
        if matches(i) {
            return Some(i);
        }
    }
    for i in 0..songs.len() {
        if i as i32 == cur {
            continue;
        }
        if matches(i) {
            return Some(i);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::Arc;

    fn tmp_station() -> (std::path::PathBuf, Arc<mp_music::MusicStation>) {
        let dir = std::env::temp_dir().join(format!(
            "mp-ex-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("rock")).unwrap();
        std::fs::write(dir.join("rock/titanium.mp3"), b"fake").unwrap();
        std::fs::write(dir.join("rock/hello.mp3"), b"fake").unwrap();
        let st = Arc::new(mp_music::MusicStation::new(&dir, None));
        st.set_dry_run(true);
        (dir, st)
    }

    fn cmd(name: &str, args: &str) -> ParsedCommand {
        cmd_flags(name, args, HashSet::new())
    }

    fn cmd_flags(name: &str, args: &str, flags: HashSet<char>) -> ParsedCommand {
        ParsedCommand {
            name: name.into(),
            args: args.into(),
            raw_args: if args.is_empty() {
                vec![]
            } else {
                args.split_whitespace().map(str::to_string).collect()
            },
            flags,
        }
    }

    #[tokio::test]
    async fn play_sets_sequential_and_does_not_loop() {
        let (dir, st) = tmp_station();
        let ex = CommandExecutor::new(st.clone(), "!");
        let out = ex.execute(&cmd("play", "titanium")).await.unwrap();
        assert!(out.starts_with("Now playing:"), "{out}");
        let q = st.queue.lock().unwrap();
        assert_eq!(q.get_mode(), PlayMode::Sequential);
        assert_eq!(q.size(), 1);
        drop(q);
        let skip = ex.execute(&cmd("skip", "ignored-query")).await.unwrap();
        assert_eq!(skip, "Queue is empty");
        assert!(!skip.starts_with('!'));
        assert!(!skip.to_lowercase().contains("only advance"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn test_plays_local_demo_copy() {
        let (dir, st) = tmp_station();
        std::fs::write(
            dir.join("Ella Langley - Choosin Texas [hLOheGDwD_0].mp3"),
            b"fake",
        )
        .unwrap();
        st.local.refresh();
        let ex = CommandExecutor::new(st.clone(), "!");
        let out = ex.execute(&cmd("test", "")).await.unwrap();
        assert!(out.starts_with("Now playing:"), "{out}");
        assert!(out.to_lowercase().contains("ella") || out.contains("hLOheGDwD_0"), "{out}");
        assert!(out.contains("(local)"), "{out}");
        let q = st.queue.lock().unwrap();
        assert_eq!(q.get_mode(), PlayMode::Sequential);
        assert_eq!(q.size(), 1);
        drop(q);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn play_stream_flag_skips_local() {
        let (dir, st) = tmp_station();
        let ex = CommandExecutor::new(st.clone(), "!");
        let mut s = HashSet::new();
        s.insert('s');
        let out = ex
            .execute(&cmd_flags("play", "https://example.com/radio.mp3", s))
            .await
            .unwrap();
        assert!(
            out.starts_with("Now playing:") || out.starts_with("Cannot play:"),
            "{out}"
        );
        let cur = st.queue.lock().unwrap().current().unwrap();
        assert_eq!(cur.platform, mp_music::Platform::Stream);
        let mut l = HashSet::new();
        l.insert('l');
        let miss = ex
            .execute(&cmd_flags("play", "https://example.com/radio.mp3", l))
            .await
            .unwrap();
        assert!(miss.starts_with("No results"), "{miss}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn skip_with_args_only_advances() {
        let (dir, st) = tmp_station();
        let ex = CommandExecutor::new(st.clone(), "!");
        let _ = ex.execute(&cmd("play", "hello")).await;
        let _ = ex.execute(&cmd("add", "titanium")).await;
        let out = ex.execute(&cmd("next", "titanium")).await.unwrap();
        assert!(out.starts_with("Skipped") || out == "Queue is empty", "{out}");
        assert!(!out.starts_with('!'));
        assert!(!out.to_lowercase().contains("only advance"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn queue_lists_mode() {
        let (dir, st) = tmp_station();
        let ex = CommandExecutor::new(st.clone(), "!");
        let _ = ex.execute(&cmd("play", "hello")).await;
        let out = ex.execute(&cmd("queue", "")).await.unwrap();
        assert!(out.contains("mode: seq"), "{out}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn rights_not_in_executor() {
        // Executor does not consult rights — the bot loop does.
        let (dir, st) = tmp_station();
        let ex = CommandExecutor::new(st, "!");
        let out = ex.execute(&cmd("vol", "80")).await.unwrap();
        assert_eq!(out, "Volume set to 80%");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn queue_replacing_sites_set_explicit_mode() {
        let src = include_str!("executor.rs");
        let station_src = include_str!("../../mp-music/src/station.rs");
        let queue_src = include_str!("../../mp-music/src/queue.rs");
        assert!(
            station_src.contains("replace_queue_with_song"),
            "station must replace via replace_queue_with_song (sets Sequential)"
        );
        assert!(
            queue_src.contains("set_mode(PlayMode::Sequential)"),
            "replace_queue_with_song must set Sequential"
        );
        let mut from = 0;
        while let Some(at) = src[from..].find("queue.clear(") {
            let abs = from + at;
            let rest = &src[abs..abs + 800.min(src.len() - abs)];
            if rest.contains("add(") && (rest.contains(".play(") || rest.contains("play()")) {
                assert!(
                    rest.contains("Sequential") || rest.contains("set_mode"),
                    "executor.rs replacement site at {abs} did not set Sequential"
                );
            }
            from = abs + 1;
        }
    }

    #[tokio::test]
    async fn playlist_album_artist_from_library() {
        let (dir, st) = tmp_station();
        let a = dir.join("rock/titanium.mp3");
        let b = dir.join("rock/hello.mp3");
        std::fs::write(
            dir.join("mix.m3u"),
            format!("{}\n{}\n", a.display(), b.display()),
        )
        .unwrap();
        st.local.refresh();
        let ex = CommandExecutor::new(st.clone(), "!");
        let pl = ex.execute(&cmd("playlist", "mix")).await.unwrap();
        assert!(pl.contains("Loaded 2 songs"), "{pl}");
        let q = st.queue.lock().unwrap();
        assert_eq!(q.size(), 2);
        assert_eq!(q.get_mode(), PlayMode::Sequential);
        drop(q);

        let al = ex.execute(&cmd("album", "rock")).await.unwrap();
        assert!(al.contains("Loaded"), "{al}");

        let ar = ex.execute(&cmd("artist", "Unknown")).await.unwrap();
        assert!(ar.contains("Artist mode"), "{ar}");
        let q = st.queue.lock().unwrap();
        assert_eq!(q.get_mode(), PlayMode::Loop);
        drop(q);

        let ly = ex.execute(&cmd("lyrics", "")).await.unwrap();
        assert!(ly.contains("No lyrics") || ly.contains("Nothing"), "{ly}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
