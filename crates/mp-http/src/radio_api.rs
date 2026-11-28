// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::authz::AdminUser;
use mp_radio::CueResult;

pub async fn radio_status(State(st): State<AppState>, _admin: AdminUser) -> Json<Value> {
    let s = st.radio.status();
    Json(json!({
        "connected": s.connected,
        "enabled": s.enabled,
        "activeProfile": s.active_profile,
        "profiles": s.profiles,
        "everyNSongs": s.every_n_songs,
        "deadAirSeconds": s.dead_air_seconds,
        "songsUntilBumper": s.songs_until_bumper,
        "cuePending": s.cue_pending,
        "skipNextPending": s.skip_next_pending,
    }))
}

#[derive(Deserialize)]
pub struct TestBumperBody {
    topic: Option<String>,
}

pub async fn radio_test_bumper(
    State(st): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<TestBumperBody>,
) -> Response {
    if !st.radio.enabled() {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "Radio mode is off — enable it in Settings first",
                "code": "RADIO_OFF"
            })),
        )
            .into_response();
    }
    let topic = body
        .topic
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let result = match st.radio.cue_bumper(topic).await {
        CueResult::Played => "played",
        CueResult::Cued => "cued",
        CueResult::Unavailable => "unavailable",
    };
    Json(json!({ "ok": result != "unavailable", "result": result })).into_response()
}

#[derive(Deserialize, Default)]
pub struct PrewarmBody {
    #[serde(default, rename = "includeDoctrine")]
    include_doctrine: bool,
    #[serde(default, rename = "hoursAhead")]
    hours_ahead: Option<f64>,
    #[serde(default)]
    lines: Vec<String>,
}

pub async fn radio_prewarm(
    State(st): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<PrewarmBody>,
) -> Json<Value> {
    let hours = match body.hours_ahead {
        Some(n) if n.is_finite() => (n.floor() as i64).clamp(1, 24) as u32,
        _ => 12,
    };
    let tally = st
        .radio
        .prewarm_bumpers(body.include_doctrine, hours, body.lines)
        .await;
    Json(json!({
        "ok": true,
        "rendered": tally.rendered,
        "failed": tally.failed,
    }))
}

pub async fn radio_clear_cache(State(st): State<AppState>, _admin: AdminUser) -> Json<Value> {
    let removed = st.radio.clear_bumper_cache();
    Json(json!({ "ok": true, "removed": removed }))
}
