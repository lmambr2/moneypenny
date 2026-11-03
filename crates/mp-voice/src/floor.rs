// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Exclusive voice-send floor (PR-D2).
//! `duplex-speak` is the only floor where the Talker pump may send Opus.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceFloor {
    Music,
    PiperAck,
    Bumper,
    DuplexSpeak,
    Silence,
}

impl VoiceFloor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Music => "music",
            Self::PiperAck => "piper-ack",
            Self::Bumper => "bumper",
            Self::DuplexSpeak => "duplex-speak",
            Self::Silence => "silence",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "music" => Some(Self::Music),
            "piper-ack" => Some(Self::PiperAck),
            "bumper" => Some(Self::Bumper),
            "silence" => Some(Self::Silence),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub struct VoiceFloorController {
    pub floor: VoiceFloor,
}

impl Default for VoiceFloorController {
    fn default() -> Self {
        Self {
            floor: VoiceFloor::Music,
        }
    }
}

impl VoiceFloorController {
    pub fn set(&mut self, next: VoiceFloor) {
        self.floor = next;
    }

    /// Radio / Piper handoff. `music` does not clobber `duplex-speak`.
    pub fn set_named(&mut self, name: &str) -> bool {
        let Some(next) = VoiceFloor::parse(name) else {
            return false;
        };
        if next == VoiceFloor::Music && self.floor == VoiceFloor::DuplexSpeak {
            return false;
        }
        self.floor = next;
        true
    }

    pub fn player_sends(&self) -> bool {
        self.floor != VoiceFloor::DuplexSpeak
    }

    pub fn talker_sends(&self) -> bool {
        self.floor == VoiceFloor::DuplexSpeak
    }

    /// Rising edge steals only music or silence. Falling edge restores music.
    pub fn on_talker_speaking(&mut self, speaking: bool) {
        if speaking {
            if self.floor == VoiceFloor::Music || self.floor == VoiceFloor::Silence {
                self.floor = VoiceFloor::DuplexSpeak;
            }
            return;
        }
        if self.floor == VoiceFloor::DuplexSpeak {
            self.floor = VoiceFloor::Music;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn talker_steals_music_and_not_a_bumper() {
        let mut f = VoiceFloorController::default();
        assert!(f.player_sends());
        f.on_talker_speaking(true);
        assert!(f.talker_sends());
        assert!(!f.player_sends());
        f.set(VoiceFloor::Bumper);
        f.on_talker_speaking(true);
        assert_eq!(f.floor, VoiceFloor::Bumper);
        f.on_talker_speaking(false);
        assert_eq!(f.floor, VoiceFloor::Bumper);
    }

    #[test]
    fn music_handoff_does_not_clobber_duplex_speak() {
        let mut f = VoiceFloorController::default();
        f.set(VoiceFloor::DuplexSpeak);
        assert!(!f.set_named("music"));
        assert!(f.talker_sends());
        assert!(f.set_named("bumper"));
        assert!(f.player_sends());
    }
}
