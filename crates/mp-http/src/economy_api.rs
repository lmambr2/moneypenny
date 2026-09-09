// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Vue `/api/economy/*` — seed catalog + SQLite work orders. No scrapers.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::authz::{AdminUser, AuthUser};
use crate::AppState;
use mp_db::WorkOrderLine;
use mp_economy::{
    calculate_boxes, craft_bom_lines, find_method, find_ore, largest_crate_that_fits, Stability,
    CATALOG_AS_OF, CATALOG_DISCLAIMER, CATALOG_SOURCES, MAX_OPEN_WORK_ORDERS, ORES, REFINE_METHODS,
};

fn sidecar_off(which: &str) -> Response {
    let env = match which {
        "sc-craft" => "ECONOMY_SCCRAFT=0",
        "sc-trade" => "ECONOMY_SCTRADE=0",
        "UEX" => "ECONOMY_UEX=0",
        other => other,
    };
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({
            "error": format!("{which} disabled ({env})")
        })),
    )
        .into_response()
}

fn unstable(s: Stability) -> bool {
    matches!(s, Stability::Volatile | Stability::Critical)
}

fn stability_str(s: Stability) -> &'static str {
    match s {
        Stability::Stable => "stable",
        Stability::Volatile => "volatile",
        Stability::Critical => "critical",
    }
}

fn ore_json(o: &mp_economy::OreSpec) -> Value {
    json!({
        "id": o.id,
        "name": o.name,
        "aliases": o.aliases,
        "rarity": null,
        "valueTier": null,
        "stability": stability_str(o.stability),
        "refineWithinMin": o.refine_within_min,
        "mode": "rock",
        "resistance": null,
        "instability": null,
        "optimalWindow": null,
        "explosive": false,
        "valueScuApprox": null,
        "defaultMethod": o.default_method,
        "locationsHint": null,
        "notes": null,
        "unstable": unstable(o.stability),
    })
}

fn method_json(m: &mp_economy::RefineMethod) -> Value {
    json!({
        "id": m.id,
        "name": m.name,
        "aliases": m.aliases,
        "yieldRate": m.yield_rate,
        "yieldPct": (m.yield_rate * 100.0).round() as i64,
        "timeMult": 1.0,
        "costMult": 1.0,
        "notes": "",
    })
}

fn line_json(l: &WorkOrderLine) -> Value {
    let boxes = calculate_boxes(l.amount);
    let unit = if l.unit.is_empty() { "SCU" } else { l.unit.as_str() };
    json!({
        "material": l.material,
        "amount": l.amount,
        "unit": unit,
        "unstable": find_ore(&l.material).is_some_and(|o| unstable(o.stability)),
        "boxes": boxes.label,
        "totalBoxes": boxes.total_boxes,
        "largestCrate": boxes.largest_crate,
    })
}

fn order_json(o: &mp_db::WorkOrder) -> Value {
    json!({
        "id": o.id,
        "itemName": o.item_name,
        "qty": o.qty,
        "lines": o.lines.iter().map(line_json).collect::<Vec<_>>(),
        "createdBy": o.created_by,
        "createdAt": o.created_at,
    })
}

pub async fn overview(State(st): State<AppState>, _user: AuthUser) -> Json<Value> {
    let open = st.db.work_orders().count().unwrap_or(0);
    Json(json!({
        "catalogAsOf": CATALOG_AS_OF,
        "disclaimer": CATALOG_DISCLAIMER,
        "sources": CATALOG_SOURCES,
        "clients": mp_economy::clients().overview_flags(),
        "cache": {
            "rootLabel": "in-process seed",
            "backend": "none",
            "totalFiles": 0,
            "totalBytes": 0,
            "sources": {}
        },
        "workOrders": { "available": true, "open": open, "maxOpen": MAX_OPEN_WORK_ORDERS },
        "oreCount": ORES.len(),
        "methodCount": REFINE_METHODS.len(),
    }))
}

#[derive(Deserialize)]
pub struct Q {
    #[serde(default)]
    q: String,
    #[serde(default)]
    ore: String,
    #[serde(default)]
    scu: Option<f64>,
    #[serde(default)]
    method: String,
    #[serde(default, rename = "maxBox")]
    max_box: Option<u32>,
    #[serde(default, rename = "box")]
    box_size: Option<u32>,
    #[serde(default)]
    qty: Option<u32>,
}

