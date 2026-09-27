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
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
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

pub async fn cache(State(st): State<AppState>, _user: AuthUser) -> Json<Value> {
    let last = st.db.load_economy_refresh();
    let last_refresh = match last {
        Ok(Some((at, data))) => {
            let parsed: Value = serde_json::from_str(&data).unwrap_or(json!([]));
            let results = parsed.as_array().cloned().unwrap_or_default();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(at);
            let age_min = ((now - at) as f64 / 60_000.0).round() as i64;
            json!({
                "at": at,
                "ageMin": age_min,
                "results": results.into_iter().take(20).collect::<Vec<_>>(),
            })
        }
        _ => Value::Null,
    };
    Json(json!({
        "rootLabel": "in-process seed",
        "backend": "sqlite",
        "totalFiles": 0,
        "totalBytes": 0,
        "sources": {},
        "lastRefresh": last_refresh,
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

pub async fn prices(State(st): State<AppState>, Query(q): Query<Q>, _user: AuthUser) -> Response {
    let query = q.q.trim();
    if query.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"q required (commodity name)"})),
        )
            .into_response();
    }
    let local = st.db.snapshots().lookup_overlay(query).ok().flatten();
    let c = mp_economy::clients();
    if !c.uex.is_enabled() {
        if let Some(local) = local {
            return Json(local_price_body(&local)).into_response();
        }
        return sidecar_off("UEX");
    }
    match c.uex.lookup_price(query).await {
        Some(mut v) => {
            if let Some(local) = local {
                let uex_sell = v.get("sell").and_then(|n| n.as_f64());
                let uex_buy = v.get("buy").and_then(|n| n.as_f64());
                let uex_at = v.get("fetchedAt").and_then(|n| n.as_i64()).unwrap_or(0);
                let pick = mp_economy::prefer_snapshot(
                    &local.name,
                    local.sell.unwrap_or(0.0),
                    local.buy.unwrap_or(0.0),
                    local.captured_at,
                    uex_sell,
                    uex_buy,
                    uex_at,
                );
                if pick.source == "local" {
                    let body = local_price_body(&local);
                    v["source"] = body["source"].clone();
                    v["sell"] = body["sell"].clone();
                    v["buy"] = body["buy"].clone();
                    v["fetchedAt"] = body["fetchedAt"].clone();
                    v["attribution"] = body["attribution"].clone();
                    if v.get("commodity").is_none() {
                        v["commodity"] = body["commodity"].clone();
                    }
                }
            }
            Json(v).into_response()
        }
        None => {
            if let Some(local) = local {
                return Json(local_price_body(&local)).into_response();
            }
            (
                StatusCode::NOT_FOUND,
                Json(json!({"error":"No UEX price match for that commodity"})),
            )
                .into_response()
        }
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

fn local_price_body(local: &mp_db::LocalOverlay) -> Value {
    let commodity = json!({
        "id": local.commodity_id,
        "name": local.name,
        "code": local.code,
    });
    json!({
        "source": "local",
        "sell": local.sell,
        "buy": local.buy,
        "commodity": commodity,
        "matches": [commodity],
        "matchCount": 1,
        "fetchedAt": local.captured_at,
        "attribution": "Local terminal snapshot",
    })
}

pub fn buyers_response(commodity: &str, scu: u32, buyers: Value, attribution: &str) -> Value {
    json!({
        "commodity": commodity,
        "scu": scu,
        "buyers": buyers,
        "attribution": attribution,
    })
}

pub async fn trade_buyers(_user: AuthUser, Json(body): Json<Value>) -> Response {
    let c = mp_economy::clients();
    if !c.sc_trade.is_enabled() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"sc-trade disabled (ECONOMY_SCTRADE=0)"})),
        )
            .into_response();
    }
    let commodity = body
        .get("commodity")
        .or_else(|| body.get("q"))
        .or_else(|| body.get("item"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if commodity.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"commodity required"})),
        )
            .into_response();
    }
    let scu = body.get("scu").and_then(|v| v.as_u64()).unwrap_or(32).clamp(1, 10_000) as u32;
    match c.sc_trade.find_trades(&json!({"commodity": commodity, "scu": scu})).await {
        Ok(v) => {
            let buyers = v.get("routes").cloned().unwrap_or_else(|| json!([]));
            let attribution = v.get("attribution").and_then(|a| a.as_str()).unwrap_or("");
            Json(buyers_response(commodity, scu, buyers, attribution)).into_response()
        }
        Err(msg) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error": msg})),
        )
            .into_response(),
    }
}

pub async fn trade_itinerary(_user: AuthUser, Json(body): Json<Value>) -> Response {
    let c = mp_economy::clients();
    if !c.sc_trade.is_enabled() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"sc-trade disabled (ECONOMY_SCTRADE=0)"})),
        )
            .into_response();
    }
    let from = body.get("from").or_else(|| body.get("origin")).and_then(|v| v.as_str()).unwrap_or("").trim();
    let to = body.get("to").or_else(|| body.get("destination")).and_then(|v| v.as_str()).unwrap_or("").trim();
    if from.is_empty() || to.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"from and to shop paths required (sc-trade names; use > separators)"})),
        )
            .into_response();
    }
    match c.sc_trade.find_trades(&body).await {
        Ok(v) => Json(v).into_response(),
        Err(msg) => (StatusCode::BAD_GATEWAY, Json(json!({"error": msg}))).into_response(),
    }
}

