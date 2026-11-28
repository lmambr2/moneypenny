// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Loopback pair-code mint and LAN redeem. The dashboard sees the dashed code
//! once. The phone sees the raw `mpd_` token once. Neither is logged.

use std::net::SocketAddr;
use std::sync::atomic::Ordering;

use axum::Json;
use axum::body::Body;
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use crate::AppState;
use crate::authz::AdminUser;
use crate::handset_auth::HandsetUser;

pub(crate) async fn issue(State(st): State<AppState>, _admin: AdminUser) -> Response {
    let Some(addr) = advertised(&st) else {
        return coded(
            StatusCode::CONFLICT,
            "handset listener disabled",
            "HANDSET_DISABLED",
        );
    };
    let active = match active_devices(&st) {
        Ok(n) => n,
        Err(res) => return res,
    };
    if active >= mp_db::MAX_HANDSET_DEVICES {
        return coded(StatusCode::CONFLICT, "too many devices", "DEVICE_CAP");
    }
    let (code, expires_at) = match st.db.handsets().mint_pair_code() {
        Ok(pair) => pair,
        Err(e) => {
            tracing::warn!(error = %e, "handset pair code mint failed");
            return unavailable();
        }
    };
    let code = dashed(&code);
    let qr_payload = format!(
        "moneypenny://pair?v=1&host={}&port={}&code={code}",
        addr.ip(),
        addr.port()
    );
    (
        StatusCode::CREATED,
        Json(json!({
            "code": code,
            "expiresAt": expires_at,
            "qrPayload": qr_payload,
            "advertise": addr.to_string(),
        })),
    )
        .into_response()
}

pub(crate) async fn list_devices(State(st): State<AppState>, _admin: AdminUser) -> Response {
    let rows = match st.db.handsets().list() {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(error = %e, "handset device list failed");
            return unavailable();
        }
    };
    let devices = rows
        .into_iter()
        .map(|d| {
            json!({
                "id": d.id,
                "label": d.label,
                "createdAt": d.created_at,
                "lastSeenAt": d.last_seen_at,
                "revokedAt": d.revoked_at,
            })
        })
        .collect::<Vec<_>>();
    Json(json!({ "devices": devices })).into_response()
}

pub(crate) async fn delete_device(
    State(st): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<String>,
) -> Response {
    let device = match st.db.handsets().get(&id) {
        Ok(Some(device)) => device,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            tracing::warn!(error = %e, "handset device lookup failed");
            return unavailable();
        }
    };
    if device.revoked_at.is_none() {
        if let Err(e) = st.db.handsets().revoke(&device.id) {
            tracing::warn!(error = %e, "handset revoke failed");
            return unavailable();
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

pub(crate) async fn redeem(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request<Body>,
) -> Response {
    if let Err(wait) = st.pair_limit.take(&peer.ip().to_string()) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [(header::RETRY_AFTER, wait.to_string())],
            Json(json!({"error":"too many requests","code":"RATE_LIMITED"})),
        )
            .into_response();
    }
    let Ok(bytes) = axum::body::to_bytes(req.into_body(), 64 * 1024).await else {
        return invalid();
    };
    let Ok(body) = serde_json::from_slice::<PairBody>(&bytes) else {
        return invalid();
    };
    let label = body.label.trim();
    if label.is_empty() || label.chars().count() > 40 {
        return invalid();
    }
    if mp_db::normalize_pair_code(&body.code).is_empty() {
        return invalid();
    }
    match st.db.handsets().consume_pair_code(&body.code, label) {
        Ok(Some((token, device))) => (
            StatusCode::CREATED,
            Json(json!({
                "token": token,
                "deviceId": device.id,
                "label": device.label,
            })),
        )
            .into_response(),
        Ok(None) => (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"invalid code"})),
        )
            .into_response(),
        Err(e) if e.to_string().contains("handset device cap") => {
            coded(StatusCode::CONFLICT, "too many devices", "DEVICE_CAP")
        }
        Err(e) => {
            tracing::warn!(error = %e, "handset pair redeem failed");
            unavailable()
        }
    }
}

pub(crate) async fn revoke_self(State(st): State<AppState>, user: HandsetUser) -> Response {
    if let Err(e) = st.db.handsets().revoke(&user.id) {
        tracing::warn!(error = %e, "handset self-revoke failed");
        return unavailable();
    }
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairBody {
    code: String,
    label: String,
}

fn advertised(st: &AppState) -> Option<SocketAddr> {
    if !st.handset_bound.load(Ordering::SeqCst) {
        return None;
    }
    let admin = st.read_config().bind_addr().parse().ok()?;
    let raw = std::env::var("HANDSET_ADVERTISE").unwrap_or_default();
    crate::parse_handset_advertise(&raw, admin)
}

fn active_devices(st: &AppState) -> Result<i64, Response> {
    match st.db.handsets().list() {
        Ok(rows) => Ok(rows.iter().filter(|d| d.revoked_at.is_none()).count() as i64),
        Err(e) => {
            tracing::warn!(error = %e, "handset device list failed");
            Err(unavailable())
        }
    }
}

fn dashed(code: &str) -> String {
    if code.len() == 8 && code.is_ascii() {
        format!("{}-{}", &code[..4], &code[4..])
    } else {
        code.to_string()
    }
}

fn coded(status: StatusCode, error: &str, code: &str) -> Response {
    (status, Json(json!({"error": error, "code": code}))).into_response()
}

fn invalid() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":"invalid request"})),
    )
        .into_response()
}

fn unavailable() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error":"unavailable"})),
    )
        .into_response()
}
