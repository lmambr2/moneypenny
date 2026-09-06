// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Placeholder — VAD → STT HTTP → router → TTS HTTP (Phase 6)
//! Whisper stays out of process.
//! Real implementation is a later phase. This crate exists so the workspace
//! map matches AGENTS.md ownership and cannot fork a parallel layout.

#[cfg(test)]
mod tests {
    #[test]
    fn crate_compiles() {
        assert_eq!(env!("CARGO_PKG_NAME"), "mp-voice");
    }
}
