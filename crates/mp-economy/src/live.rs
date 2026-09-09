// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Chat formatters for live sc-craft / UEX / sc-trade HTTP (fail-soft).

use serde_json::Value;

use crate::clients;
use crate::orders::{handle_econ, parse_economy_args};

pub async fn handle_craft(args: &str, prefix: &str) -> String {
    let f = parse_economy_args(args);
    if f.subject.is_empty() {
        return format!(
            "Usage: {prefix}craft <in-game blueprint> [qty:N]\nExample: {prefix}craft P4-AR qty:1\nBrowse: {prefix}econ blueprints greatsword"
        );
    }
    let qty = f.qty.unwrap_or(1.0).max(1.0) as u32;
    let c = clients();
    if !c.sc_craft.is_enabled() {
        return format!(
            "No seed craft recipe for \"{}\".\n(sc-craft disabled — ECONOMY_SCCRAFT=0)",
            f.subject
        );
    }
    match c.sc_craft.resolve(&f.subject, qty).await {
        Some(v) => format_craft_resolve(&v),
        None => format!(
            "No sc-craft blueprint match for \"{}\" (or API unreachable).\nTry {prefix}econ blueprints <name> with an in-game item (e.g. Coda, P4-AR).",
            f.subject
        ),
    }
}

pub async fn handle_econ_live(args: &str, prefix: &str) -> String {
    let f = parse_economy_args(args);
    let sub = f.subject.to_ascii_lowercase();
    let rest = sub.split_once(' ').map(|(_, r)| r).unwrap_or("");
    let cmd = sub.split_whitespace().next().unwrap_or("help");
    match cmd {
        "blueprints" | "blueprint" => {
            if rest.is_empty() {
                return format!("Usage: {prefix}econ blueprints <name>");
            }
            let c = clients();
            if !c.sc_craft.is_enabled() {
                return "sc-craft disabled (ECONOMY_SCCRAFT=0).".into();
            }
            match c.sc_craft.search(rest, 8).await {
                Some(v) => format_blueprint_search(&v, rest, prefix),
                None => format!("No sc-craft blueprints matching \"{rest}\" (or API unreachable)."),
            }
        }
        "prices" | "price" => {
            if rest.is_empty() {
                return format!("Usage: {prefix}econ prices <commodity>");
            }
            let c = clients();
            if !c.uex.is_enabled() {
                return "UEX disabled (ECONOMY_UEX=0).".into();
            }
            match c.uex.lookup_price(rest).await {
                Some(v) => format_price(&v),
                None => format!("No UEX price match for \"{rest}\"."),
            }
        }
        "recipes" | "craft" => {
            format!("No offline craft seed. Live blueprints: {prefix}econ blueprints <name> · {prefix}craft <name>")
        }
        _ => handle_econ(args, prefix),
    }
}

pub async fn handle_trade(args: &str, prefix: &str) -> String {
    let f = parse_economy_args(args);
    let sub = f.subject.to_ascii_lowercase();
    let rest = sub.split_once(' ').map(|(_, r)| r).unwrap_or("");
    let cmd = sub.split_whitespace().next().unwrap_or("help");
    let c = clients();
    if !c.sc_trade.is_enabled() {
        return "sc-trade disabled (ECONOMY_SCTRADE=0). Seed catalog: !econ ores".into();
    }
    match cmd {
        "ships" | "ship" => {
            match c.sc_trade.ships(rest).await {
                Some(v) => format_ships(&v, prefix),
                None => "Could not load ships from sc-trade.".into(),
            }
        }
        "routes" | "route" => {
            if !c.sc_trade.has_token() {
                return "SC Trade API token required for route tools. Set SC_TRADE_API_TOKEN (Patreon API licence).".into();
            }
            "Usage: dashboard Economy → trade routes (chat route search needs a JSON body). Try !trade ships <name>."
                .into()
        }
        "help" | "" => format!(
            "Trade (sc-trade.tools, fail-soft):\n{prefix}trade ships [name]\n{prefix}trade routes — needs SC_TRADE_API_TOKEN"
        ),
        _ => {
            match c.sc_trade.ships(&f.subject).await {
                Some(v) => format_ships(&v, prefix),
                None => format!(
                    "No sc-trade ship match for \"{}\". Try {prefix}trade ships.",
                    f.subject
                ),
            }
        }
    }
}

