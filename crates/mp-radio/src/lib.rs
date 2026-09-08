// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Director, clock, bumpers (rewrite Phase 7). `docs/radio.md`.
//! Disabled radio is byte-identical to play_next(). TTS is never between skip and music.

mod bumpers;
mod clock;
mod director;
mod prerecorded;
mod runtime;
mod seed;

pub use clock::{is_within_quiet_hours, parse_hhmm, FormatClock};
pub use director::{Boundary, BuiltBumper, CueResult, RadioDirector, RadioStatus};
pub use mp_config::{RadioConfig, RadioProfile};
pub use prerecorded::{default_bumper_dir, PrerecordedPool};
pub use runtime::{RadioRuntime, RadioStatusSnapshot};
pub use seed::{program_station, seed_local_tracks};

#[cfg(test)]
mod tests {
    #[test]
    fn crate_compiles() {
        assert_eq!(env!("CARGO_PKG_NAME"), "mp-radio");
    }
}
