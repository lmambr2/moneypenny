// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Spoken time checks. Config lines are `IANA` or `IANA|label` (max 8).
//! Clocks are 12-hour, via `date` with `TZ` set, never a shell.

use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimeZoneSpec {
    /// IANA id, or `None` for the host zone.
    pub zone: Option<String>,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedTimeZones {
    pub zones: Vec<TimeZoneSpec>,
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimeBit {
    pub clock: String,
    pub label: String,
}

const MAX_ZONES: usize = 8;

/// Empty config is one unlabeled host clock. Invalid lines are skipped.
pub fn parse_time_check_timezones(configured: &[String]) -> ParsedTimeZones {
    let raw: Vec<&str> = configured
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .take(MAX_ZONES)
        .collect();
    if raw.is_empty() {
        return ParsedTimeZones {
            zones: vec![host_local()],
            skipped: Vec::new(),
        };
    }
    let mut zones = Vec::new();
    let mut skipped = Vec::new();
    for line in raw {
        match parse_line(line) {
            Some(spec) => zones.push(spec),
            None => skipped.push(line.to_string()),
        }
    }
    if zones.is_empty() {
        zones.push(host_local());
    }
    ParsedTimeZones { zones, skipped }
}

fn host_local() -> TimeZoneSpec {
    TimeZoneSpec {
        zone: None,
        label: String::new(),
    }
}

fn parse_line(line: &str) -> Option<TimeZoneSpec> {
    let (zone_raw, label_raw) = match line.split_once('|') {
        Some((zone, label)) => (zone.trim(), label.trim()),
        None => (line.trim(), ""),
    };
    if zone_raw.is_empty() {
        return None;
    }
    let zone = resolve_zone(zone_raw)?;
    let label = if !label_raw.is_empty() {
        label_raw.to_string()
    } else if let Some(z) = zone.as_deref() {
        default_label(z)
    } else {
        String::new()
    };
    Some(TimeZoneSpec { zone, label })
}

/// `None` means host local. `Err`-style `Option` none means the line is invalid.
fn resolve_zone(raw: &str) -> Option<Option<String>> {
    let key = raw.trim().to_ascii_lowercase();
    if key == "local" || key == "host" {
        return Some(None);
    }
    let named = match key.as_str() {
        "america/seattle" | "america/portland" | "us/pacific" | "pacific" | "seattle" => {
            "America/Los_Angeles"
        }
        "us/eastern" | "eastern" => "America/New_York",
        "us/mountain" | "mountain" | "denver" => "America/Denver",
        "us/central" | "central" => "America/Chicago",
        "new york" | "new_york" => "America/New_York",
        "london" => "Europe/London",
        "utc" => "UTC",
        _ => raw.trim(),
    };
    if zoneinfo_ok(named) {
        Some(Some(named.to_string()))
    } else {
        None
    }
}

fn default_label(zone: &str) -> String {
    let tail = zone.rsplit('/').next().unwrap_or(zone);
    tail.replace('_', " ")
}

fn zoneinfo_ok(zone: &str) -> bool {
    if !tz_chars_ok(zone) {
        return false;
    }
    let root = Path::new("/usr/share/zoneinfo");
    let path = root.join(zone);
    path.is_file()
}

pub fn tz_chars_ok(zone: &str) -> bool {
    !zone.is_empty()
        && zone.len() <= 64
        && !zone.starts_with('/')
        && !zone.contains("..")
        && zone
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '+' | '-'))
}

