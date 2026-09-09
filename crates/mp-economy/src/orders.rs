// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use crate::catalog::{find_method, find_ore, OreSpec, RefineMethod, Stability, CATALOG_DISCLAIMER};

pub struct EconomyFlags {
    pub subject: String,
    pub scu: Option<f64>,
    pub qty: Option<f64>,
    pub method: Option<String>,
}

pub fn parse_economy_args(args: &str) -> EconomyFlags {
    let mut subject = Vec::new();
    let mut scu = None;
    let mut qty = None;
    let mut method = None;
    for p in args.split_whitespace() {
        if let Some((k, v)) = p.split_once(':') {
            match k.to_ascii_lowercase().as_str() {
                "scu" => {
                    if let Ok(n) = v.parse::<f64>() {
                        if n > 0.0 {
                            scu = Some(n);
                        }
                    }
                }
                "qty" => {
                    if let Ok(n) = v.parse::<f64>() {
                        if n > 0.0 {
                            qty = Some(n);
                        }
                    }
                }
                "method" | "m" => method = Some(v.to_string()),
                _ => subject.push(p),
            }
        } else {
            subject.push(p);
        }
    }
    EconomyFlags {
        subject: subject.join(" "),
        scu,
        qty,
        method,
    }
}

pub fn format_mine(ore: &OreSpec, scu: f64, method: &RefineMethod) -> String {
    let flag = if matches!(ore.stability, Stability::Critical | Stability::Volatile) {
        " ⚠️"
    } else {
        ""
    };
    let clock = match (ore.stability, ore.refine_within_min) {
        (Stability::Critical, Some(m)) => format!(" · ⚠ refine within ~{m} min or it sours"),
        (Stability::Volatile, Some(m)) => format!(" · ⚠ volatile — prefer refine within ~{m} min"),
        _ => String::new(),
    };
    format!(
        "⛏ {}{flag} — {scu} SCU raw{clock}\nRefine: !refine {} scu:{scu} method:{}",
        ore.name, ore.id, method.id
    )
}

pub fn format_refine(ore: &OreSpec, method: &RefineMethod, scu: f64) -> String {
    let flag = if matches!(ore.stability, Stability::Critical | Stability::Volatile) {
        " ⚠️"
    } else {
        ""
    };
    let out = (scu * method.yield_rate * 10.0).round() / 10.0;
    let pct = (method.yield_rate * 100.0).round();
    format!(
        "⚗ {}{flag} · {}\n{scu} SCU raw → ~{out} SCU refined (~{pct}%)\nYield is by method for every ore; station can change it.",
        ore.name, method.name
    )
}

pub fn handle_mine(args: &str, prefix: &str) -> String {
    let f = parse_economy_args(args);
    if f.subject.is_empty() {
        return format!(
            "Usage: {prefix}mine <ore> [scu:N] [method:name]\nExample: {prefix}mine quantainium scu:32"
        );
    }
    let Some(ore) = find_ore(&f.subject) else {
        return format!("Unknown ore '{}'. Try {prefix}econ ores", f.subject);
    };
    let method = f
        .method
        .as_deref()
        .and_then(find_method)
        .or_else(|| find_method(ore.default_method))
        .unwrap();
    format_mine(ore, f.scu.unwrap_or(32.0), method)
}

pub fn handle_refine(args: &str, prefix: &str) -> String {
    let f = parse_economy_args(args);
    if f.subject.is_empty() {
        return format!("Usage: {prefix}refine <ore> [scu:N] [method:name]");
    }
    let Some(ore) = find_ore(&f.subject) else {
        return format!("Unknown ore '{}'. Try {prefix}econ ores", f.subject);
    };
    let method = f
        .method
        .as_deref()
        .and_then(find_method)
        .or_else(|| find_method(ore.default_method))
        .unwrap();
    format_refine(ore, method, f.scu.unwrap_or(32.0))
}

