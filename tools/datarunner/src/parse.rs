//! Turn OCR text into snapshot price rows. Conservative; review is required.
//!
//! Two layouts:
//! - Spreadsheet lines: `Agricium  4000  12000`
//! - 4.x kiosk cards: `AGRICIUM` / `86 SCU` / `8,379/SCU`
//!
//! UEX: `price_sell` = shop charges you (BUY tab). `price_buy` = shop pays you
//! (Local Market / sellable cargo).

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

static PER_SCU: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?P<price>[\d][\d,]{2,})(?:\.\d+)?\s*/\s*(?:s|5)?cu\b").expect("per-scu")
});

static QTY_SCU: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?P<qty>[\d][\d,]*)\s*(?:s|5)?cu\b").expect("qty-scu"));

static BUTTONS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:[\s\[\]\(\)|\\/_.,~=+-]*(?:1|2|4|8|16|24|32)[\s\[\]\(\)|\\/_.,~=+-]*)+$")
        .expect("buttons")
});

static SIZE_N: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(?:s|c)ize\s*(?P<n>[1-7])\b").expect("size"));

static LETTERS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z]{3,}").expect("letters"));

/// Trade + mine names seen on 4.x commodity kiosks (plus seed ores).
const COMMODITIES: &[&str] = &[
    "Agricium",
    "Agricultural Supplies",
    "Aluminum",
    "Ammonia",
    "Aphorite",
    "Argon",
    "Astatine",
    "Audio-Visual Equipment",
    "Beryl",
    "Bexalite",
    "Bioplastic",
    "Borase",
    "Carbon",
    "Carbon-Silk",
    "Chlorine",
    "Cobalt",
    "Compboard",
    "Copper",
    "Corundum",
    "Degnous Root",
    "Diamond",
    "Diamond Laminate",
    "Distilled Spirits",
    "Dolivine",
    "Dymantium",
    "Dynaflex",
    "Feynmaline",
    "Fluorine",
    "Fresh Food",
    "Gold",
    "Golden Medmon",
    "Hadanite",
    "Heart of the Woods",
    "Helium",
    "Hephaestanite",
    "Hydrogen",
    "Iodine",
    "Iron",
    "Janalite",
    "Kopion Horn",
    "Laranite",
    "Marok Gem",
    "Medical Supplies",
    "Mercury",
    "Methane",
    "Nitrogen",
    "Omnapoxy",
    "Party Favors",
    "Potassium",
    "Pressurized Ice",
    "Processed Food",
    "Quantainium",
    "Quartz",
    "Revenant Tree Pollen",
    "Ship Ammunition - Size 1",
    "Ship Ammunition - Size 2",
    "Ship Ammunition - Size 3",
    "Ship Ammunition - Size 4",
    "Ship Ammunition - Size 5",
    "Ship Ammunition - Size 6",
    "Ship Ammunition - Size 7",
    "Silicon",
    "Stileron",
    "Taranite",
    "Tin",
    "Titanium",
    "Torite",
    "Tungsten",
    "Waste",
];

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

fn looks_like_kiosk_cards(text: &str) -> bool {
    let u = text.to_ascii_uppercase();
    u.contains("/SCU") || u.contains("/5CU") || u.contains("SHOP QUANTITY")
}

/// Shop sells to you (BUY / IN STOCK) vs shop buys from you (local market).
#[derive(Clone, Copy)]
enum KioskSide {
    ShopSells,
    ShopBuys,
}

fn kiosk_side(text: &str) -> KioskSide {
    let u = text.to_ascii_uppercase();
    if u.contains("SHOP QUANTITY") || (u.contains("IN STOCK") && !u.contains("SELLABLE")) {
        KioskSide::ShopSells
    } else {
        KioskSide::ShopBuys
    }
}

fn status_from(line: &str) -> Option<i64> {
    let u = line.to_ascii_uppercase();
    if u.contains("MAX INVENTORY") {
        Some(7)
    } else if u.contains("VERY HIGH") {
        Some(6)
    } else if u.contains("HIGH INVENTORY") {
        Some(5)
    } else if u.contains("MEDIUM") {
        Some(4)
    } else if u.contains("VERY LOW") {
        Some(2)
    } else if u.contains("LOW INVENTORY") || u.contains("LOW INVENTDRY") {
        Some(3)
    } else if u.contains("OUT OF STOCK") || u.contains("OUT OF 5TOCK") || u.contains("DUT OF") {
        Some(1)
    } else {
        None
    }
}

