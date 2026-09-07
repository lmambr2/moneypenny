// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Optional HTTP clients for sc-craft, UEX, and sc-trade.
//! Public JSON only — fail-soft, never throw into the command path.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const UA: &str = "Moneypenny-OrgEconomy/1.0 (+https://github.com; cache-friendly)";
const SC_CRAFT_ATTR: &str =
    "Blueprints via SC Craft Tools (sc-craft.tools) — cached. Fan data, not CIG.";
const UEX_ATTR: &str = "Prices/commodity flags via UEX Corp API (uexcorp.space) — cached.";
const SC_TRADE_ATTR: &str =
    "Trade data via SC Trade Tools (sc-trade.tools) — community reports, cached. Not CIG.";

fn env_on(keys: &[&str], default_on: bool) -> bool {
    for k in keys {
        if let Ok(v) = std::env::var(k) {
            let t = v.trim().to_ascii_lowercase();
            if t.is_empty() {
                continue;
            }
            return !(t == "0" || t == "false" || t == "off" || t == "no");
        }
    }
    default_on
}

fn env_url(keys: &[&str], fallback: &str) -> String {
    for k in keys {
        if let Ok(v) = std::env::var(k) {
            let t = v.trim().trim_end_matches('/');
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    fallback.to_string()
}

async fn get_json(url: &str, timeout: Duration, extra: &[(&str, &str)]) -> Option<Value> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .user_agent(UA)
        .build()
        .ok()?;
    let mut req = client.get(url).header("Accept", "application/json");
    for (k, v) in extra {
        req = req.header(*k, *v);
    }
    let res = req.send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.json::<Value>().await.ok()
}

async fn post_json(url: &str, body: &Value, timeout: Duration, extra: &[(&str, &str)]) -> Option<Value> {
    let client = reqwest::Client::builder().timeout(timeout).user_agent(UA).build().ok()?;
    let mut req = client
        .post(url)
        .header("Accept", "application/json")
        .json(body);
    for (k, v) in extra {
        req = req.header(*k, *v);
    }
    let res = req.send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.json::<Value>().await.ok()
}

struct Cache<T> {
    at: Instant,
    data: T,
}

pub struct ScCraftClient {
    enabled: bool,
    base: String,
}

impl ScCraftClient {
    pub fn from_env() -> Self {
        Self {
            enabled: env_on(&["ECONOMY_SCCRAFT", "SCCRAFT_ENABLED"], true),
            base: env_url(&["SCCRAFT_API_BASE"], "https://sc-craft.tools"),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub async fn search(&self, query: &str, limit: u32) -> Option<Value> {
        if !self.enabled {
            return None;
        }
        let q = query.trim();
        if q.is_empty() {
            return None;
        }
        let lim = limit.clamp(1, 24);
        let url = format!(
            "{}/api/blueprints?search={}&limit={lim}&page=1",
            self.base,
            urlencoding(q)
        );
        let data = get_json(&url, Duration::from_secs(8), &[]).await?;
        let items = data.get("items").cloned().unwrap_or_else(|| json!([]));
        let total = data
            .pointer("/pagination/total")
            .and_then(|v| v.as_u64())
            .unwrap_or_else(|| items.as_array().map(|a| a.len() as u64).unwrap_or(0));
        Some(json!({
            "items": rank_blueprints(q, items),
            "total": total,
            "attribution": SC_CRAFT_ATTR,
        }))
    }

    pub async fn resolve(&self, query: &str, qty: u32) -> Option<Value> {
        let found = self.search(query, 12).await?;
        let items = found.get("items")?.as_array()?;
        let best = items.first()?.clone();
        let mut bp = best.clone();
        if bp.get("ingredients").and_then(|i| i.as_array()).map(|a| a.is_empty()).unwrap_or(true) {
            if let Some(id) = bp.get("id").and_then(|v| v.as_u64()).or_else(|| {
                bp.get("id").and_then(|v| v.as_i64()).map(|n| n as u64)
            }) {
                let url = format!("{}/api/blueprints/{id}", self.base);
                if let Some(full) = get_json(&url, Duration::from_secs(8), &[]).await {
                    if full.get("name").is_some() {
                        bp = full;
                    }
                }
            }
        }
        let n = qty.max(1);
        let bom = blueprint_bom(&bp, n);
        Some(json!({
            "blueprint": {
                "id": bp.get("id"),
                "blueprintId": bp.get("blueprint_id"),
                "name": bp.get("name"),
                "category": bp.get("category"),
                "craftTimeSeconds": bp.get("craft_time_seconds"),
            },
            "qty": n,
            "bom": bom,
            "attribution": SC_CRAFT_ATTR,
        }))
    }
}

fn urlencoding(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn norm(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn score_blueprint_match(query: &str, name: &str, id: &str, category: &str) -> i32 {
    let q = norm(query);
    if q.is_empty() {
        return 0;
    }
    let name = norm(name);
    let id = norm(id);
    let cat = norm(category);
    if name == q || id == q {
        return 100;
    }
    if name.starts_with(&q) || id.starts_with(&q) {
        return 80;
    }
    if name.contains(&q) || id.contains(&q) {
        return 60;
    }
    let tokens: Vec<&str> = q.split(' ').collect();
    if tokens.len() > 1 && tokens.iter().all(|t| name.contains(t) || id.contains(t)) {
        return 50;
    }
    if cat.contains(&q) {
        return 20;
    }
    0
}

fn rank_blueprints(query: &str, items: Value) -> Value {
    let mut rows: Vec<Value> = items.as_array().cloned().unwrap_or_default();
    rows.sort_by(|a, b| {
        let sa = score_blueprint_match(
            query,
            a.get("name").and_then(|v| v.as_str()).unwrap_or(""),
            a.get("blueprint_id").and_then(|v| v.as_str()).unwrap_or(""),
            a.get("category").and_then(|v| v.as_str()).unwrap_or(""),
        );
        let sb = score_blueprint_match(
            query,
            b.get("name").and_then(|v| v.as_str()).unwrap_or(""),
            b.get("blueprint_id").and_then(|v| v.as_str()).unwrap_or(""),
            b.get("category").and_then(|v| v.as_str()).unwrap_or(""),
        );
        sb.cmp(&sa)
    });
    json!(rows)
}

fn blueprint_bom(bp: &Value, qty: u32) -> Vec<Value> {
    let n = qty.max(1) as f64;
    let mut out = Vec::new();
    let Some(ings) = bp.get("ingredients").and_then(|v| v.as_array()) else {
        return out;
    };
    for ing in ings {
        let opt = ing.get("options").and_then(|v| v.as_array()).and_then(|a| a.first());
        let name = ing
            .get("name")
            .and_then(|v| v.as_str())
            .or_else(|| opt.and_then(|o| o.get("name").and_then(|v| v.as_str())))
            .or_else(|| ing.get("slot").and_then(|v| v.as_str()))
            .unwrap_or("unknown")
            .trim();
        let scu = ing
            .get("quantity_scu")
            .and_then(|v| v.as_f64())
            .or_else(|| opt.and_then(|o| o.get("quantity_scu").and_then(|v| v.as_f64())))
            .unwrap_or(0.0);
        if !scu.is_finite() || scu <= 0.0 {
            continue;
        }
        let amount = (scu * n * 1000.0).round() / 1000.0;
        let material_id = name
            .to_ascii_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>()
            .trim_matches('-')
            .to_string();
        out.push(json!({
            "material": name,
            "materialId": if material_id.is_empty() { "material" } else { &material_id },
            "amount": amount,
            "unit": "SCU",
            "unstable": false,
        }));
    }
    out
}

pub struct UexClient {
    enabled: bool,
    base: String,
    cache: Mutex<Option<Cache<Vec<Value>>>>,
}

impl UexClient {
    pub fn from_env() -> Self {
        Self {
            enabled: env_on(&["ECONOMY_UEX", "UEX_ENABLED"], true),
            base: env_url(&["UEX_API_BASE"], "https://api.uexcorp.uk"),
            cache: Mutex::new(None),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    async fn commodities_raw(&self) -> Option<Vec<Value>> {
        if !self.enabled {
            return None;
        }
        {
            let g = self.cache.lock().expect("uex");
            if let Some(c) = g.as_ref() {
                if c.at.elapsed() < Duration::from_secs(3600) {
                    return Some(c.data.clone());
                }
            }
        }
        let url = format!("{}/2.0/commodities", self.base);
        let data = get_json(&url, Duration::from_secs(8), &[]).await?;
        let list = data
            .get("data")
            .and_then(|v| v.as_array())
            .cloned()
            .or_else(|| data.as_array().cloned())
            .unwrap_or_default();
        *self.cache.lock().expect("uex") = Some(Cache {
            at: Instant::now(),
            data: list.clone(),
        });
        Some(list)
    }

    pub async fn commodities_list(&self) -> Option<Value> {
        let list = self.commodities_raw().await?;
        let mut commodities: Vec<Value> = list
            .into_iter()
            .filter_map(|c| {
                let name = c.get("name")?.as_str()?.to_string();
                if name.is_empty() {
                    return None;
                }
                let sell = c.get("price_sell").and_then(|v| v.as_f64()).filter(|n| *n > 0.0);
                let buy = c.get("price_buy").and_then(|v| v.as_f64()).filter(|n| *n > 0.0);
                Some(json!({
                    "id": c.get("id"),
                    "name": name,
                    "code": c.get("code").and_then(|v| v.as_str()).unwrap_or(""),
                    "sell": sell,
                    "buy": buy,
                    "isRaw": c.get("is_raw").and_then(|v| v.as_u64()).unwrap_or(0) != 0,
                }))
            })
            .collect();
        commodities.sort_by(|a, b| {
            a["name"]
                .as_str()
                .unwrap_or("")
                .to_ascii_lowercase()
                .cmp(&b["name"].as_str().unwrap_or("").to_ascii_lowercase())
        });
        let count = commodities.len();
        Some(json!({
            "commodities": commodities,
            "count": count,
            "attribution": UEX_ATTR,
        }))
    }

    pub async fn lookup_price(&self, query: &str) -> Option<Value> {
        let list = self.commodities_raw().await?;
        let q = norm(query);
        if q.is_empty() {
            return None;
        }
        let matches: Vec<&Value> = list
            .iter()
            .filter(|c| {
                let n = norm(c.get("name").and_then(|v| v.as_str()).unwrap_or(""));
                let code = c
                    .get("code")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                n == q || n.contains(&q) || q.contains(&n) || code == q
            })
            .collect();
        let best = *matches.first()?;
        let sell = matches
            .iter()
            .filter_map(|c| c.get("price_sell").and_then(|v| v.as_f64()).filter(|n| *n > 0.0))
            .fold(None, |acc: Option<f64>, n| Some(acc.map(|a| a.max(n)).unwrap_or(n)));
        let buy = matches
            .iter()
            .filter_map(|c| c.get("price_buy").and_then(|v| v.as_f64()).filter(|n| *n > 0.0))
            .fold(None, |acc: Option<f64>, n| Some(acc.map(|a| a.min(n)).unwrap_or(n)));
        Some(json!({
            "commodity": {
                "id": best.get("id"),
                "name": best.get("name"),
                "code": best.get("code"),
            },
            "source": "uex",
            "sell": sell,
            "buy": buy,
            "matchCount": matches.len(),
            "matches": matches.iter().take(8).map(|m| json!({
                "name": m.get("name"),
                "code": m.get("code"),
            })).collect::<Vec<_>>(),
            "attribution": UEX_ATTR,
        }))
    }
}

pub struct ScTradeClient {
    enabled: bool,
    base: String,
    token: String,
}

impl ScTradeClient {
    pub fn from_env() -> Self {
        Self {
            enabled: env_on(&["ECONOMY_SCTRADE", "SCTRADE_ENABLED"], true),
            base: env_url(&["SCTRADE_API_BASE"], "https://sc-trade.tools"),
            token: std::env::var("SC_TRADE_API_TOKEN")
                .or_else(|_| std::env::var("ECONOMY_SCTRADE_TOKEN"))
                .unwrap_or_default()
                .trim()
                .to_string(),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn has_token(&self) -> bool {
        !self.token.is_empty()
    }

    pub async fn ships(&self, q: &str) -> Option<Value> {
        if !self.enabled {
            return None;
        }
        let url = format!("{}/api/ships", self.base);
        let data = get_json(&url, Duration::from_secs(12), &[]).await?;
        wait_ships(data, q)
    }

    pub async fn find_trades(&self, body: &Value) -> Result<Value, String> {
        if !self.enabled {
            return Err("sc-trade disabled (ECONOMY_SCTRADE=0).".into());
        }
        if !self.has_token() {
            return Err(
                "SC Trade API token required for route tools. Set SC_TRADE_API_TOKEN (Patreon API licence)."
                    .into(),
            );
        }
        let url = format!("{}/api/tools/trades", self.base);
        let extra = [("token", self.token.as_str())];
        let data = post_json(&url, body, Duration::from_secs(45), &extra)
            .await
            .ok_or_else(|| "sc-trade unreachable".to_string())?;
        let routes = if data.is_array() {
            data
        } else {
            data.get("routes").cloned().unwrap_or_else(|| json!([]))
        };
        Ok(json!({
            "routes": routes,
            "attribution": SC_TRADE_ATTR,
        }))
    }
}

fn wait_ships(data: Value, q: &str) -> Option<Value> {
    let arr = if data.is_array() {
        data.as_array()?.clone()
    } else {
        data.get("ships")?.as_array()?.clone()
    };
    let q = q.trim().to_ascii_lowercase();
    let mut ships: Vec<Value> = arr
        .into_iter()
        .filter(|s| {
            if q.is_empty() {
                return true;
            }
            s.get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_ascii_lowercase()
                .contains(&q)
        })
        .map(|s| {
            json!({
                "name": s.get("name"),
                "maxBoxSizeInScu": s.get("maxBoxSizeInScu").or_else(|| s.get("max_box_size_in_scu")),
            })
        })
        .collect();
    let total = ships.len();
    ships.truncate(100);
    Some(json!({
        "ships": ships,
        "total": total,
        "attribution": SC_TRADE_ATTR,
    }))
}

pub struct EconomyClients {
    pub sc_craft: ScCraftClient,
    pub uex: UexClient,
    pub sc_trade: ScTradeClient,
}

impl EconomyClients {
    pub fn from_env() -> Self {
        Self {
            sc_craft: ScCraftClient::from_env(),
            uex: UexClient::from_env(),
            sc_trade: ScTradeClient::from_env(),
        }
    }

    pub fn overview_flags(&self) -> Value {
        json!({
            "scCraft": self.sc_craft.is_enabled(),
            "scTrade": self.sc_trade.is_enabled(),
            "scTradeToken": self.sc_trade.has_token(),
            "uex": self.uex.is_enabled(),
        })
    }
}

static CLIENTS: OnceLock<EconomyClients> = OnceLock::new();

pub fn clients() -> &'static EconomyClients {
    CLIENTS.get_or_init(EconomyClients::from_env)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blueprint_score() {
        assert_eq!(score_blueprint_match("p4-ar", "P4-AR", "", "guns"), 100);
        assert!(score_blueprint_match("quant", "Quantanium", "", "") >= 60);
        assert_eq!(score_blueprint_match("", "x", "", ""), 0);
    }
}
