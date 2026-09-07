// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use crate::{Database, Result};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkOrderLine {
    pub material: String,
    pub amount: f64,
    pub unit: String,
}

#[derive(Debug, Clone)]
pub struct WorkOrder {
    pub id: i64,
    pub item_name: String,
    pub qty: i64,
    pub lines: Vec<WorkOrderLine>,
    pub created_by: Option<String>,
    pub created_at: i64,
}

pub struct WorkOrderStore<'a> {
    pub(crate) db: &'a Database,
}

impl WorkOrderStore<'_> {
    pub fn add(
        &self,
        item_name: &str,
        qty: i64,
        lines: &[WorkOrderLine],
        created_by: Option<&str>,
    ) -> Result<i64> {
        let now = now_ms();
        let json = serde_json::to_string(lines).unwrap_or_else(|_| "[]".into());
        self.db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO work_orders (item_name, qty, lines_json, created_by, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![item_name, qty, json, created_by, now],
            )?;
            Ok(conn.last_insert_rowid())
        })
    }

    pub fn list(&self) -> Result<Vec<WorkOrder>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, item_name, qty, lines_json, created_by, created_at
                 FROM work_orders ORDER BY created_at DESC",
            )?;
            let rows = stmt.query_map([], |r| {
                let json: String = r.get(3)?;
                let lines: Vec<WorkOrderLine> = serde_json::from_str(&json).unwrap_or_default();
                Ok(WorkOrder {
                    id: r.get(0)?,
                    item_name: r.get(1)?,
                    qty: r.get(2)?,
                    lines,
                    created_by: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })?;
            Ok(rows.filter_map(|x| x.ok()).collect())
        })
    }

    pub fn count(&self) -> Result<u32> {
        self.db.with_conn(|conn| {
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM work_orders", [], |r| r.get(0))?;
            Ok(n as u32)
        })
    }

    pub fn delete(&self, id: i64) -> Result<bool> {
        self.db.with_conn(|conn| {
            let n = conn.execute("DELETE FROM work_orders WHERE id = ?1", rusqlite::params![id])?;
            Ok(n > 0)
        })
    }

    pub fn clear(&self) -> Result<u32> {
        self.db.with_conn(|conn| {
            let n = conn.execute("DELETE FROM work_orders", [])?;
            Ok(n as u32)
        })
    }
}

pub fn aggregate(orders: &[WorkOrder]) -> Vec<WorkOrderLine> {
    let mut map: std::collections::BTreeMap<String, WorkOrderLine> = std::collections::BTreeMap::new();
    for o in orders {
        for l in &o.lines {
            let key = format!("{}::{}", l.unit, l.material.to_lowercase());
            map.entry(key)
                .and_modify(|e| e.amount = ((e.amount + l.amount) * 1000.0).round() / 1000.0)
                .or_insert_with(|| l.clone());
        }
    }
    map.into_values().collect()
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

    #[test]
    fn add_list_aggregate_delete() {
        let db = Database::open_in_memory().unwrap();
        let s = db.work_orders();
        let lines = vec![WorkOrderLine {
            material: "Quantainium".into(),
            amount: 32.0,
            unit: "SCU".into(),
        }];
        let id = s.add("Quantainium", 1, &lines, Some("u1")).unwrap();
        assert!(id > 0);
        let list = s.list().unwrap();
        assert_eq!(list.len(), 1);
        let agg = aggregate(&list);
        assert_eq!(agg[0].amount, 32.0);
        assert!(s.delete(id).unwrap());
        assert_eq!(s.count().unwrap(), 0);
    }
}