pub async fn ores(Query(q): Query<Q>, _user: AuthUser) -> Json<Value> {
    let mut list: Vec<Value> = ORES.iter().map(ore_json).collect();
    let query = q.q.trim().to_ascii_lowercase();
    if !query.is_empty() {
        list.retain(|o| {
            o["id"].as_str().unwrap_or("").contains(&query)
                || o["name"]
                    .as_str()
                    .unwrap_or("")
                    .to_ascii_lowercase()
                    .contains(&query)
                || o["aliases"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .any(|x| x.as_str().unwrap_or("").to_ascii_lowercase().contains(&query))
                    })
                    .unwrap_or(false)
        });
        if list.is_empty() {
            if let Some(o) = find_ore(&q.q) {
                list.push(ore_json(o));
            }
        }
    }
    Json(json!({ "ores": list, "asOf": CATALOG_AS_OF }))
}

pub async fn methods(_user: AuthUser) -> Json<Value> {
    Json(json!({
        "methods": REFINE_METHODS.iter().map(method_json).collect::<Vec<_>>(),
    }))
}

pub async fn boxes(Query(q): Query<Q>, _user: AuthUser) -> Response {
    let Some(scu) = q.scu else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"scu required (non-negative number)"})),
        )
            .into_response();
    };
    if !scu.is_finite() || scu < 0.0 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"scu required (non-negative number)"})),
        )
            .into_response();
    }
    let summary = calculate_boxes(scu);
    let max_box = q.max_box.or(q.box_size).unwrap_or(0);
    Json(json!({
        "scu": summary.scu,
        "crates": summary.crates.iter().map(|c| json!({"sizeScu": c.size_scu, "count": c.count})).collect::<Vec<_>>(),
        "totalBoxes": summary.total_boxes,
        "label": summary.label,
        "largestCrate": summary.largest_crate,
        "maxBoxSizeInScu": if max_box > 0 { json!(max_box) } else { json!(null) },
        "largestCrateThatFits": max_box.max(0).checked_sub(0).and_then(|_| if max_box > 0 { largest_crate_that_fits(max_box) } else { None }),
        "fitsShip": if max_box > 0 { json!(summary.largest_crate <= max_box || summary.scu == 0) } else { json!(null) },
    }))
    .into_response()
}

pub async fn mine(Query(q): Query<Q>, _user: AuthUser) -> Response {
    let ore_q = if q.ore.trim().is_empty() {
        q.q.trim()
    } else {
        q.ore.trim()
    };
    if ore_q.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"ore query required (e.g. ?ore=quantainium&scu=32)"})),
        )
            .into_response();
    }
    let Some(ore) = find_ore(ore_q) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": format!("Unknown ore '{ore_q}'")})),
        )
            .into_response();
    };
    let scu = q.scu.filter(|n| n.is_finite() && *n > 0.0).unwrap_or(32.0);
    let method = q
        .method
        .trim()
        .is_empty()
        .then_some(ore.default_method)
        .or(Some(q.method.trim()))
        .and_then(find_method)
        .or_else(|| find_method(ore.default_method));
    let Some(method) = method else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":"ore method catalog is incomplete","code":"INTERNAL_ERROR"})),
        )
            .into_response();
    };
    let clock = match (ore.stability, ore.refine_within_min) {
        (Stability::Critical, Some(m)) => format!("⚠ refine within ~{m} min or it sours"),
        (Stability::Volatile, Some(m)) => format!("⚠ volatile — prefer refine within ~{m} min"),
        _ => String::new(),
    };
    Json(json!({
        "ore": {
            "id": ore.id,
            "name": ore.name,
            "stability": stability_str(ore.stability),
            "refineWithinMin": ore.refine_within_min,
            "mode": "rock",
            "valueScuApprox": null,
            "unstable": unstable(ore.stability),
        },
        "targetScu": scu,
        "stabilityLine": clock,
        "suggestedMethod": {
            "id": method.id,
            "name": method.name,
            "yieldRate": method.yield_rate,
            "yieldPct": (method.yield_rate * 100.0).round() as i64,
        },
    }))
    .into_response()
}

