// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Personal hangars. Same tables as Node `user-ships.ts` / `hangar.ts`.

use crate::{Database, Result};

pub fn uid_owner_key(uid: &str) -> String {
    format!("uid:{uid}")
}

pub fn ship_id_from_name(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
        if out.len() >= 120 {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

/// `Prospector x2, Vulture` / `3x MSR`.
pub fn parse_ship_specs(rest: &str) -> Vec<(String, i64)> {
    let mut out = Vec::new();
    for chunk in rest.split(',') {
        let chunk = chunk.trim();
        if chunk.is_empty() {
            continue;
        }
        let parts: Vec<&str> = chunk.split_whitespace().collect();
        let (name, qty) = if parts.len() >= 2 {
            let last = parts[parts.len() - 1];
            let qty_token = last
                .trim_start_matches(['x', 'X', '×'])
                .parse::<i64>()
                .ok()
                .filter(|n| *n >= 1);
            if last.starts_with(['x', 'X', '×']) || (qty_token.is_some() && last.chars().all(|c| c.is_ascii_digit()))
            {
                let name = parts[..parts.len() - 1].join(" ");
                (name, qty_token.unwrap_or(1))
            } else if let Ok(n) = parts[0].trim_end_matches(['x', 'X', '×']).parse::<i64>() {
                if parts[0].ends_with(['x', 'X', '×']) || parts.get(1).is_some_and(|p| *p == "x" || *p == "×") {
                    let name = if parts.get(1).is_some_and(|p| *p == "x" || *p == "×") {
                        parts[2..].join(" ")
                    } else {
                        parts[1..].join(" ")
                    };
                    (name, n.max(1))
                } else {
                    (chunk.to_string(), 1)
                }
            } else {
                (chunk.to_string(), 1)
            }
        } else {
            (chunk.to_string(), 1)
        };
        if !name.is_empty() {
            out.push((name, qty.max(1)));
        }
    }
    out
}

pub struct HangarStore<'a> {
    db: &'a Database,
}

impl HangarStore<'_> {
    pub fn new(db: &Database) -> HangarStore<'_> {
        HangarStore { db }
    }

    pub fn handle(&self, args: &str, uid: &str, org_ok: bool) -> Result<String> {
        let raw = args.trim();
        if raw.is_empty() || raw.eq_ignore_ascii_case("help") {
            return Ok(HELP.into());
        }
        let parts: Vec<&str> = raw.split_whitespace().collect();
        let head = parts.first().copied().unwrap_or("").to_ascii_lowercase();
        if head == "org" {
            if !org_ok {
                return Ok("○ That needs Colonel or Chairman (ships.org).".into());
            }
            return self.org_summary();
        }
        if head == "import" || head == "export" {
            if !org_ok {
                return Ok("○ That needs Colonel or Chairman (ships.org).".into());
            }
            return Ok(
                "Ship_List.md import/export needs the doctrine directory on disk. Hangar rows are unchanged."
                    .into(),
            );
        }
        if uid.trim().is_empty() {
            return Ok("Couldn't identify you — nothing saved.".into());
        }
        let key = uid_owner_key(uid);
        self.ensure_profile(&key, uid)?;
        match head.as_str() {
            "list" | "ls" | "mine" | "hangar" => self.format(&key, "Your hangar"),
            "clear" => {
                let n = self.clear(&key)?;
                Ok(if n > 0 {
                    format!("Cleared your hangar ({n} hull type(s)).")
                } else {
                    "Your hangar was already empty.".into()
                })
            }
            "add" => self.add(&key, &parts[1..].join(" ")),
            "remove" | "rm" | "del" => self.remove(&key, &parts[1..].join(" ")),
            "have" | "has" => self.have(&key, &parts[1..].join(" ")),
            "link" => {
                let code = parts.get(1).copied().unwrap_or("").trim();
                if code.is_empty() {
                    return Ok("Usage: !ships link <CALLSIGN>".into());
                }
                self.set_callsign(&key, code)?;
                Ok(format!("Linked callsign **{}** to your hangar.", code.to_uppercase()))
            }
            _ if parts.len() == 1 => self.have(&key, parts[0]),
            _ => Ok(HELP.into()),
        }
    }

    fn ensure_profile(&self, owner_key: &str, uid: &str) -> Result<()> {
        let now = now_ms();
        self.db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO hangar_profiles (owner_key, uid, callsign, display_name, updated_at)
                 VALUES (?1, ?2, NULL, NULL, ?3)
                 ON CONFLICT(owner_key) DO NOTHING",
                rusqlite::params![owner_key, uid, now],
            )?;
            Ok(())
        })
    }

    fn set_callsign(&self, owner_key: &str, code: &str) -> Result<()> {
        let now = now_ms();
        self.db.with_conn(|conn| {
            conn.execute(
                "UPDATE hangar_profiles SET callsign=?1, updated_at=?2 WHERE owner_key=?3",
                rusqlite::params![code.to_uppercase(), now, owner_key],
            )?;
            Ok(())
        })
    }

    fn add(&self, owner_key: &str, rest: &str) -> Result<String> {
        let specs = parse_ship_specs(rest);
        if specs.is_empty() {
            return Ok("Usage: !ships add <name> [x2][, name…]".into());
        }
        let mut added = Vec::new();
        for (name, qty) in specs {
            let id = ship_id_from_name(&name);
            let existing = self.qty(owner_key, &id)?;
            let next = existing + qty;
            let now = now_ms();
            self.db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO user_ships (owner_key, ship_id, ship_name, qty, notes, catalog_matched, updated_at)
                     VALUES (?1, ?2, ?3, ?4, NULL, 0, ?5)
                     ON CONFLICT(owner_key, ship_id) DO UPDATE SET
                       ship_name=excluded.ship_name, qty=excluded.qty, updated_at=excluded.updated_at",
                    rusqlite::params![owner_key, id, name, next, now],
                )?;
                Ok(())
            })?;
            added.push(format!("{name} ×{next}"));
        }
        Ok(format!("Updated your hangar: {}.", added.join(", ")))
    }

    fn remove(&self, owner_key: &str, rest: &str) -> Result<String> {
        let specs = parse_ship_specs(rest);
        if specs.is_empty() {
            return Ok("Usage: !ships remove <name> [x2]".into());
        }
        let mut notes = Vec::new();
        for (name, qty) in specs {
            let id = ship_id_from_name(&name);
            let existing = self.qty(owner_key, &id)?;
            if existing == 0 {
                notes.push(format!("no {name}"));
                continue;
            }
            let next = existing - qty;
            if next <= 0 {
                self.db.with_conn(|conn| {
                    conn.execute(
                        "DELETE FROM user_ships WHERE owner_key=?1 AND ship_id=?2",
                        rusqlite::params![owner_key, id],
                    )?;
                    Ok(())
                })?;
                notes.push(format!("removed {name}"));
            } else {
                let now = now_ms();
                self.db.with_conn(|conn| {
                    conn.execute(
                        "UPDATE user_ships SET qty=?1, updated_at=?2 WHERE owner_key=?3 AND ship_id=?4",
                        rusqlite::params![next, now, owner_key, id],
                    )?;
                    Ok(())
                })?;
                notes.push(format!("{name} now ×{next}"));
            }
        }
        Ok(format!(
            "Updated your hangar: {}.",
            if notes.is_empty() { "nothing changed".into() } else { notes.join("; ") }
        ))
    }

    fn have(&self, owner_key: &str, query: &str) -> Result<String> {
        let q = query.trim();
        if q.is_empty() {
            return Ok("Usage: !ships have <name>".into());
        }
        let rows = self.list(owner_key)?;
        if rows.is_empty() {
            return Ok("Hangar empty.".into());
        }
        let needle = q.to_lowercase();
        if let Some((name, qty)) = rows.iter().find(|(n, _)| n.to_lowercase().contains(&needle)) {
            return Ok(format!("Yes — **{name}** ×{qty} (uncatalogued)."));
        }
        Ok(format!("No — nothing matching '{q}' in hangar."))
    }

    fn format(&self, owner_key: &str, title: &str) -> Result<String> {
        let rows = self.list(owner_key)?;
        if rows.is_empty() {
            return Ok(format!("{title}: empty. Use !ships add <name>."));
        }
        let total: i64 = rows.iter().map(|(_, q)| q).sum();
        let lines: Vec<String> = rows.iter().map(|(n, q)| format!("• {n} ×{q}")).collect();
        Ok(format!("{title} — {total} hull(s):\n{}", lines.join("\n")))
    }

    fn org_summary(&self) -> Result<String> {
        let rows = self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT owner_key, ship_name, qty FROM user_ships ORDER BY owner_key, ship_name",
            )?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        if rows.is_empty() {
            return Ok("Org hangars empty. Try !ships import from Ship_List.md.".into());
        }
        let mut members = std::collections::BTreeSet::new();
        let mut total = 0i64;
        let mut by_name: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
        for (owner, name, qty) in &rows {
            members.insert(owner.clone());
            total += qty;
            *by_name.entry(name.clone()).or_default() += qty;
        }
        let mut top: Vec<_> = by_name.into_iter().collect();
        top.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let top_s = top
            .into_iter()
            .take(8)
            .map(|(n, c)| format!("{n} ({c})"))
            .collect::<Vec<_>>()
            .join(", ");
        Ok(format!(
            "Org hangars: **{}** members · **{total}** hulls · **{}** types\nTop: {top_s}\nCommands: !ships org who|of|list · !ships import · !ships export",
            members.len(),
            rows.iter().map(|(_, n, _)| n.as_str()).collect::<std::collections::BTreeSet<_>>().len()
        ))
    }

    fn list(&self, owner_key: &str) -> Result<Vec<(String, i64)>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT ship_name, qty FROM user_ships WHERE owner_key=?1 ORDER BY ship_name COLLATE NOCASE",
            )?;
            let rows = stmt
                .query_map(rusqlite::params![owner_key], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    fn qty(&self, owner_key: &str, ship_id: &str) -> Result<i64> {
        self.db.with_conn(|conn| {
            let n: i64 = conn
                .query_row(
                    "SELECT COALESCE(qty, 0) FROM user_ships WHERE owner_key=?1 AND ship_id=?2",
                    rusqlite::params![owner_key, ship_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            Ok(n)
        })
    }

    fn clear(&self, owner_key: &str) -> Result<i64> {
        self.db.with_conn(|conn| {
            let n = conn.execute(
                "DELETE FROM user_ships WHERE owner_key=?1",
                rusqlite::params![owner_key],
            )?;
            Ok(n as i64)
        })
    }
}

const HELP: &str = "\
!ships / !ships list — your hangar
!ships add <name> [xN][, name…] — add
!ships remove <name> [xN] — remove qty
!ships clear — empty your hangar
!ships have <name> — do you own it?
!ships link <CODE> — set your callsign
Colonel / Chairman (ships.org): !ships org";

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

    #[test]
    fn specs_parse_qty() {
        assert_eq!(
            parse_ship_specs("Prospector x2, Vulture"),
            vec![("Prospector".into(), 2), ("Vulture".into(), 1)]
        );
    }

    #[test]
    fn add_list_have_clear_and_org_gate() {
        let db = Database::open_in_memory().unwrap();
        let h = db.hangar();
        let denied = h.handle("org", "uid-1", false).unwrap();
        assert!(denied.contains("ships.org"), "{denied}");
        let added = h.handle("add Prospector x2", "uid-1", false).unwrap();
        assert!(added.contains("Prospector"), "{added}");
        assert!(added.contains('2'), "{added}");
        let listed = h.handle("list", "uid-1", false).unwrap();
        assert!(listed.contains("Prospector"), "{listed}");
        let yes = h.handle("have Prospector", "uid-1", false).unwrap();
        assert!(yes.starts_with("Yes"), "{yes}");
        let org = h.handle("org", "uid-1", true).unwrap();
        assert!(org.contains("1** members") || org.contains("**1** members"), "{org}");
        let cleared = h.handle("clear", "uid-1", false).unwrap();
        assert!(cleared.contains("Cleared"), "{cleared}");
    }
}
