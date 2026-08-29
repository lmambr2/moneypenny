//! Turn OCR text into snapshot price rows. Conservative; review is required.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

static ROW: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?x)^
        (?P<name>[A-Za-z][A-Za-z0-9][A-Za-z0-9\ \-/]{0,40}?)
        (?:\s+(?P<nums>-?[\d,]+(?:\.\d+)?(?:\s+-?[\d,]+(?:\.\d+)?){0,5}))
        (?:\s*(?:aUEC|c|SCU|scu))?
        \s*$",
    )
    .expect("row regex")
});

static SKIP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^(buy|sell|price|commodity|commodities|inventory|quantity|scu|kiosk|terminal|local\s+market|available|your\s+inventory)\b",
    )
    .expect("skip regex")
});

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct PriceRow {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_buy: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_sell: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scu_buy: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scu_sell: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_buy: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_sell: Option<i64>,
}

fn parse_num(tok: &str) -> Option<f64> {
    tok.replace(',', "").parse().ok()
}

pub fn parse_ocr_text(text: &str) -> Vec<PriceRow> {
    let mut rows = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.len() < 4 || SKIP.is_match(line) {
            continue;
        }
        let Some(caps) = ROW.captures(line) else {
            continue;
        };
        let name = caps
            .name("name")
            .map(|m| m.as_str())
            .unwrap_or("")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let nums: Vec<f64> = caps
            .name("nums")
            .map(|m| m.as_str())
            .unwrap_or("")
            .split_whitespace()
            .filter_map(parse_num)
            .collect();
        if name.is_empty() || nums.is_empty() {
            continue;
        }
        let mut row = PriceRow {
            name,
            ..PriceRow::default()
        };
        if nums.len() >= 2 {
            let a = nums[0];
            let b = nums[1];
            if a <= b {
                row.price_buy = Some(a);
                row.price_sell = Some(b);
            } else {
                row.price_sell = Some(a);
                row.price_buy = Some(b);
            }
        } else {
            row.price_sell = Some(nums[0]);
        }
        let rest = &nums[2.min(nums.len())..];
        let scu: Vec<i64> = rest
            .iter()
            .filter(|n| **n > 7.0)
            .map(|n| *n as i64)
            .collect();
        let status: Vec<i64> = rest
            .iter()
            .filter(|n| (1.0..=7.0).contains(*n) && n.fract() == 0.0)
            .map(|n| *n as i64)
            .collect();
        if scu.len() >= 2 {
            row.scu_buy = Some(scu[0]);
            row.scu_sell = Some(scu[1]);
        } else if scu.len() == 1 {
            row.scu_sell = Some(scu[0]);
        }
        if status.len() >= 2 {
            row.status_buy = Some(status[0]);
            row.status_sell = Some(status[1]);
        } else if status.len() == 1 {
            row.status_sell = Some(status[0]);
        }
        rows.push(row);
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_two_column_prices() {
        let text = r#"
Local Market
Commodity          Buy     Sell
Agricium           4000    12000    80    40
Quantainium        11000   22000    10    8
"#;
        let rows = parse_ocr_text(text);
        let agri = rows.iter().find(|r| r.name == "Agricium").unwrap();
        assert_eq!(agri.price_buy, Some(4000.0));
        assert_eq!(agri.price_sell, Some(12000.0));
        assert!(rows.iter().any(|r| r.name == "Quantainium"));
    }

    #[test]
    fn parse_comma_thousands_and_auec_suffix() {
        let text = "Bexalite   20,000   28,000 aUEC\n";
        let rows = parse_ocr_text(text);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "Bexalite");
        assert_eq!(rows[0].price_buy, Some(20000.0));
        assert_eq!(rows[0].price_sell, Some(28000.0));
    }
}
