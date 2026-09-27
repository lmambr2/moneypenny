// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Director, clock, bumpers (rewrite Phase 7). `docs/radio.md`.
//! Disabled radio is byte-identical to play_next(). TTS is never between skip and music.

mod bumpers;
mod clock;
mod director;
mod prerecorded;
mod rotation;
mod runtime;
mod seed;

pub use clock::{is_within_quiet_hours, parse_hhmm, FormatClock};
pub use director::{Boundary, BuiltBumper, CueResult, RadioDirector, RadioStatus};
pub use mp_config::{RadioConfig, RadioProfile};
pub use prerecorded::{default_bumper_dir, PrerecordedPool};
pub use rotation::{order_keys_with_separation, RotationMeta, SeparationPolicy};
pub use runtime::{RadioRuntime, RadioStatusSnapshot};
pub use seed::{program_station, seed_local_tracks};
