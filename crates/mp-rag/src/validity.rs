// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

/// Inclusive through end of that UTC calendar day.
pub fn is_doctrine_expired(valid_until: Option<&str>, now_ms: i64) -> bool {
    let raw = valid_until.unwrap_or("").trim();
    if raw.len() < 10 {
        return false;
    }
    let Ok(y) = raw[0..4].parse::<i32>() else {
        return false;
    };
    let Ok(m) = raw[5..7].parse::<u32>() else {
        return false;
    };
    let Ok(d) = raw[8..10].parse::<u32>() else {
        return false;
    };
    if m == 0 || m > 12 || d == 0 || d > 31 {
        return false;
    }
    let end = utc_end_of_day_ms(y, m, d);
    now_ms > end
}

fn utc_end_of_day_ms(y: i32, m: u32, d: u32) -> i64 {
    // days since 1970-01-01 then + 23:59:59.999
    let days = days_from_civil(y, m, d);
    days * 86_400_000 + 86_400_000 - 1
}

fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let mut y = y as i64;
    let m = m as i64;
    let d = d as i64;
    y -= if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_not_expired() {
        assert!(!is_doctrine_expired(None, 0));
        assert!(!is_doctrine_expired(Some(""), 0));
    }

    #[test]
    fn past_date_expired() {
        // 2020-01-01 end vs now 2026
        let now = 1_767_000_000_000i64;
        assert!(is_doctrine_expired(Some("2020-01-01"), now));
        assert!(!is_doctrine_expired(Some("2099-12-31"), now));
    }
}
