// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Director, clock, bumpers (rewrite Phase 7). `docs/radio.md`.
//! Disabled radio is byte-identical to play_next(). TTS is never between skip and music.

mod bumper_cache;
mod bumpers;
mod clock;
mod director;
mod prerecorded;
mod rotation;
mod runtime;
mod seed;
mod time_check;

pub use bumper_cache::BumperCache;
pub use bumpers::PrewarmTally;
pub use clock::{FormatClock, is_within_quiet_hours, parse_hhmm};
pub use director::{Boundary, BuiltBumper, CueResult, RadioDirector, RadioStatus};
pub use mp_config::{RadioConfig, RadioProfile};
pub use prerecorded::{PrerecordedPool, default_bumper_dir};
pub use rotation::{RotationMeta, SeparationPolicy, order_keys_with_separation};
pub use runtime::{RadioRuntime, RadioStatusSnapshot};
pub use seed::{LocalSeedPlan, program_station, seed_local_tracks, seed_with_plan};
