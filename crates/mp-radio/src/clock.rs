// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! FormatClock — pure rotation wheel (`docs/radio.md` §7).

use mp_config::{BumperSource, FormatClockSpec, SlotKind, WheelSlot};

#[derive(Debug, Clone)]
pub struct FormatClock {
    cursor: usize,
    wheel: Vec<WheelSlot>,
}

impl FormatClock {
    pub fn new(wheel: Vec<WheelSlot>) -> Self {
        let wheel = if wheel.is_empty() {
            vec![WheelSlot {
                slot: SlotKind::Song,
                sources: Vec::new(),
                topic: None,
            }]
        } else {
            wheel
        };
        Self { cursor: 0, wheel }
    }

    /// N song slots then a bumper. `n == 0` → never inject on a count.
    pub fn from_every_n(n: u32, sources: Vec<BumperSource>) -> Self {
        if n == 0 {
            return Self::new(vec![WheelSlot {
                slot: SlotKind::Song,
                sources: Vec::new(),
                topic: None,
            }]);
        }
        let mut wheel = Vec::with_capacity(n as usize + 1);
        for _ in 0..n {
            wheel.push(WheelSlot {
                slot: SlotKind::Song,
                sources: Vec::new(),
                topic: None,
            });
        }
        wheel.push(WheelSlot {
            slot: SlotKind::Bumper,
            sources,
            topic: None,
        });
        Self::new(wheel)
    }

    pub fn for_config(
        every_n_songs: u32,
        spec: Option<&FormatClockSpec>,
        sources: Vec<BumperSource>,
    ) -> Self {
        if let Some(spec) = spec {
            if !spec.wheel.is_empty() {
                return Self::new(spec.wheel.clone());
            }
        }
        Self::from_every_n(every_n_songs, sources)
    }

    pub fn next_slot(&mut self) -> WheelSlot {
        let slot = self.wheel[self.cursor % self.wheel.len()].clone();
        self.cursor += 1;
        slot
    }

    pub fn peek(&self) -> WheelSlot {
        self.wheel[self.cursor % self.wheel.len()].clone()
    }

    pub fn songs_until_non_song(&self) -> Option<u32> {
        let mut songs = 0u32;
        for i in 0..self.wheel.len() {
            let slot = &self.wheel[(self.cursor + i) % self.wheel.len()];
            if slot.slot != SlotKind::Song {
                return Some(songs);
            }
            songs += 1;
        }
        None
    }

    pub fn reset(&mut self) {
        self.cursor = 0;
    }

    pub fn len(&self) -> usize {
        self.wheel.len()
    }
}

/// Quiet-hours windows are local HH:MM. Fail open on malformed entries.
pub fn is_within_quiet_hours(now_minutes: u32, windows: &[(u32, u32)]) -> bool {
    for &(from, to) in windows {
        if from == to {
            continue;
        }
        let in_window = if from < to {
            now_minutes >= from && now_minutes < to
        } else {
            now_minutes >= from || now_minutes < to
        };
        if in_window {
            return true;
        }
    }
    false
}

pub fn parse_hhmm(s: &str) -> Option<u32> {
    let s = s.trim();
    let (h, m) = s.split_once(':')?;
    let h: u32 = h.parse().ok()?;
    let m: u32 = m.parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some(h * 60 + m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mp_config::SlotKind;

    #[test]
    fn from_every_n_synthesizes_n_songs_then_bumper() {
        let mut c = FormatClock::from_every_n(3, Vec::new());
        assert_eq!(c.len(), 4);
        let kinds: Vec<_> = (0..4).map(|_| c.next_slot().slot).collect();
        assert_eq!(
            kinds,
            [
                SlotKind::Song,
                SlotKind::Song,
                SlotKind::Song,
                SlotKind::Bumper
            ]
        );
    }

    #[test]
    fn cycles_the_wheel() {
        let mut c = FormatClock::from_every_n(1, Vec::new());
        let seq: Vec<_> = (0..5).map(|_| c.next_slot().slot).collect();
        assert_eq!(
            seq,
            [
                SlotKind::Song,
                SlotKind::Bumper,
                SlotKind::Song,
                SlotKind::Bumper,
                SlotKind::Song
            ]
        );
    }

    #[test]
    fn n_zero_is_all_songs() {
        let mut c = FormatClock::from_every_n(0, Vec::new());
        assert_eq!(c.next_slot().slot, SlotKind::Song);
        assert_eq!(c.next_slot().slot, SlotKind::Song);
    }

    #[test]
    fn empty_wheel_degrades_to_song() {
        let mut c = FormatClock::new(Vec::new());
        assert_eq!(c.next_slot().slot, SlotKind::Song);
    }

    #[test]
    fn songs_until_non_song_counts_down() {
        let mut c = FormatClock::from_every_n(2, Vec::new());
        assert_eq!(c.songs_until_non_song(), Some(2));
        c.next_slot();
        assert_eq!(c.songs_until_non_song(), Some(1));
        c.next_slot();
        assert_eq!(c.songs_until_non_song(), Some(0));
        c.next_slot();
        assert_eq!(c.songs_until_non_song(), Some(2));
    }

    #[test]
    fn songs_until_non_song_null_for_all_song() {
        assert_eq!(FormatClock::from_every_n(0, Vec::new()).songs_until_non_song(), None);
    }

    #[test]
    fn peek_does_not_advance() {
        let mut c = FormatClock::from_every_n(2, Vec::new());
        assert_eq!(c.peek().slot, SlotKind::Song);
        assert_eq!(c.peek().slot, SlotKind::Song);
        assert_eq!(c.next_slot().slot, SlotKind::Song);
    }

    #[test]
    fn quiet_hours_in_day_and_wrap() {
        assert!(is_within_quiet_hours(3 * 60, &[(2 * 60, 8 * 60)]));
        assert!(!is_within_quiet_hours(8 * 60, &[(2 * 60, 8 * 60)]));
        assert!(is_within_quiet_hours(23 * 60, &[(22 * 60, 6 * 60)]));
        assert!(is_within_quiet_hours(2 * 60, &[(22 * 60, 6 * 60)]));
        assert!(!is_within_quiet_hours(12 * 60, &[(22 * 60, 6 * 60)]));
        assert!(!is_within_quiet_hours(3 * 60, &[(3 * 60, 3 * 60)]));
    }

    #[test]
    fn parse_hhmm_rejects_bad() {
        assert_eq!(parse_hhmm("02:00"), Some(120));
        assert!(parse_hhmm("nope").is_none());
        assert!(parse_hhmm("25:00").is_none());
    }
}
