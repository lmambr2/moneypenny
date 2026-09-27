// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Local terminal snapshots win when they are at least as new as the UEX cache.

#[derive(Debug, Clone, PartialEq)]
pub struct PricePick {
    pub source: &'static str,
    pub sell: f64,
    pub buy: f64,
    pub name: String,
    pub captured_at: i64,
}

pub fn prefer_snapshot(
    local_name: &str,
    local_sell: f64,
    local_buy: f64,
    local_at: i64,
    uex_sell: Option<f64>,
    uex_buy: Option<f64>,
    uex_at: i64,
) -> PricePick {
    let local_newer = uex_sell.is_none() || local_at >= uex_at;
    if local_newer {
        PricePick {
            source: "local",
            sell: local_sell,
            buy: local_buy,
            name: local_name.to_string(),
            captured_at: local_at,
        }
    } else {
        PricePick {
            source: "uex",
            sell: uex_sell.unwrap_or(0.0),
            buy: uex_buy.unwrap_or(0.0),
            name: local_name.to_string(),
            captured_at: uex_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_snapshot_beats_uex() {
        let pick = prefer_snapshot("Agricium", 12000.0, 4000.0, 2_000, Some(9000.0), Some(5000.0), 1_000);
        assert_eq!(pick.source, "local");
        assert_eq!(pick.sell, 12000.0);
    }

    #[test]
    fn older_snapshot_falls_back_to_uex() {
        let pick = prefer_snapshot("Agricium", 12000.0, 4000.0, 1_000, Some(9000.0), Some(5000.0), 2_000);
        assert_eq!(pick.source, "uex");
        assert_eq!(pick.sell, 9000.0);
    }

    #[test]
    fn snapshot_alone_when_uex_missing() {
        let pick = prefer_snapshot("Agricium", 12000.0, 4000.0, 5, None, None, 0);
        assert_eq!(pick.source, "local");
    }
}
