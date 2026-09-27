// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Terminal snapshot ingest. Same table Node creates in `economy/ingest.ts`.

use serde_json::{json, Value};

use crate::{Database, Result};

#[derive(Debug, Clone)]
pub struct SnapshotRow {
    pub id: i64,
    pub source: String,
    pub game_version: String,
    pub environment: String,
    pub id_terminal: i64,
    pub terminal_name: Option<String>,
    pub kind: String,
    pub prices: Value,
    pub screenshot_sha256: Option<String>,
    pub captured_at: i64,
    pub received_at: i64,
    pub status: String,
    pub created_by: Option<String>,
}

impl SnapshotRow {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "source": self.source,
            "game_version": self.game_version,
            "environment": self.environment,
            "id_terminal": self.id_terminal,
            "terminal_name": self.terminal_name,
            "type": self.kind,
            "prices": self.prices,
            "screenshot_sha256": self.screenshot_sha256,
            "captured_at": self.captured_at,
            "received_at": self.received_at,
            "status": self.status,
            "created_by": self.created_by,
        })
    }
}

#[derive(Debug)]
pub struct SnapshotError(pub String);

const SNAPSHOT_TYPES: &[&str] = &["commodity", "item", "vehicle_buy", "vehicle_rent", "fuel"];

pub fn parse_snapshot_body(body: &Value) -> std::result::Result<ParsedSnapshot, SnapshotError> {
    if !body.is_object() {
        return Err(SnapshotError("JSON object required".into()));
    }
    let id_terminal = body
        .get("id_terminal")
        .and_then(|v| v.as_i64())
        .filter(|n| *n > 0)
        .ok_or_else(|| SnapshotError("id_terminal required (positive int)".into()))?;
    let prices = body
        .get("prices")
        .and_then(|v| v.as_array())
        .cloned()
        .filter(|a| !a.is_empty())
        .ok_or_else(|| SnapshotError("prices[] required (1–200 rows)".into()))?;
    if prices.len() > 200 {
        return Err(SnapshotError("prices[] max 200".into()));
    }
    let kind = body.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if !SNAPSHOT_TYPES.contains(&kind) {
        return Err(SnapshotError(format!(
            "type must be one of {}",
            SNAPSHOT_TYPES.join(", ")
        )));
    }
    let environment = body
        .get("environment")
        .and_then(|v| v.as_str())
        .unwrap_or("LIVE")
        .trim()
        .to_ascii_uppercase();
    if environment != "LIVE" && environment != "PTU" {
        return Err(SnapshotError("environment must be LIVE or PTU".into()));
    }
    let source = body
        .get("source")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("datarunner")
        .to_string();
    let game_version = body
        .get("game_version")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("4.10.0")
        .to_string();
    let terminal_name = body
        .get("terminal_name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let captured_at = normalize_captured_at(body.get("captured_at"));
    Ok(ParsedSnapshot {
        source,
        game_version,
        environment,
        id_terminal,
        terminal_name,
        kind: kind.to_string(),
        prices: Value::Array(prices),
        captured_at,
    })
}

#[derive(Debug)]
pub struct ParsedSnapshot {
    pub source: String,
    pub game_version: String,
    pub environment: String,
    pub id_terminal: i64,
    pub terminal_name: Option<String>,
    pub kind: String,
    pub prices: Value,
    pub captured_at: i64,
}

fn normalize_captured_at(raw: Option<&Value>) -> i64 {
    let n = match raw {
        Some(Value::Number(num)) => num.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    let Some(n) = n else {
        return now_ms();
    };
    if !n.is_finite() || n <= 0.0 {
        return now_ms();
    }
    if n < 1e12 {
        return (n * 1000.0).round() as i64;
    }
    n.round() as i64
}

pub struct SnapshotStore<'a> {
    db: &'a Database,
}

impl SnapshotStore<'_> {
    pub fn new(db: &Database) -> SnapshotStore<'_> {
        SnapshotStore { db }
    }

    pub fn add(&self, parsed: &ParsedSnapshot, created_by: Option<&str>, status: &str) -> Result<SnapshotRow> {
        let now = now_ms();
        let prices = parsed.prices.to_string();
        let id = self.db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO economy_terminal_snapshots (
                    source, game_version, environment, id_terminal, terminal_name, type,
                    prices_json, screenshot_sha256, captured_at, received_at, status, created_by
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,NULL,?8,?9,?10,?11)",
                rusqlite::params![
                    parsed.source,
                    parsed.game_version,
                    parsed.environment,
                    parsed.id_terminal,
                    parsed.terminal_name,
                    parsed.kind,
                    prices,
                    parsed.captured_at,
                    now,
                    status,
                    created_by,
                ],
            )?;
            Ok(conn.last_insert_rowid())
        })?;
        self.get(id)?.ok_or_else(|| crate::DbError::Message("snapshot insert vanished".into()))
    }

    pub fn get(&self, id: i64) -> Result<Option<SnapshotRow>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, source, game_version, environment, id_terminal, terminal_name, type,
                        prices_json, screenshot_sha256, captured_at, received_at, status, created_by
                 FROM economy_terminal_snapshots WHERE id=?1",
            )?;
            let mut rows = stmt.query(rusqlite::params![id])?;
            match rows.next()? {
                Some(r) => Ok(Some(read_row(r)?)),
                None => Ok(None),
            }
        })
    }

    pub fn list(&self, status: Option<&str>, limit: u32) -> Result<Vec<SnapshotRow>> {
        let limit = limit.clamp(1, 200);
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, source, game_version, environment, id_terminal, terminal_name, type,
                        prices_json, screenshot_sha256, captured_at, received_at, status, created_by
                 FROM economy_terminal_snapshots
                 WHERE (?1 IS NULL OR status = ?1)
                 ORDER BY captured_at DESC, id DESC
                 LIMIT ?2",
            )?;
            let rows = stmt
                .query_map(rusqlite::params![status, limit], read_row)?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    pub fn set_status(&self, id: i64, status: &str) -> Result<Option<SnapshotRow>> {
        let n = self.db.with_conn(|conn| {
            let n = conn.execute(
                "UPDATE economy_terminal_snapshots SET status=?1 WHERE id=?2",
                rusqlite::params![status, id],
            )?;
            Ok(n)
        })?;
        if n == 0 {
            return Ok(None);
        }
        self.get(id)
    }

    fn accepted_all(&self) -> Result<Vec<SnapshotRow>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, source, game_version, environment, id_terminal, terminal_name, type,
                        prices_json, screenshot_sha256, captured_at, received_at, status, created_by
                 FROM economy_terminal_snapshots
                 WHERE status = 'accepted'
                 ORDER BY captured_at DESC, id DESC",
            )?;
            let rows = stmt
                .query_map([], read_row)?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// Newest accepted overlay whose commodity name matches, if any.
    pub fn lookup_overlay(&self, query: &str) -> Result<Option<LocalOverlay>> {
        let q = norm(query);
        if q.is_empty() {
            return Ok(None);
        }
        let rows = self.accepted_all()?;
        let mut sell: Option<f64> = None;
        let mut buy: Option<f64> = None;
        let mut captured_at = 0i64;
        let mut name = String::new();
        let mut code = String::new();
        let mut commodity_id: Option<i64> = None;
        let mut terminal_name = String::new();
        let mut matched = false;
        for row in rows {
            let Some(arr) = row.prices.as_array() else { continue };
            for price in arr {
                let row_name = price.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let folded = norm(row_name);
                if folded != q && !folded.contains(&q) {
                    continue;
                }
                matched = true;
                if row.captured_at >= captured_at {
                    captured_at = row.captured_at;
                    name = if row_name.is_empty() { q.clone() } else { row_name.to_string() };
                    terminal_name = row.terminal_name.clone().unwrap_or_default();
                    commodity_id = price.get("id_commodity").and_then(|v| v.as_i64()).filter(|n| *n > 0);
                    code = commodity_id.map(|n| n.to_string()).unwrap_or_default();
                }
                if let Some(s) = positive_price(price.get("sell").or_else(|| price.get("price_sell"))) {
                    sell = Some(sell.map(|a| a.max(s)).unwrap_or(s));
                }
                if let Some(b) = positive_price(price.get("buy").or_else(|| price.get("price_buy"))) {
                    buy = Some(buy.map(|a| a.min(b)).unwrap_or(b));
                }
            }
        }
        if !matched {
            return Ok(None);
        }
        Ok(Some(LocalOverlay {
            name,
            code,
            commodity_id,
            sell,
            buy,
            captured_at,
            terminal_name,
        }))
    }
}