fn skip_chrome(line: &str) -> bool {
    let u = line.to_ascii_uppercase();
    BUTTONS.is_match(line)
        || u.contains("AVAILABLE CARGO")
        || u.contains("PLANET SERVICES")
        || u.contains("CURRENT BALANCE")
        || u.contains("PLEASE SELECT")
        || u.contains("TRANSACTION")
        || u.contains("NSACTION")
        || u.contains("MAKE A")
        || u.contains("SELECT LOCATION")
        || u.contains("YOUR INVENTOR")
        || u.contains("SHOP INVENTORY")
        || u.contains("LOCAL MARKET")
        || u.contains("SELLABLE")
        || u == "IN STOCK"
        || u.contains("IN DEMAND")
        || u.contains("NO DEMAND")
        || u == "CANNOT SELL"
        || u == "BUY"
        || u.contains("SHOP QUANTITY") && LETTERS.find_iter(&u).count() <= 2
}

const NAME_NOISE: &[&str] = &[
    "SHOP QUANTITY",
    "SHOP QUANTI",
    "VERY LOW INVENTORY",
    "VERY HIGH INVENTORY",
    "LOW INVENTORY",
    "LOW INVENTDRY",
    "MEDIUM INVENTORY",
    "HIGH INVENTORY",
    "MAX INVENTORY",
    "OUT OF STOCK",
    "OUT OF 5TOCK",
    "IN STOCK",
];

fn strip_name_noise(line: &str) -> String {
    let mut s = line.to_string();
    loop {
        let u = s.to_ascii_uppercase();
        let hit = NAME_NOISE
            .iter()
            .find_map(|n| u.find(n).map(|i| (i, n.len())));
        match hit {
            Some((i, len)) => s.replace_range(i..i + len, " "),
            None => break,
        }
    }
    s
}

fn correct_name(raw: &str) -> String {
    match raw.to_ascii_lowercase().as_str() {
        "bexaute" | "bexalite" => "Bexalite".into(),
        "janaute" | "janalite" => "Janalite".into(),
        "heuum" | "helium" => "Helium".into(),
        "hydrdgen" | "hydrogen" => "Hydrogen".into(),
        "omnapoxy" | "dmnapdxy" | "dmnapoxy" => "Omnapoxy".into(),
        "compboard" => "Compboard".into(),
        _ => title_commodity(raw),
    }
}

fn title_commodity(s: &str) -> String {
    let small = ["of", "the", "and"];
    s.split_whitespace()
        .enumerate()
        .map(|(i, w)| {
            let l = w.to_ascii_lowercase();
            if i > 0 && small.contains(&l.as_str()) {
                l
            } else {
                let mut c = l.chars();
                match c.next() {
                    None => String::new(),
                    Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                }
            }
        })
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn compact_alpha(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        prev = cur;
    }
    prev[b.len()]
}