pub async fn trade_circuit(_user: AuthUser, Json(body): Json<Value>) -> Response {
    let c = mp_economy::clients();
    if !c.sc_trade.is_enabled() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"sc-trade disabled (ECONOMY_SCTRADE=0)"})),
        )
            .into_response();
    }
    let trade_id = body
        .get("id")
        .or_else(|| body.get("tradeId"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if trade_id < 1 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"id required (trade route id from routes results)"})),
        )
            .into_response();
    }
    let ship = body
        .get("ship")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("Freelancer");
    let invest = body
        .get("invest")
        .or_else(|| body.get("investment"))
        .and_then(|v| v.as_i64())
        .unwrap_or(100_000)
        .clamp(1_000, 500_000_000);
    let profit_type = if body.get("profit").and_then(|v| v.as_str()) == Some("pure")
        || body.get("profitType").and_then(|v| v.as_str()) == Some("pure")
    {
        "pure"
    } else {
        "time"
    };
    match c.sc_trade.find_trades(&json!({"id": trade_id, "ship": ship})).await {
        Ok(v) => Json(json!({
            "tradeId": trade_id,
            "ship": ship,
            "invest": invest,
            "profitType": profit_type,
            "routes": v.get("routes").cloned().unwrap_or_else(|| json!([])),
            "attribution": v.get("attribution").and_then(|a| a.as_str()).unwrap_or(""),
        }))
        .into_response(),
        Err(msg) => (StatusCode::BAD_GATEWAY, Json(json!({"error": msg}))).into_response(),
    }
}

pub async fn cache_refresh(State(st): State<AppState>, admin: AdminUser) -> Response {
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let results = json!([
        {"source":"seed","key":"catalog","ok":true,"detail":"in-process ore catalog"},
        {"source":"uex","key":"prices","ok": mp_economy::clients().uex.is_enabled(),"detail":"live lookup stays on demand"},
        {"source":"sc-trade","key":"ships","ok": mp_economy::clients().sc_trade.is_enabled(),"detail":"live lookup stays on demand"},
    ]);
    let payload = results.to_string();
    let saved = st.db.save_economy_refresh(at, &payload);
    if let Err(e) = saved {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":"refresh failed","detail": e.to_string()})),
        )
            .into_response();
    }
    st.db.audit().record(
        Some(&admin.0.id),
        Some(&admin.0.username),
        None,
        None,
        "economy.cache_refresh",
    );
    Json(json!({"ok": true, "at": at, "results": results})).into_response()
}

pub async fn ingest_snapshot(
    State(st): State<AppState>,
    admin: AdminUser,
    Json(body): Json<Value>,
) -> Response {
    let parsed = match mp_db::parse_snapshot_body(&body) {
        Ok(p) => p,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": e.0})),
            )
                .into_response();
        }
    };
    match st.db.snapshots().add(&parsed, Some(admin.0.username.as_str()), "accepted") {
        Ok(row) => {
            st.db.audit().record(
                Some(&admin.0.id),
                Some(&admin.0.username),
                None,
                Some(&format!("{}#{}", parsed.kind, parsed.id_terminal)),
                "economy.ingest_snapshot",
            );
            (StatusCode::CREATED, Json(json!({"snapshot": row.to_json()}))).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":"ingest failed","detail": e.to_string()})),
        )
            .into_response(),
    }
}

pub async fn list_snapshots(State(st): State<AppState>, Query(q): Query<Q>) -> Response {
    let status = match q.status.as_deref() {
        Some("pending" | "accepted" | "rejected") => q.status.as_deref(),
        Some(_) => None,
        None => None,
    };
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    match st.db.snapshots().list(status, limit) {
        Ok(rows) => {
            let snapshots: Vec<Value> = rows.iter().map(|r| r.to_json()).collect();
            let count = snapshots.len();
            Json(json!({"snapshots": snapshots, "count": count})).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

pub async fn snapshot_accept(
    State(st): State<AppState>,
    admin: AdminUser,
    Path(id): Path<i64>,
) -> Response {
    set_snapshot_status(st, admin, id, "accepted")
}

pub async fn snapshot_reject(
    State(st): State<AppState>,
    admin: AdminUser,
    Path(id): Path<i64>,
) -> Response {
    set_snapshot_status(st, admin, id, "rejected")
}

fn set_snapshot_status(st: AppState, _admin: AdminUser, id: i64, status: &str) -> Response {
    if id < 1 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid id"})),
        )
            .into_response();
    }
    match st.db.snapshots().set_status(id, status) {
        Ok(Some(row)) => Json(json!({"snapshot": row.to_json()})).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": format!("No snapshot #{id}")})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}