pub async fn craft_bom_lines(item: &str, qty: u32) -> Option<Vec<(String, f64, String)>> {
    let c = clients();
    if !c.sc_craft.is_enabled() {
        return None;
    }
    let v = c.sc_craft.resolve(item, qty.max(1)).await?;
    let bom = v.get("bom")?.as_array()?;
    let mut out = Vec::new();
    for row in bom {
        let material = row
            .get("material")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim();
        if material.is_empty() {
            continue;
        }
        let amount = row.get("amount").and_then(|x| x.as_f64()).unwrap_or(0.0);
        let unit = row
            .get("unit")
            .and_then(|x| x.as_str())
            .unwrap_or("SCU")
            .to_string();
        out.push((material.to_string(), amount, unit));
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn format_craft_resolve(v: &Value) -> String {
    let name = v
        .pointer("/blueprint/name")
        .and_then(|x| x.as_str())
        .unwrap_or("blueprint");
    let qty = v.get("qty").and_then(|x| x.as_u64()).unwrap_or(1);
    let mut lines = vec![format!("🔧 {qty}× {name}")];
    if let Some(bom) = v.get("bom").and_then(|x| x.as_array()) {
        for row in bom {
            let mat = row.get("material").and_then(|x| x.as_str()).unwrap_or("?");
            let amt = row.get("amount").and_then(|x| x.as_f64()).unwrap_or(0.0);
            let unit = row.get("unit").and_then(|x| x.as_str()).unwrap_or("SCU");
            lines.push(format!("  • {amt} {unit} {mat}"));
        }
    }
    if let Some(a) = v.get("attribution").and_then(|x| x.as_str()) {
        lines.push(a.to_string());
    }
    lines.join("\n")
}

fn format_blueprint_search(v: &Value, query: &str, prefix: &str) -> String {
    let items = v.get("items").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let total = v.get("total").and_then(|x| x.as_u64()).unwrap_or(items.len() as u64);
    if items.is_empty() {
        return format!("No sc-craft blueprints matching \"{query}\".");
    }
    let mut lines = vec![format!("sc-craft blueprints matching \"{query}\" ({total} total):")];
    for (i, bp) in items.iter().take(8).enumerate() {
        let name = bp.get("name").and_then(|x| x.as_str()).unwrap_or("?");
        let cat = bp
            .get("category")
            .and_then(|x| x.as_str())
            .map(|s| format!(" · {s}"))
            .unwrap_or_default();
        let ings = bp
            .get("ingredients")
            .and_then(|x| x.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        let mats = if ings > 0 {
            format!(" ({ings} mats)")
        } else {
            String::new()
        };
        lines.push(format!("  {}. {name}{cat}{mats}", i + 1));
    }
    lines.push(String::new());
    lines.push(format!(
        "Detail: {prefix}craft <name>  or  {prefix}econ blueprints <more-specific-name>"
    ));
    if let Some(a) = v.get("attribution").and_then(|x| x.as_str()) {
        lines.push(a.to_string());
    }
    lines.join("\n")
}

fn format_price(v: &Value) -> String {
    let name = v
        .pointer("/commodity/name")
        .and_then(|x| x.as_str())
        .unwrap_or("commodity");
    let sell = v.get("sell").and_then(|x| x.as_f64());
    let buy = v.get("buy").and_then(|x| x.as_f64());
    let mut parts = vec![format!("UEX {name}")];
    if let Some(s) = sell {
        parts.push(format!("sell ~{s}"));
    }
    if let Some(b) = buy {
        parts.push(format!("buy ~{b}"));
    }
    if let Some(a) = v.get("attribution").and_then(|x| x.as_str()) {
        parts.push(a.to_string());
    }
    parts.join(" · ")
}

fn format_ships(v: &Value, prefix: &str) -> String {
    let ships = v.get("ships").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let total = v.get("total").and_then(|x| x.as_u64()).unwrap_or(ships.len() as u64);
    if ships.is_empty() {
        return "No ships from sc-trade.".into();
    }
    let mut lines = vec![format!("Ships ({total}, showing {}):", ships.len().min(12))];
    for s in ships.iter().take(12) {
        let name = s.get("name").and_then(|x| x.as_str()).unwrap_or("?");
        let box_scu = s
            .get("maxBoxSizeInScu")
            .and_then(|x| x.as_f64().or_else(|| x.as_u64().map(|n| n as f64)));
        lines.push(match box_scu {
            Some(n) => format!("  · {name} (max box {n} SCU)"),
            None => format!("  · {name}"),
        });
    }
    if let Some(a) = v.get("attribution").and_then(|x| x.as_str()) {
        lines.push(a.to_string());
    }
    lines.push(format!("Exact name: {prefix}trade ships <name>"));
    lines.join("\n")
}