fn resolve_name(raw: &str) -> Option<String> {
    let c = compact_alpha(raw);
    if c.len() < 4 {
        return None;
    }
    let mut best: Option<(usize, &'static str)> = None;
    for &name in COMMODITIES {
        let n = compact_alpha(name);
        if n == c {
            return Some(name.to_string());
        }
        let (shorter, longer) = if n.len() <= c.len() {
            (&n, &c)
        } else {
            (&c, &n)
        };
        if shorter.len() >= 6
            && longer.contains(shorter.as_str())
            && longer.len() - shorter.len() <= 3
        {
            let d = longer.len() - shorter.len();
            if best.map(|(bd, _)| d < bd).unwrap_or(true) {
                best = Some((d, name));
            }
            continue;
        }
        let allow = if n.len() <= 5 { 1 } else { 2 };
        if n.len() >= 4 && c.len() >= 4 {
            let d = levenshtein(&c, &n);
            if d <= allow && best.map(|(bd, _)| d < bd).unwrap_or(true) {
                best = Some((d, name));
            }
        }
    }
    best.map(|(_, name)| name.to_string())
}

fn junk_name(name: &str) -> bool {
    let u = name.to_ascii_uppercase();
    u.contains("INVENT")
        || u.contains("QUANTIT")
        || u.contains("OSCU")
        || u.ends_with(" OST")
        || u == "OST"
        || u == "SCU"
        || u == "STOCK"
        || u == "CARGO"
        || u.contains("DEMAND")
        || u.contains("ACTION")
        || u.contains("SELECT")
}

fn extract_name(line: &str) -> Option<String> {
    let mut t = strip_name_noise(line);
    t = QTY_SCU.replace_all(&t, " ").into_owned();
    t = PER_SCU.replace_all(&t, " ").into_owned();
    t = t
        .chars()
        .map(|c| {
            if c.is_ascii_alphabetic() || c == ' ' || c == '-' || c == '/' {
                c
            } else {
                ' '
            }
        })
        .collect::<String>();
    let name = t
        .split_whitespace()
        .filter(|w| w.len() > 1)
        .collect::<Vec<_>>()
        .join(" ");
    if name.len() < 3 || !LETTERS.is_match(&name) || junk_name(&name) {
        return None;
    }
    let u = name.to_ascii_uppercase();
    if matches!(
        u.as_str(),
        "SCU" | "BUY" | "SELL" | "SIZE" | "STOCK" | "CARGO" | "AMMUNITION"
    ) {
        return None;
    }
    Some(correct_name(&name))
}

fn apply_price(
    row: &mut PriceRow,
    price: f64,
    scu: Option<i64>,
    status: Option<i64>,
    side: KioskSide,
) {
    match side {
        KioskSide::ShopSells => {
            row.price_sell = Some(price);
            if row.scu_sell.is_none() {
                row.scu_sell = scu;
            }
            if row.status_sell.is_none() {
                row.status_sell = status;
            }
        }
        KioskSide::ShopBuys => {
            row.price_buy = Some(price);
            if row.scu_buy.is_none() {
                row.scu_buy = scu;
            }
            if row.status_buy.is_none() {
                row.status_buy = status;
            }
        }
    }
}

fn parse_kiosk_cards(text: &str) -> Vec<PriceRow> {
    let side = kiosk_side(text);
    let mut rows = Vec::new();
    let mut name: Option<String> = None;
    let mut scu: Option<i64> = None;
    let mut status: Option<i64> = None;
    let mut ammo = false;

    for raw in text.lines() {
        let line = raw.trim();
        if line.len() < 3 {
            continue;
        }
        let has_status = status_from(line);
        if let Some(st) = has_status {
            status = Some(st);
        }
        let u = line.to_ascii_uppercase();
        if u.contains("MUNITION") {
            ammo = true;
            name = Some("Ship Ammunition".into());
        }
        if let Some(caps) = SIZE_N.captures(line) {
            let n = &caps["n"];
            name = Some(format!("Ship Ammunition - Size {n}"));
            ammo = true;
        }

        if let Some(caps) = PER_SCU.captures(line) {
            if let Some(price) = parse_num(&caps["price"]) {
                if price >= 50.0 {
                    if let Some(raw_name) = name.clone() {
                        if let Some(n) = resolve_name(&raw_name) {
                            let mut row = PriceRow {
                                name: n,
                                ..PriceRow::default()
                            };
                            let qty = scu
                                .filter(|q| !matches!(q, 1 | 2 | 4 | 8 | 16 | 24 | 32) || *q == 0);
                            apply_price(
                                &mut row,
                                price,
                                qty.or(scu.filter(|q| *q >= 0)),
                                status,
                                side,
                            );
                            rows.push(row);
                        }
                    }
                }
            }
            name = None;
            scu = None;
            status = None;
            ammo = false;
            continue;
        }

        if skip_chrome(line) {
            continue;
        }

        let mut saw_qty = false;
        if let Some(caps) = QTY_SCU.captures(line) {
            if !PER_SCU.is_match(line) {
                if let Some(q) = parse_num(&caps["qty"]) {
                    let q = q as i64;
                    if !BUTTONS.is_match(line) {
                        scu = Some(q);
                        saw_qty = true;
                    }
                }
            }
        }

        if !ammo {
            if let Some(n) = extract_name(line) {
                if matches!(n.as_str(), "Ammunition" | "Size") {
                    continue;
                }
                if name.is_some() && (saw_qty || has_status.is_some()) {
                    continue;
                }
                name = Some(n);
            }
        }
    }
    rows
}

fn parse_spreadsheet(text: &str) -> Vec<PriceRow> {
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

pub fn parse_ocr_text(text: &str) -> Vec<PriceRow> {
    if looks_like_kiosk_cards(text) {
        let cards = parse_kiosk_cards(text);
        if !cards.is_empty() {
            return cards;
        }
    }
    parse_spreadsheet(text)
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

    #[test]
    fn parse_kiosk_buy_tab_cards() {
        // Cropped Tesseract of LIVE/screenshots BUY / IN STOCK (Levski).
        let text = r#"
LOCAL MARKET VALUE
IN STOCK
AGRICIUM SHOP QUANTITY
LOW INVENTORY 86 SCU
8,379/5CU
BERYL SHOP QUANTITY
VERY LOW INVENTORY 39SCU
15,390/SCU
IRON SHOP QUANTITY
VERY LOW INVENTORY 118 SCU
2,349/5CU
SHIP SHOP QUANTITY
AMMUNITION -
SIZE 1  6,868/5CU
MAX INVENTORY
SHIP SHOP QUANTITY
AMMUNITION - 12,000 SCU
SIZE 2  7,126/5CU
"#;
        let rows = parse_ocr_text(text);
        let agri = rows.iter().find(|r| r.name == "Agricium").unwrap();
        assert_eq!(agri.price_sell, Some(8379.0));
        assert_eq!(agri.scu_sell, Some(86));
        assert_eq!(agri.status_sell, Some(3));
        assert!(agri.price_buy.is_none());
        let beryl = rows.iter().find(|r| r.name == "Beryl").unwrap();
        assert_eq!(beryl.price_sell, Some(15390.0));
        assert!(rows.iter().any(|r| r.name == "Iron"));
        assert!(
            rows.iter()
                .any(|r| r.name == "Ship Ammunition - Size 1" && r.price_sell == Some(6868.0)),
            "{rows:?}"
        );
    }

    #[test]
    fn parse_kiosk_local_market_cards() {
        let text = r#"
SELLABLE CARGO
IN DEMAND
WASTE 0SCU
OUT OF STOCK  240/5CU
AGRICULTURAL SUPPLIES 0SCU
OUT OF STOCK  1,600/5CU
COMPBOARD 70SCU
VERY HIGH INVENTORY  34,000/5CU
DEGNOUS ROOT 14SCU
VERY LOW INVENTORY  53,000/SCU
"#;
        let rows = parse_ocr_text(text);
        let waste = rows.iter().find(|r| r.name == "Waste").unwrap();
        assert_eq!(waste.price_buy, Some(240.0));
        assert_eq!(waste.status_buy, Some(1));
        let board = rows.iter().find(|r| r.name == "Compboard").unwrap();
        assert_eq!(board.price_buy, Some(34000.0));
        assert_eq!(board.scu_buy, Some(70));
        let root = rows.iter().find(|r| r.name == "Degnous Root").unwrap();
        assert_eq!(root.price_buy, Some(53000.0));
    }

    #[test]
    fn parse_kiosk_ignores_inventory_ocr_junk() {
        let text = r#"
AGRICIUM SHOP QUANTITY
Llldw Inventory 86 SCU
8,379/5CU
BERYL SHOP QUANTITY
k u VERY LOW INVENTORY 39SCU
15,390/SCU
"#;
        let rows = parse_ocr_text(text);
        assert_eq!(
            rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            ["Agricium", "Beryl"]
        );
        assert_eq!(rows[0].price_sell, Some(8379.0));
        assert_eq!(rows[0].scu_sell, Some(86));
    }

    #[test]
    fn parse_kiosk_ship_ammo_sizes() {
        let text = r#"
SHOP QUANTITY
AMMUNITION -
SIZE 1  6,868/5CU
AMMUNITION -
SIZE 2  7,126/SCU
CIZE 3  7,384/5CU
"#;
        let rows = parse_ocr_text(text);
        let names: Vec<_> = rows
            .iter()
            .map(|r| (r.name.as_str(), r.price_sell))
            .collect();
        assert_eq!(
            names,
            [
                ("Ship Ammunition - Size 1", Some(6868.0)),
                ("Ship Ammunition - Size 2", Some(7126.0)),
                ("Ship Ammunition - Size 3", Some(7384.0)),
            ]
        );
    }
}
