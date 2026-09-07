// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Offline seed. No HTML scrapers. Live UEX/sc-craft remain optional HTTP.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stability {
    Stable,
    Volatile,
    Critical,
}

#[derive(Debug, Clone)]
pub struct OreSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub stability: Stability,
    pub refine_within_min: Option<u32>,
    pub default_method: &'static str,
}

#[derive(Debug, Clone)]
pub struct RefineMethod {
    pub id: &'static str,
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub yield_rate: f64,
}

pub const CATALOG_AS_OF: &str = "2026-07-08 one-shot seed (DataHub + UEX snapshot)";
pub const CATALOG_DISCLAIMER: &str =
    "Shopping-list estimates only. Refine % is by method (same for every ore); station can change it.";
pub const CATALOG_SOURCES: &[&str] = &[
    "SC DataHub mining ores/refining (one-shot seed; not runtime scrape)",
    "UEX Corp public API commodities (live optional)",
    "SC Craft Tools blueprints (live optional)",
];

pub const ORES: &[OreSpec] = &[
    ore("agricium", "Agricium", &["agri"], Stability::Stable, None, "cormack"),
    ore("aluminum", "Aluminum", &["aluminium", "al"], Stability::Stable, None, "cormack"),
    ore("bexalite", "Bexalite", &["bex"], Stability::Stable, None, "cormack"),
    ore("copper", "Copper", &["cu"], Stability::Stable, None, "cormack"),
    ore("gold", "Gold", &["au"], Stability::Stable, None, "cormack"),
    ore("hadanite", "Hadanite", &["hada"], Stability::Stable, None, "ferron"),
    ore("laranite", "Laranite", &["lara"], Stability::Stable, None, "cormack"),
    ore(
        "quantainium",
        "Quantainium",
        &["quantanium", "quanta", "q", "qt"],
        Stability::Critical,
        Some(20),
        "dinyx",
    ),
    ore("stileron", "Stileron", &["stil"], Stability::Volatile, Some(30), "ferron"),
    ore("titanium", "Titanium", &["ti"], Stability::Stable, None, "cormack"),
    ore("tungsten", "Tungsten", &["w"], Stability::Stable, None, "cormack"),
];

pub const REFINE_METHODS: &[RefineMethod] = &[
    RefineMethod { id: "dinyx", name: "Dinyx Solventation", aliases: &["din", "solventation"], yield_rate: 0.45 },
    RefineMethod { id: "thermonatic", name: "Thermonatic Deposition", aliases: &["thermo", "deposition"], yield_rate: 0.4 },
    RefineMethod { id: "ferron", name: "Ferron Exchange", aliases: &["fx", "exchange"], yield_rate: 0.42 },
    RefineMethod { id: "electrostarolysis", name: "Electrostarolysis", aliases: &["electro", "starolysis"], yield_rate: 0.38 },
    RefineMethod { id: "cormack", name: "Cormack Method", aliases: &["corm"], yield_rate: 0.3 },
    RefineMethod { id: "pyrometric", name: "Pyrometric Chromalysis", aliases: &["pyro", "chromalysis"], yield_rate: 0.43 },
];

const fn ore(
    id: &'static str,
    name: &'static str,
    aliases: &'static [&'static str],
    stability: Stability,
    refine_within_min: Option<u32>,
    default_method: &'static str,
) -> OreSpec {
    OreSpec { id, name, aliases, stability, refine_within_min, default_method }
}

fn norm(s: &str) -> String {
    s.trim().to_ascii_lowercase().replace(['_', ' '], "-")
}

pub fn find_ore(query: &str) -> Option<&'static OreSpec> {
    let q = norm(query);
    if q.is_empty() {
        return None;
    }
    ORES.iter().find(|o| {
        o.id == q
            || norm(o.name) == q
            || o.aliases.iter().any(|a| norm(a) == q)
            || o.name.to_ascii_lowercase().starts_with(&q)
            || o.id.starts_with(&q)
    })
}

pub fn find_method(query: &str) -> Option<&'static RefineMethod> {
    let q = norm(query);
    if q.is_empty() {
        return None;
    }
    REFINE_METHODS.iter().find(|m| {
        m.id == q || norm(m.name) == q || m.aliases.iter().any(|a| norm(a) == q) || m.id.starts_with(&q)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_quantanium_alias() {
        let o = find_ore("quantanium").unwrap();
        assert_eq!(o.id, "quantainium");
        assert_eq!(o.stability, Stability::Critical);
    }

    #[test]
    fn finds_dinyx() {
        assert_eq!(find_method("din").unwrap().id, "dinyx");
    }
}
