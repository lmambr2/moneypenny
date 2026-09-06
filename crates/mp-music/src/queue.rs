// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! PlayQueue — port of `bot/src/audio/queue.ts`.
//! Default mode is RandomLoop. Commands that REPLACE the queue must call
//! [`PlayQueue::set_mode`] with an explicit mode (usually Sequential) before
//! [`PlayQueue::play`], or a one-song queue loops forever.

use crate::track::QueuedSong;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayMode {
    Sequential,
    Loop,
    Random,
    RandomLoop,
}

impl PlayMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sequential => "seq",
            Self::Loop => "loop",
            Self::Random => "random",
            Self::RandomLoop => "rloop",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "seq" => Some(Self::Sequential),
            "loop" => Some(Self::Loop),
            "random" => Some(Self::Random),
            "rloop" => Some(Self::RandomLoop),
            _ => None,
        }
    }
}

impl std::fmt::Display for PlayMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

pub struct PlayQueue {
    songs: Vec<QueuedSong>,
    current_index: i32,
    mode: PlayMode,
    played_indices: std::collections::HashSet<usize>,
    history: Vec<usize>,
    forward_stack: Vec<usize>,
}

const HISTORY_LIMIT: usize = 50;

impl Default for PlayQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl PlayQueue {
    pub fn new() -> Self {
        Self {
            songs: Vec::new(),
            current_index: -1,
            mode: PlayMode::RandomLoop,
            played_indices: std::collections::HashSet::new(),
            history: Vec::new(),
            forward_stack: Vec::new(),
        }
    }

    fn push_history(&mut self, idx: i32) {
        if idx < 0 {
            return;
        }
        let idx = idx as usize;
        if idx >= self.songs.len() {
            return;
        }
        self.history.push(idx);
        if self.history.len() > HISTORY_LIMIT {
            self.history.remove(0);
        }
    }

    /// Radio fill always appends. Human/default inserts after current and
    /// after other human tracks, before the first radio filler.
    pub fn add(&mut self, song: QueuedSong) -> usize {
        if song.is_radio_fill() || self.songs.is_empty() {
            self.songs.push(song);
            return self.songs.len() - 1;
        }
        let start = if self.current_index < 0 {
            0
        } else {
            self.current_index as usize + 1
        };
        let mut insert_at = self.songs.len();
        for i in start..self.songs.len() {
            if self.songs[i].is_radio_fill() {
                insert_at = i;
                break;
            }
        }
        if insert_at >= self.songs.len() {
            self.songs.push(song);
            return self.songs.len() - 1;
        }
        self.songs.insert(insert_at, song);
        self.shift_indices_after_insert(insert_at);
        insert_at
    }

    pub fn add_many(&mut self, songs: Vec<QueuedSong>) -> i32 {
        let mut first = -1i32;
        for s in songs {
            let at = self.add(s);
            if first < 0 {
                first = at as i32;
            }
        }
        first
    }

    pub fn add_next(&mut self, song: QueuedSong) {
        if self.current_index < 0 || self.songs.is_empty() {
            self.songs.push(song);
            return;
        }
        let insert_at = self.current_index as usize + 1;
        self.songs.insert(insert_at, song);
        self.shift_indices_after_insert(insert_at);
    }

    fn shift_indices_after_insert(&mut self, insert_at: usize) {
        self.played_indices = self
            .played_indices
            .iter()
            .map(|&i| if i >= insert_at { i + 1 } else { i })
            .collect();
        for i in &mut self.history {
            if *i >= insert_at {
                *i += 1;
            }
        }
        for i in &mut self.forward_stack {
            if *i >= insert_at {
                *i += 1;
            }
        }
    }

    pub fn remove(&mut self, index: usize) -> Option<QueuedSong> {
        if index >= self.songs.len() {
            return None;
        }
        let removed = self.songs.remove(index);
        if (index as i32) <= self.current_index {
            self.current_index -= 1;
        }
        self.played_indices = self
            .played_indices
            .iter()
            .filter(|&&i| i != index)
            .map(|&i| if i > index { i - 1 } else { i })
            .collect();
        self.history = self
            .history
            .iter()
            .copied()
            .filter(|&i| i != index)
            .map(|i| if i > index { i - 1 } else { i })
            .collect();
        self.forward_stack = self
            .forward_stack
            .iter()
            .copied()
            .filter(|&i| i != index)
            .map(|i| if i > index { i - 1 } else { i })
            .collect();
        Some(removed)
    }

    pub fn clear(&mut self) {
        self.songs.clear();
        self.current_index = -1;
        self.played_indices.clear();
        self.history.clear();
        self.forward_stack.clear();
    }