pub async fn refine(Query(q): Query<Q>, _user: AuthUser) -> Response {
    let ore_q = if q.ore.trim().is_empty() {
        q.q.trim()
    } else {
        q.ore.trim()
    };
    if ore_q.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"ore query required (e.g. ?ore=quantainium&scu=32&method=dinyx)"})),
        )
            .into_response();
    }
    let Some(ore) = find_ore(ore_q) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": format!("Unknown ore '{ore_q}'")})),
        )
            .into_response();
    };
    let scu = q.scu.filter(|n| n.is_finite() && *n > 0.0).unwrap_or(32.0);
    let Some(method) = find_method(q.method.trim()).or_else(|| find_method(ore.default_method))
    else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":"ore method catalog is incomplete","code":"INTERNAL_ERROR"})),
        )
            .into_response();
    };
    let out = (scu * method.yield_rate * 10.0).round() / 10.0;
    Json(json!({
        "ore": {
            "id": ore.id,
            "name": ore.name,
            "stability": stability_str(ore.stability),
            "unstable": unstable(ore.stability),
        },
        "method": {
            "id": method.id,
            "name": method.name,
            "yieldRate": method.yield_rate,
            "yieldPct": (method.yield_rate * 100.0).round() as i64,
        },
        "inputScu": scu,
        "outputScu": out,
    }))
    .into_response()
}

pub async fn workorders_get(State(st): State<AppState>, _user: AuthUser) -> Json<Value> {
    let orders = st.db.work_orders().list().unwrap_or_default();
    let materials = mp_db::aggregate(&orders);
    Json(json!({
        "orders": orders.iter().map(order_json).collect::<Vec<_>>(),
        "materials": materials.iter().map(line_json).collect::<Vec<_>>(),
        "open": orders.len(),
        "maxOpen": MAX_OPEN_WORK_ORDERS,
    }))
}

#[derive(Deserialize)]
pub struct WorkOrderBody {
    item: Option<String>,
    q: Option<String>,
    name: Option<String>,
    qty: Option<i64>,
    lines: Option<Vec<WorkOrderLine>>,
}

pub async fn workorders_post(
    State(st): State<AppState>,
    user: AuthUser,
    Json(body): Json<WorkOrderBody>,
) -> Response {
    let open = st.db.work_orders().count().unwrap_or(0);
    if open >= MAX_OPEN_WORK_ORDERS {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "error": format!("Too many open work orders (max {MAX_OPEN_WORK_ORDERS}). Mark some done first."),
                "code": "WORK_ORDER_CAP",
                "maxOpen": MAX_OPEN_WORK_ORDERS,
            })),
        )
            .into_response();
    }
    let item = body
        .item
        .or(body.q)
        .or(body.name)
        .unwrap_or_default()
        .trim()
        .to_string();
    if item.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"item required (in-game blueprint name)"})),
        )
            .into_response();
    }
    let qty = body.qty.unwrap_or(1).clamp(1, 999);
    let lines = if let Some(lines) = body.lines.filter(|l| !l.is_empty()) {
        lines
            .into_iter()
            .map(|mut l| {
                l.amount = ((l.amount * qty as f64) * 1000.0).round() / 1000.0;
                if l.unit.is_empty() {
                    l.unit = "SCU".into();
                }
                l
            })
            .collect()
    } else if let Some(ore) = find_ore(&item) {
        vec![WorkOrderLine {
            material: ore.name.to_string(),
            amount: qty as f64,
            unit: "SCU".into(),
        }]
    } else if let Some(bom) = craft_bom_lines(&item, qty as u32).await {
        bom.into_iter()
            .map(|(material, amount, unit)| WorkOrderLine {
                material,
                amount,
                unit,
            })
            .collect()
    } else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({
                "error": "No seed-ore or sc-craft match for that name"
            })),
        )
            .into_response();
    };
    let created_by = Some(user.username.as_str());
    match st.db.work_orders().add(&item, qty, &lines, created_by) {
        Ok(id) => {
            let order = st
                .db
                .work_orders()
                .list()
                .ok()
                .and_then(|list| list.into_iter().find(|o| o.id == id))
                .unwrap_or(mp_db::WorkOrder {
                    id,
                    item_name: item,
                    qty,
                    lines,
                    created_by: Some(user.username),
                    created_at: 0,
                });
            (
                StatusCode::CREATED,
                Json(json!({ "order": order_json(&order) })),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

pub async fn workorders_delete_one(
    State(st): State<AppState>,
    _user: AuthUser,
    Path(id): Path<i64>,
) -> Response {
    if id < 1 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid id"})),
        )
            .into_response();
    }
    if st.db.work_orders().delete(id).unwrap_or(false) {
        Json(json!({ "ok": true, "removed": id })).into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(json!({"error": format!("No work order #{id}")})),
        )
            .into_response()
    }
}

