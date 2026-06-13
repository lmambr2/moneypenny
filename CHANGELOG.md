# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Chinese characters in TeamSpeak playback notifications** (Grok Build session, 2026-06-12)
  - Root cause: leftover hardcoded Chinese strings in `BotProfileManager`:
    - Chat message on track start: `正在播放` ("Now playing")
    - Idle away status: `等待播放` ("Waiting to play")
  - These were sent to the TS client on every `onSongChange` even after the major de-sinicization pass.
  - Fixed by replacing with clean English equivalents.
  - Added `// Grok Build:` inline annotations in `profile.ts` for traceability.
  - Bonus cleanups: removed dead "fm" (NetEase) command handling and QQ-specific optimization remnants from `player.ts`, `instance.ts`, etc.
  - Changes pushed to `dev` branch with Grok Build author and commit message.
  - Updated this changelog and DESIGN.md.

  See the associated commit and patch for the full diff.

### Changed

- De-sinicization is now complete for all runtime TS-visible strings (profile sync, chat messages, away status).

## [0.1.0] - Previous

- Initial major de-sinicization, LocalProvider, LLM wiring, etc. (see DESIGN.md and git history).