    pub fn play(&mut self) -> Option<QueuedSong> {
        if self.songs.is_empty() {
            return None;
        }
        self.played_indices.clear();
        self.history.clear();
        self.forward_stack.clear();
        self.current_index = 0;
        self.played_indices.insert(0);
        Some(self.songs[0].clone())
    }

    pub fn play_at(&mut self, index: usize) -> Option<QueuedSong> {
        if index >= self.songs.len() {
            return None;
        }
        self.push_history(self.current_index);
        self.played_indices.clear();
        self.forward_stack.clear();
        self.current_index = index as i32;
        self.played_indices.insert(index);
        Some(self.songs[index].clone())
    }

    pub fn next(&mut self) -> Option<QueuedSong> {
        if self.songs.is_empty() {
            return None;
        }
        match self.mode {
            PlayMode::Sequential => {
                let next_index = self.current_index + 1;
                if next_index >= self.songs.len() as i32 {
                    return None;
                }
                self.push_history(self.current_index);
                self.current_index = next_index;
                Some(self.songs[next_index as usize].clone())
            }
            PlayMode::Loop => {
                self.push_history(self.current_index);
                self.current_index = (self.current_index + 1) % self.songs.len() as i32;
                Some(self.songs[self.current_index as usize].clone())
            }
            PlayMode::Random | PlayMode::RandomLoop => self.next_random(),
        }
    }

    fn next_random(&mut self) -> Option<QueuedSong> {
        while let Some(target) = self.forward_stack.pop() {
            if target >= self.songs.len() || target as i32 == self.current_index {
                continue;
            }
            self.push_history(self.current_index);
            self.current_index = target as i32;
            self.played_indices.insert(target);
            return Some(self.songs[target].clone());
        }

        let mut unplayed: Vec<usize> = (0..self.songs.len())
            .filter(|i| !self.played_indices.contains(i))
            .collect();

        if unplayed.is_empty() {
            if self.mode == PlayMode::Random {
                return None;
            }
            if self.songs.len() == 1 {
                self.push_history(self.current_index);
                self.current_index = 0;
                self.played_indices = std::collections::HashSet::from([0]);
                return Some(self.songs[0].clone());
            }
            self.played_indices.clear();
            for i in 0..self.songs.len() {
                if i as i32 != self.current_index {
                    unplayed.push(i);
                }
            }
        }

        let pick = rand::random::<usize>() % unplayed.len();
        let next_index = unplayed[pick];
        self.push_history(self.current_index);
        self.current_index = next_index as i32;
        self.played_indices.insert(next_index);
        Some(self.songs[next_index].clone())
    }

    pub fn prev(&mut self) -> Option<QueuedSong> {
        if self.songs.is_empty() {
            return None;
        }
        if self.current_index >= 0 && self.forward_stack.len() < HISTORY_LIMIT {
            self.forward_stack.push(self.current_index as usize);
        }
        while let Some(idx) = self.history.pop() {
            if idx < self.songs.len() {
                self.current_index = idx as i32;
                self.played_indices.insert(idx);
                return Some(self.songs[idx].clone());
            }
        }
        if self.mode == PlayMode::Random || self.mode == PlayMode::RandomLoop {
            return None;
        }
        let prev_index = self.current_index - 1;
        if prev_index < 0 {
            if self.mode == PlayMode::Sequential {
                return None;
            }
            self.current_index = self.songs.len() as i32 - 1;
        } else {
            self.current_index = prev_index;
        }
        self.played_indices.insert(self.current_index as usize);
        Some(self.songs[self.current_index as usize].clone())
    }

    pub fn current(&self) -> Option<QueuedSong> {
        if self.current_index < 0 || self.current_index >= self.songs.len() as i32 {
            return None;
        }
        Some(self.songs[self.current_index as usize].clone())
    }

    pub fn list(&self) -> Vec<QueuedSong> {
        self.songs.clone()
    }

    pub fn size(&self) -> usize {
        self.songs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.songs.is_empty()
    }

    pub fn get_mode(&self) -> PlayMode {
        self.mode
    }

    pub fn set_mode(&mut self, mode: PlayMode) {
        self.mode = mode;
        self.played_indices.clear();
        self.history.clear();
        self.forward_stack.clear();
        if self.current_index >= 0 {
            self.played_indices.insert(self.current_index as usize);
        }
    }

    pub fn get_current_index(&self) -> i32 {
        self.current_index
    }

    pub fn unplayed_count(&self) -> usize {
        self.songs.len().saturating_sub(self.played_indices.len())
    }
}

