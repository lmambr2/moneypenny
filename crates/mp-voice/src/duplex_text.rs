// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Talker–Reasoner text split. User commands come from Whisper only.
//! Moshi 0x02 is her inner monologue and is never a command.

/// Agent caption. Always `None` — callers must not route this string.
pub fn user_text_from_agent_monologue(_text: &str) -> Option<String> {
    None
}

/// Whisper final or typed text. Empty after trim is not a turn.
pub fn accept_user_asr(text: &str) -> String {
    text.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monologue_is_never_a_command() {
        assert!(user_text_from_agent_monologue("play ambient").is_none());
        assert_eq!(accept_user_asr("  play ambient  "), "play ambient");
        assert!(accept_user_asr("   ").is_empty());
    }
}