fn positive_price(v: Option<&Value>) -> Option<f64> {
    v.and_then(|n| n.as_f64()).filter(|n| n.is_finite() && *n > 0.0)
}

#[derive(Debug, Clone, PartialEq)]
pub struct LocalOverlay {
    pub name: String,
    pub code: String,
    pub commodity_id: Option<i64>,
    pub sell: Option<f64>,
    pub buy: Option<f64>,
    pub captured_at: i64,
    pub terminal_name: String,
}

fn read_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<SnapshotRow> {
    let prices_raw: String = r.get(7)?;
    let prices = serde_json::from_str(&prices_raw).unwrap_or(Value::Array(vec![]));
    Ok(SnapshotRow {
        id: r.get(0)?,
        source: r.get(1)?,
        game_version: r.get(2)?,
        environment: r.get(3)?,
        id_terminal: r.get(4)?,
        terminal_name: r.get(5)?,
        kind: r.get(6)?,
        prices,
        screenshot_sha256: r.get(8)?,
        captured_at: r.get(9)?,
        received_at: r.get(10)?,
        status: r.get(11)?,
        created_by: r.get(12)?,
    })
}

fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "id_terminal": 18,
            "terminal_name": "Area 18",
            "type": "commodity",
            "captured_at": 1_700_000_000_000_i64,
            "prices": [{ "name": "Agricium", "sell": 12000, "buy": 4000 }]
        })
    }

    #[test]
    fn accept_then_reject_drops_overlay() {
        let db = Database::open_in_memory().unwrap();
        let parsed = parse_snapshot_body(&sample()).unwrap();
        let row = db.snapshots().add(&parsed, Some("lane"), "accepted").unwrap();
        let hit = db.snapshots().lookup_overlay("agricium").unwrap().unwrap();
        assert_eq!(hit.sell, Some(12000.0));
        assert!(hit.terminal_name.contains("Area 18"));
        db.snapshots().set_status(row.id, "rejected").unwrap();
        assert!(db.snapshots().lookup_overlay("agricium").unwrap().is_none());
    }

    #[test]
    fn missing_prices_is_an_error() {
        let err = parse_snapshot_body(&json!({"id_terminal": 1})).unwrap_err();
        assert!(err.0.contains("price"));
    }

    #[test]
    fn captured_at_seconds_scale_and_buy_only_omits_sell() {
        let secs = parse_snapshot_body(&json!({
            "id_terminal": 18,
            "type": "commodity",
            "captured_at": 1_700_000_000_i64,
            "prices": [{ "name": "Laranite", "price_buy": 500 }]
        }))
        .unwrap();
        assert_eq!(secs.captured_at, 1_700_000_000_000);
        let db = Database::open_in_memory().unwrap();
        db.snapshots().add(&secs, Some("datarunner"), "accepted").unwrap();
        let hit = db.snapshots().lookup_overlay("laranite").unwrap().unwrap();
        assert_eq!(hit.buy, Some(500.0));
        assert_eq!(hit.sell, None);
        assert_eq!(hit.captured_at, 1_700_000_000_000);
    }
}