/// Replace the queue with one track and force Sequential.
/// Any command that clears+refills+plays must go through here (or call
/// `set_mode(Sequential)` itself) so RandomLoop cannot inherit onto a
/// one-song queue.
pub fn replace_queue_with_song(queue: &mut PlayQueue, song: QueuedSong) -> Option<QueuedSong> {
    queue.clear();
    queue.add(song);
    queue.set_mode(PlayMode::Sequential);
    queue.play()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::track::{Platform, QueueSource};

    fn song(id: &str) -> QueuedSong {
        song_named(id, id)
    }
    fn song_named(id: &str, name: &str) -> QueuedSong {
        QueuedSong {
            id: id.into(),
            name: name.into(),
            artist: "Artist".into(),
            album: "Album".into(),
            platform: Platform::Youtube,
            url: format!("https://example.com/{id}.mp3"),
            cover_url: String::new(),
            duration: 240,
            source: QueueSource::User,
        }
    }
    fn radio(id: &str) -> QueuedSong {
        let mut s = song(id);
        s.source = QueueSource::Radio;
        s
    }

    #[test]
    fn starts_empty() {
        let q = PlayQueue::new();
        assert!(q.is_empty());
        assert!(q.current().is_none());
        assert_eq!(q.size(), 0);
    }

    #[test]
    fn user_add_jumps_radio() {
        let mut q = PlayQueue::new();
        q.add(radio("now"));
        q.play();
        q.add(radio("r1"));
        q.add(radio("r2"));
        let at = q.add(song("user1"));
        assert_eq!(at, 1);
        assert_eq!(
            q.list().iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["now", "user1", "r1", "r2"]
        );
        q.add(song("user2"));
        assert_eq!(
            q.list().iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["now", "user1", "user2", "r1", "r2"]
        );
        q.add(radio("r3"));
        assert_eq!(
            q.list().iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["now", "user1", "user2", "r1", "r2", "r3"]
        );
    }

    #[test]
    fn sequential_advances_and_ends() {
        let mut q = PlayQueue::new();
        q.set_mode(PlayMode::Sequential);
        q.add(song("1"));
        q.add(song("2"));
        q.add(song("3"));
        q.play();
        assert_eq!(q.current().unwrap().id, "1");
        assert_eq!(q.next().unwrap().id, "2");
        assert_eq!(q.next().unwrap().id, "3");
        assert!(q.next().is_none());
    }

    #[test]
    fn loop_wraps() {
        let mut q = PlayQueue::new();
        q.set_mode(PlayMode::Loop);
        q.add(song("1"));
        q.play();
        assert_eq!(q.next().unwrap().id, "1");
    }

    #[test]
    fn defaults_to_random_loop() {
        assert_eq!(PlayQueue::new().get_mode(), PlayMode::RandomLoop);
    }

    #[test]
    fn random_loop_one_song_replays() {
        let mut q = PlayQueue::new();
        q.add(song("only"));
        q.play();
        assert_eq!(q.next().unwrap().id, "only");
    }

    #[test]
    fn replace_forces_sequential() {
        let mut q = PlayQueue::new();
        assert_eq!(q.get_mode(), PlayMode::RandomLoop);
        replace_queue_with_song(&mut q, song("a"));
        assert_eq!(q.get_mode(), PlayMode::Sequential);
        assert_eq!(q.current().unwrap().id, "a");
        assert!(q.next().is_none(), "one-song Sequential must run dry");
    }

    #[test]
    fn remove_before_current_shifts() {
        let mut q = PlayQueue::new();
        q.set_mode(PlayMode::Sequential);
        q.add(song("A"));
        q.add(song("B"));
        q.add(song("C"));
        q.play_at(2);
        q.remove(0);
        assert_eq!(q.current().unwrap().id, "C");
        assert_eq!(q.get_current_index(), 1);
    }

    #[test]
    fn remove_current_lets_next_advance() {
        let mut q = PlayQueue::new();
        q.set_mode(PlayMode::Sequential);
        q.add(song("A"));
        q.add(song("B"));
        q.add(song("C"));
        q.add(song("D"));
        q.play_at(2);
        q.remove(2);
        assert_eq!(q.next().unwrap().id, "D");
    }

    #[test]
    fn prev_sequential() {
        let mut q = PlayQueue::new();
        q.set_mode(PlayMode::Sequential);
        q.add(song("1"));
        q.add(song("2"));
        q.play();
        q.next();
        assert_eq!(q.current().unwrap().id, "2");
        q.prev();
        assert_eq!(q.current().unwrap().id, "1");
    }
}