pub async fn workorders_clear(State(st): State<AppState>, admin: AdminUser) -> Json<Value> {
    let n = st.db.work_orders().clear().unwrap_or(0);
    st.db.audit().record(
        Some(&admin.0.id),
        Some(&admin.0.username),
        None,
        None,
        "economy.workorders_clear",
    );
    Json(json!({ "ok": true, "cleared": n }))
}

pub async fn cache(_user: AuthUser) -> Json<Value> {
    Json(json!({
        "rootLabel": "in-process seed",
        "backend": "none",
        "totalFiles": 0,
        "totalBytes": 0,
        "sources": {},
        "lastRefresh": null,
    }))
}

pub async fn commodities(_user: AuthUser) -> Response {
    let c = mp_economy::clients();
    if !c.uex.is_enabled() {
        return sidecar_off("UEX");
    }
    match c.uex.commodities_list().await {
        Some(v) => Json(v).into_response(),
        None => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error":"UEX commodities unavailable"})),
        )
            .into_response(),
    }
}

pub async fn blueprints(Query(q): Query<Q>, _user: AuthUser) -> Response {
    let query = q.q.trim();
    if query.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"q required (in-game blueprint name)"})),
        )
            .into_response();
    }
    let c = mp_economy::clients();
    if !c.sc_craft.is_enabled() {
        return sidecar_off("sc-craft");
    }
    match c.sc_craft.search(query, 8).await {
        Some(v) => Json(v).into_response(),
        None => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error":"sc-craft unreachable or no results"})),
        )
            .into_response(),
    }
}

pub async fn craft(Query(q): Query<Q>, _user: AuthUser) -> Response {
    let query = if q.q.trim().is_empty() {
        q.ore.trim()
    } else {
        q.q.trim()
    };
    if query.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"q required (e.g. ?q=P4-AR&qty=1)"})),
        )
            .into_response();
    }
    let c = mp_economy::clients();
    if !c.sc_craft.is_enabled() {
        return sidecar_off("sc-craft");
    }
    let qty = q.qty.filter(|n| *n >= 1).unwrap_or(1).min(999);
    match c.sc_craft.resolve(query, qty.max(1)).await {
        Some(v) => Json(v).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"No blueprint match for that name"})),
        )
            .into_response(),
    }
}

pub async fn prices(Query(q): Query<Q>, _user: AuthUser) -> Response {
    let query = q.q.trim();
    if query.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"q required (commodity name)"})),
        )
            .into_response();
    }
    let c = mp_economy::clients();
    if !c.uex.is_enabled() {
        return sidecar_off("UEX");
    }
    match c.uex.lookup_price(query).await {
        Some(v) => Json(v).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"No UEX price match for that commodity"})),
        )
            .into_response(),
    }
}

pub async fn trade_ships(Query(q): Query<Q>, _user: AuthUser) -> Response {
    let c = mp_economy::clients();
    if !c.sc_trade.is_enabled() {
        return sidecar_off("sc-trade");
    }
    match c.sc_trade.ships(&q.q).await {
        Some(v) => Json(v).into_response(),
        None => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error":"Could not load ships from sc-trade"})),
        )
            .into_response(),
    }
}

pub async fn trade_routes(_user: AuthUser, Json(body): Json<Value>) -> Response {
    let c = mp_economy::clients();
    if !c.sc_trade.is_enabled() {
        return sidecar_off("sc-trade");
    }
    match c.sc_trade.find_trades(&body).await {
        Ok(v) => Json(v).into_response(),
        Err(msg) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error": msg})),
        )
            .into_response(),
    }
}

pub async fn trade_off(_user: AuthUser) -> Response {
    let c = mp_economy::clients();
    if !c.sc_trade.is_enabled() {
        return sidecar_off("sc-trade");
    }
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({"error":"this sc-trade tool is not ported yet"})),
    )
        .into_response()
}

pub async fn cache_refresh(_admin: AdminUser) -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({"error":"economy cache refresh not ported (seed catalog is live)"})),
    )
        .into_response()
}
