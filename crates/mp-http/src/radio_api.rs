// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::authz::AdminUser;
use crate::AppState;
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