/// `+%-I:%M %p` under `TZ` when `zone` is set. `LC_ALL=C` keeps AM/PM.
pub fn clock_at(zone: Option<&str>, unix: i64) -> Option<String> {
    if let Some(z) = zone {
        if !tz_chars_ok(z) || !zoneinfo_ok(z) {
            return None;
        }
    }
    let mut cmd = Command::new("date");
    cmd.env("LC_ALL", "C");
    if let Some(z) = zone {
        cmd.env("TZ", z);
    }
    cmd.arg("-d").arg(format!("@{unix}")).arg("+%-I:%M %p");
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?;
    let text = text.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

pub fn assemble_time_check(specs: &[TimeZoneSpec], unix: i64) -> String {
    let mut bits = Vec::new();
    for spec in specs {
        let Some(clock) = clock_at(spec.zone.as_deref(), unix) else {
            continue;
        };
        bits.push(TimeBit {
            clock,
            label: spec.label.clone(),
        });
    }
    join_time_check(&bits)
}

/// Node `buildTimeCheckSpeech`: one clock, two with ", and ", longer lists the same way.
pub fn join_time_check(bits: &[TimeBit]) -> String {
    if bits.is_empty() {
        return "The time is now.".into();
    }
    if bits.len() == 1 {
        let z = &bits[0];
        if z.label.is_empty() {
            return format!("The time is {}.", z.clock);
        }
        return format!("The time is {} in {}.", z.clock, z.label);
    }
    let rendered: Vec<String> = bits
        .iter()
        .map(|z| {
            if z.label.is_empty() {
                z.clock.clone()
            } else {
                format!("{} in {}", z.clock, z.label)
            }
        })
        .collect();
    if rendered.len() == 2 {
        return format!("The time is {}, and {}.", rendered[0], rendered[1]);
    }
    let last = rendered.last().expect("at least one");
    let head = rendered[..rendered.len() - 1].join(", ");
    format!("The time is {head}, and {last}.")
}

/// UTC instants on the :00 and :30 grid, `hours` of them (clamped 1–24).
pub fn prewarm_instants(now_unix: i64, hours_ahead: u32) -> Vec<i64> {
    let hours = hours_ahead.clamp(1, 24);
    let step = 1800i64;
    let start = now_unix - now_unix.rem_euclid(step);
    (0..hours * 2).map(|i| start + i as i64 * step).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bit(clock: &str, label: &str) -> TimeBit {
        TimeBit {
            clock: clock.into(),
            label: label.into(),
        }
    }

    #[test]
    fn one_zone_sentence() {
        assert_eq!(
            join_time_check(&[bit("2:05 PM", "")]),
            "The time is 2:05 PM."
        );
        assert_eq!(
            join_time_check(&[bit("2:05 PM", "Denver")]),
            "The time is 2:05 PM in Denver."
        );
    }

    #[test]
    fn two_and_four_zone_sentences() {
        assert_eq!(
            join_time_check(&[bit("9:06 AM", "Denver"), bit("12:06 AM", "Seoul")]),
            "The time is 9:06 AM in Denver, and 12:06 AM in Seoul."
        );
        assert_eq!(
            join_time_check(&[
                bit("2:05 PM", "A"),
                bit("1:05 PM", "B"),
                bit("12:05 PM", "C"),
                bit("4:05 AM", "D"),
            ]),
            "The time is 2:05 PM in A, 1:05 PM in B, 12:05 PM in C, and 4:05 AM in D."
        );
    }

    #[test]
    fn empty_bits_say_now() {
        assert_eq!(join_time_check(&[]), "The time is now.");
    }

    #[test]
    fn utc_epoch_is_twelve_am() {
        assert_eq!(clock_at(Some("UTC"), 0).as_deref(), Some("12:00 AM"));
    }

    #[test]
    fn denver_and_seoul_clocks() {
        assert_eq!(
            clock_at(Some("America/Denver"), 1_750_000_000).as_deref(),
            Some("9:06 AM")
        );
        assert_eq!(
            clock_at(Some("Asia/Seoul"), 1_750_000_000).as_deref(),
            Some("12:06 AM")
        );
    }

    #[test]
    fn parse_aliases_labels_and_skips_junk() {
        let empty = parse_time_check_timezones(&[]);
        assert_eq!(empty.zones, vec![host_local()]);
        assert!(empty.skipped.is_empty());

        let parsed = parse_time_check_timezones(&[
            "America/Seattle|CHAZ".into(),
            "America/Denver".into(),
            "NotAReal/Zone|Nope".into(),
            "local|Here".into(),
        ]);
        assert_eq!(parsed.skipped, vec!["NotAReal/Zone|Nope".to_string()]);
        assert_eq!(parsed.zones.len(), 3);
        assert_eq!(parsed.zones[0].zone.as_deref(), Some("America/Los_Angeles"));
        assert_eq!(parsed.zones[0].label, "CHAZ");
        assert_eq!(parsed.zones[1].zone.as_deref(), Some("America/Denver"));
        assert_eq!(parsed.zones[1].label, "Denver");
        assert_eq!(parsed.zones[2].zone, None);
        assert_eq!(parsed.zones[2].label, "Here");
    }

    #[test]
    fn all_invalid_falls_back_to_host() {
        let parsed = parse_time_check_timezones(&["Nope/Zone".into()]);
        assert_eq!(parsed.zones, vec![host_local()]);
        assert_eq!(parsed.skipped.len(), 1);
    }

    #[test]
    fn prewarm_grid_is_half_hours() {
        let instants = prewarm_instants(10_000, 1);
        assert_eq!(instants, vec![9_000, 10_800]);
        assert_eq!(prewarm_instants(10_000, 0).len(), 2);
        assert_eq!(prewarm_instants(10_000, 100).len(), 48);
    }
}