pub fn handle_econ(args: &str, prefix: &str) -> String {
    let f = parse_economy_args(args);
    let sub = f.subject.to_ascii_lowercase();
    let rest = sub.split_once(' ').map(|(_, r)| r).unwrap_or("");
    let cmd = sub.split_whitespace().next().unwrap_or("help");
    match cmd {
        "ores" => {
            let names: Vec<_> = crate::catalog::ORES.iter().map(|o| o.name).collect();
            format!("Ores: {}", names.join(", "))
        }
        "methods" => {
            let names: Vec<_> = crate::catalog::REFINE_METHODS
                .iter()
                .map(|m| format!("{} (~{}%)", m.name, (m.yield_rate * 100.0).round()))
                .collect();
            format!("Refine methods:\n{}", names.join("\n"))
        }
        "search" => {
            if rest.is_empty() {
                return format!("Usage: {prefix}econ search <q>");
            }
            match find_ore(rest) {
                Some(o) => format!("{} ({}) — {:?}", o.name, o.id, o.stability),
                None => format!("No ore matching '{rest}'."),
            }
        }
        "help" | "" => format!(
            "Shopping lists (not a guidebook):\n{prefix}mine quantainium scu:32\n{prefix}refine quantainium scu:32 method:dinyx\n{prefix}econ ores · methods · search <q>\n{CATALOG_DISCLAIMER}"
        ),
        "recipes" | "craft" => format!(
            "Live craft BOMs need sc-craft (not ported). Seed catalog: {prefix}mine / {prefix}refine / {prefix}econ ores"
        ),
        "prices" | "blueprints" => {
            format!("Live prices/blueprints are not ported (no UEX/sc-craft HTTP). Try {prefix}econ ores.")
        }
        "cache" | "refresh" => "Economy disk cache is not ported (seed catalog is in-process).".into(),
        _ => format!(
            "Usage: {prefix}econ [ores|methods|search <q>]\nLive craft/prices/trade still need sidecars."
        ),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkOrderSub {
    Help,
    List,
    Clear,
    Done { id: i64 },
    Add { item: String, qty: i64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkOrderArgs {
    pub sub: WorkOrderSub,
}

pub fn parse_workorder_args(args: &str) -> WorkOrderArgs {
    let raw = args.trim();
    if raw.is_empty() {
        return WorkOrderArgs {
            sub: WorkOrderSub::Help,
        };
    }
    let lower = raw.to_ascii_lowercase();
    if lower == "list" || lower == "ls" {
        return WorkOrderArgs {
            sub: WorkOrderSub::List,
        };
    }
    if lower == "clear" || lower == "reset" {
        return WorkOrderArgs {
            sub: WorkOrderSub::Clear,
        };
    }
    if lower == "help" || lower == "?" {
        return WorkOrderArgs {
            sub: WorkOrderSub::Help,
        };
    }
    let mut parts = raw.split_whitespace();
    let first = parts.next().unwrap_or("");
    if first.eq_ignore_ascii_case("done")
        || first.eq_ignore_ascii_case("rm")
        || first.eq_ignore_ascii_case("del")
        || first.eq_ignore_ascii_case("delete")
        || first.eq_ignore_ascii_case("remove")
    {
        if let Some(id) = parts.next().and_then(|s| s.parse::<i64>().ok()) {
            if id > 0 {
                return WorkOrderArgs {
                    sub: WorkOrderSub::Done { id },
                };
            }
        }
    }
    let mut qty = 1i64;
    let mut item = raw.to_string();
    if let Some(idx) = lower.rfind(" qty:") {
        if let Ok(n) = raw[idx + 5..].trim().parse::<i64>() {
            if n > 0 {
                qty = n.clamp(1, 999);
                item = raw[..idx].trim().to_string();
            }
        }
    } else if let Some(idx) = raw.rfind(['x', '×']) {
        let after = raw[idx + after_x_len(&raw[idx..])..].trim();
        if let Ok(n) = after.parse::<i64>() {
            if n > 0 && idx > 0 && raw[..idx].ends_with(char::is_whitespace) {
                qty = n.clamp(1, 999);
                item = raw[..idx].trim().to_string();
            }
        }
    }
    if item.is_empty() {
        return WorkOrderArgs {
            sub: WorkOrderSub::Help,
        };
    }
    WorkOrderArgs {
        sub: WorkOrderSub::Add { item, qty },
    }
}

fn after_x_len(s: &str) -> usize {
    s.chars().next().map(|c| c.len_utf8()).unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mine_quantanium() {
        let s = handle_mine("quantanium scu:16", "!");
        assert!(s.contains("Quantainium"));
        assert!(s.contains("16"));
        assert!(s.contains("dinyx"));
    }

    #[test]
    fn refine_yield() {
        let s = handle_refine("quantainium scu:32 method:dinyx", "!");
        assert!(s.contains("14.4") || s.contains("14"));
    }

    #[test]
    fn workorder_parse() {
        match parse_workorder_args("P4-AR x3").sub {
            WorkOrderSub::Add { item, qty } => {
                assert_eq!(item, "P4-AR");
                assert_eq!(qty, 3);
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            parse_workorder_args("done 2").sub,
            WorkOrderSub::Done { id: 2 }
        ));
        assert!(matches!(parse_workorder_args("list").sub, WorkOrderSub::List));
        match parse_workorder_args("quantainium qty:999999").sub {
            WorkOrderSub::Add { qty, .. } => assert_eq!(qty, 999),
            other => panic!("{other:?}"),
        }
    }
}
