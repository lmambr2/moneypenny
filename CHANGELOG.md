# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - Grok Build Session (2026-06-12)

### Fixed
- Chinese characters no longer appear in TeamSpeak when something is played.
  Root cause: hardcoded Chinese strings in `BotProfileManager` (chat "正在播放" and away "等待播放").
  - `bot/src/bot/profile.ts`: replaced with English equivalents + `// Grok Build:` annotations.
  - Cleaned dead NetEase "fm" command and QQ-specific code remnants across player, instance, commands, config.
  - Pushed to `dev` branch.
  - Updated this changelog and DESIGN.md with full Grok Build notes.

See PR from dev to main for full diff and the local patch.

### Changed
- De-sinicization now complete for all runtime TS-visible strings.

## Previous
- See git history and DESIGN.md for Phase 0-3 work (music, LLM, rights, voice scaffolding, etc.).
