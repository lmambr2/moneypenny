// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! `/api/bot` — list/status/settings/live. Multi-bot CRUD stays a stub.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::authz::{AdminUser, AuthUser};
use crate::json_song::queued_json;
use crate::AppState;
use mp_music::PlayerState;

pub fn bot_status_json(st: &AppState) -> Value {
    let (connected, playing, paused, current, queue_size, volume, play_mode, elapsed) =
        if let Some(station) = st.station.as_ref() {
            let q = station.queue.lock().expect("queue");
            let state = station.player.get_state();
            (
                station.is_connected(),
                state == PlayerState::Playing,
                state == PlayerState::Paused,
                q.current().map(|s| queued_json(&s)),
                q.size(),
                station.player.get_volume(),
                q.get_mode().as_str().to_string(),
                station.player.get_elapsed(),
            )
        } else {
            (false, false, false, None, 0, 30, "rloop".into(), 0.0)
        };
    json!({
        "id": st.bot_id,
        "name": st.bot_name,
        "connected": connected,
        "playing": playing,
        "paused": paused,
        "currentSong": current,
        "queueSize": queue_size,
        "volume": volume,
        "playMode": play_mode,
        "elapsed": elapsed,
    })
}

pub fn queue_json(st: &AppState) -> Vec<Value> {
    st.station
        .as_ref()
        .map(|s| {
            s.queue
                .lock()
                .expect("queue")
                .list()
                .iter()
                .map(queued_json)
                .collect()
        })
        .unwrap_or_default()
}

pub fn broadcast_state(st: &AppState) {
    let _ = st.ws_tx.send(json!({
        "type": "stateChange",
        "botId": st.bot_id,
        "status": bot_status_json(st),
        "queue": queue_json(st),
    }));
}

pub async fn list_bots(State(st): State<AppState>, _user: AuthUser) -> Json<Value> {
    Json(json!({ "bots": [bot_status_json(&st)] }))
}

pub async fn get_bot(
    State(st): State<AppState>,
    _user: AuthUser,
    Path(id): Path<String>,
) -> Response {
    if id != st.bot_id {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"Bot not found"}))).into_response();
    }
    Json(bot_status_json(&st)).into_response()
}

pub async fn live(State(st): State<AppState>, _user: AuthUser) -> Json<Value> {
    Json(live_status(&st))
}

pub fn live_status(st: &AppState) -> Value {
    let connected = st.station.as_ref().is_some_and(|s| s.is_connected());
    let (now, queue) = if let Some(station) = st.station.as_ref() {
        let q = station.queue.lock().expect("queue");
        let cur = q.current();
        let now = cur.as_ref().map(|s| json!({ "name": s.name, "artist": s.artist }));
        let queue: Vec<Value> = q
            .list()
            .iter()
            .take(20)
            .map(|s| json!({ "name": s.name, "artist": s.artist }))
            .collect();
        (now, queue)
    } else {
        (None, Vec::new())
    };
    let mut feedback = Vec::new();
    feedback.push(if connected {
        "TeamSpeak connected."
    } else {
        "TeamSpeak offline."
    });
    if st.radio.enabled() {
        feedback.push("Radio on.");
    } else {
        feedback.push("Radio off.");
    }
    if let Some(n) = now.as_ref() {
        feedback.push("Playing.");
        let _ = n;
    } else if queue.is_empty() {
        feedback.push("Queue empty — !play or enable radio.");
    } else {
        feedback.push("Queue has tracks waiting.");
    }
    let vc = st.voice.config();
    if st.voice.is_active() {
        feedback.push("Voice loop on.");
    } else if vc.enabled {
        feedback.push("Voice enabled but STT URL empty — loop inactive.");
    } else {
        feedback.push("Voice loop off.");
    }
    if st.rag.as_ref().is_some_and(|r| r.rag_enabled()) {
        feedback.push("Doctrine RAG on.");
    } else {
        feedback.push("Doctrine RAG off.");
    }
    json!({
        "connected": connected,
        "nowPlaying": now,
        "queue": queue,
        "radio": {
            "enabled": st.radio.enabled(),
            "activeProfile": st.radio.config().active_profile,
            "nextBumperHint": st.radio.status().songs_until_bumper.map(|n| {
                if n == 0 { "due next".into() } else { format!("in {n}") }
            }).unwrap_or_default(),
            "cuePending": st.radio.status().cue_pending,
        },
        "voice": {
            "enabled": st.voice.config().enabled,
            "duckOnSpeech": st.voice.config().duck_music_on_speech,
            "active": st.voice.is_active(),
        },
        "rag": { "enabled": st.rag.as_ref().is_some_and(|r| r.rag_enabled()) },
        "feedback": feedback,
        "scope": {
            "serverLabel": "",
            "channelHint": null,
            "channelPinned": false,
        }
    })
}

pub async fn settings_get(State(st): State<AppState>, _admin: AdminUser) -> Json<Value> {
    let c = &st.config;
    let (llm_enabled, llm_url, llm_model) = st.brain.llm_snapshot().await;
    Json(json!({
        "idleTimeoutMinutes": 0,
        "llmEnabled": llm_enabled,
        "llmUrl": llm_url,
        "llmModel": llm_model,
        "llmFallbackUrl": c.llm_fallback_url,
        "llmFallbackModel": c.llm_fallback_model,
        "llmDelegateUrl": "",
        "llmDelegateModel": "",
        "llmSystemPrompt": "",
        "llmTemperature": 0.2,
        "roastEnabled": false,
        "roastMinPresent": 3,
        "roastCooldownMinutes": 180,
        "roastMinScore": 4,
        "youtubeSaveEnabled": false,
        "musicOpusBitrateKbps": c.music_opus_bitrate_kbps,
        "musicBlockedGenres": c.music_blocked_genres,
        "autoFollowEnabled": false,
        "autoFollowCooldownSec": 60,
        "ragEnabled": st.rag.as_ref().map(|r| r.rag_enabled()).unwrap_or(c.rag_enabled),
        "ragTopK": st.rag.as_ref().map(|r| r.top_k() as u32).unwrap_or(c.rag_top_k),
        "memoryEnabled": st.rag.as_ref().map(|r| r.memory_enabled()).unwrap_or(c.memory_enabled),
        "kgEnabled": false,
        "mempalaceEnabled": false,
        "mempalaceUrl": "",
        "scOrgStatusUrl": "",
        "scOrgName": "",
        "aceStepEnabled": false,
        "aceStepUrl": "",
        "aceStepAutoFill": false,
        "aceStepTimeoutMs": 300000,
        "aceStepOutputDir": "generated/ace-step",
        "aceStepMaxFiles": 40,
        "fileDropEnabled": false,
        "fileDropPollSec": 30,
        "rightsEnabled": c.rights_enabled,
        "adminGroups": c.admin_groups,
        "rights": c.rights,
        "streamBridgeUrl": "",
        "pokeCommandsEnabled": c.poke_commands_enabled,
        "pokeCommandsPerMinute": 12,
        "trustProxy": c.trust_proxy,
        "trustProxyHops": c.trust_proxy_hops,
        "scope": { "channelHint": "", "serverLabel": "", "virtualServerId": "" },
        "harnessIntentAllowDangerous": false,
        "recordingsEnabled": false,
        "voice": serde_json::to_value(st.voice.config()).unwrap_or_else(|_| json!({})),
        "radio": serde_json::to_value(st.radio.config()).unwrap_or_else(|_| json!({})),
        "vectorDbUrl": c.vector_db_url,
        "embeddingUrl": c.embedding_url,
        "embeddingModel": c.embedding_model,
        "ragCollection": c.rag_collection,
    }))
}

pub async fn settings_post(
    State(st): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<Value>,
) -> Json<Value> {
    if let Some(kbps) = body.get("musicOpusBitrateKbps").and_then(|v| v.as_i64()) {
        if let Some(station) = st.station.as_ref() {
            station.player.set_bitrate_kbps(kbps as i32);
        }
    }
    if body.get("llmEnabled").is_some()
        || body.get("llmUrl").is_some()
        || body.get("llmModel").is_some()
        || body.get("llmSystemPrompt").is_some()
        || body.get("llmTemperature").is_some()
        || body.get("llmFallbackUrl").is_some()
        || body.get("llmFallbackModel").is_some()
    {
        st.brain
            .update_llm(
                body.get("llmEnabled").and_then(|v| v.as_bool()),
                body.get("llmUrl").and_then(|v| v.as_str()).map(str::to_string),
                body.get("llmModel").and_then(|v| v.as_str()).map(str::to_string),
                body.get("llmSystemPrompt")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                body.get("llmTemperature")
                    .and_then(|v| v.as_f64())
                    .map(|n| n as f32),
                body.get("llmFallbackUrl")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                body.get("llmFallbackModel")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
            )
            .await;
    }
    if let Some(rag) = st.rag.as_ref() {
        if let Some(v) = body.get("ragEnabled").and_then(|v| v.as_bool()) {
            rag.set_rag_enabled(v);
        }
        if let Some(v) = body.get("memoryEnabled").and_then(|v| v.as_bool()) {
            rag.set_memory_enabled(v);
        }
        if let Some(v) = body.get("ragTopK").and_then(|v| v.as_u64()) {
            rag.set_top_k(v as usize);
        }
    }
    if let Some(v) = body.get("voice") {
        match patch_voice(&st.voice.config(), v) {
            Ok(next) => {
                st.radio.set_tts(next.tts_url.clone(), next.tts_voice.clone());
                st.voice.apply(next);
            }
            Err(msg) => {
                return Json(json!({ "ok": false, "error": msg, "code": "VALIDATION_ERROR" }));
            }
        }
    }
    if let Some(v) = body.get("radio") {
        match patch_radio(&st.radio.config(), v) {
            Ok(next) => {
                let on = next.enabled;
                st.radio.apply(next);
                if on {
                    let _ = st.radio.program_active();
                }
            }
            Err(msg) => {
                return Json(json!({ "ok": false, "error": msg, "code": "VALIDATION_ERROR" }));
            }
        }
    }
    Json(json!({ "ok": true }))
}

fn patch_radio(prev: &mp_config::RadioConfig, v: &Value) -> Result<mp_config::RadioConfig, String> {
    if !v.is_object() {
        return Err("radio must be an object".into());
    }
    let mut next = prev.clone();
    if let Some(b) = v.get("enabled") {
        next.enabled = b
            .as_bool()
            .ok_or_else(|| "radio.enabled must be a boolean".to_string())?;
    }
    if let Some(n) = v.get("everyNSongs") {
        next.every_n_songs = n
            .as_u64()
            .ok_or_else(|| "radio.everyNSongs must be a number".to_string())?
            as u32;
    }
    if let Some(n) = v.get("deadAirSeconds") {
        next.dead_air_seconds = n
            .as_u64()
            .ok_or_else(|| "radio.deadAirSeconds must be a number".to_string())?;
    }
    if let Some(n) = v.get("speechVolumePct") {
        let n = n
            .as_f64()
            .ok_or_else(|| "radio.speechVolumePct must be 0–100".to_string())?;
        if !(0.0..=100.0).contains(&n) {
            return Err("radio.speechVolumePct must be 0–100".into());
        }
        next.speech_volume_pct = n as u32;
    }
    if let Some(s) = v.get("activeProfile").and_then(|x| x.as_str()) {
        if !s.is_empty() {
            next.active_profile = s.to_string();
        }
    }
    if let Some(n) = v.get("minPresentToBroadcast") {
        next.min_present_to_broadcast = n
            .as_u64()
            .ok_or_else(|| "radio.minPresentToBroadcast must be a number".to_string())?
            as u32;
    }
    Ok(next)
}

fn patch_voice(prev: &mp_config::VoiceConfig, v: &Value) -> Result<mp_config::VoiceConfig, String> {
    if !v.is_object() {
        return Err("voice must be an object".into());
    }
    let mut next = prev.clone();
    if let Some(b) = v.get("enabled") {
        next.enabled = b
            .as_bool()
            .ok_or_else(|| "voice.enabled must be a boolean".to_string())?;
    }
    if let Some(b) = v.get("respondWithVoice") {
        next.respond_with_voice = b
            .as_bool()
            .ok_or_else(|| "voice.respondWithVoice must be a boolean".to_string())?;
    }
    fn req_str(v: &Value, key: &str) -> Result<Option<String>, String> {
        match v.get(key) {
            None => Ok(None),
            Some(val) => val
                .as_str()
                .map(|s| Some(s.to_string()))
                .ok_or_else(|| format!("voice.{key} must be a string")),
        }
    }
    if let Some(s) = req_str(v, "sttUrl")? {
        next.stt_url = s;
    }
    if let Some(s) = req_str(v, "ttsUrl")? {
        next.tts_url = s;
    }
    if let Some(s) = req_str(v, "ttsVoice")? {
        next.tts_voice = s;
    }
    if let Some(s) = req_str(v, "watchword")? {
        next.watchword = s;
    }
    if let Some(b) = v.get("requireWatchword") {
        next.require_watchword = b
            .as_bool()
            .ok_or_else(|| "voice.requireWatchword must be a boolean".to_string())?;
    }
    if let Some(b) = v.get("duckMusicOnSpeech") {
        next.duck_music_on_speech = b
            .as_bool()
            .ok_or_else(|| "voice.duckMusicOnSpeech must be a boolean".to_string())?;
    }
    if let Some(n) = v.get("duckMusicVolume") {
        let n = n
            .as_f64()
            .ok_or_else(|| "voice.duckMusicVolume must be a number 0–100".to_string())?;
        if !(0.0..=100.0).contains(&n) {
            return Err("voice.duckMusicVolume must be a number 0–100".into());
        }
        next.duck_music_volume = n as u32;
    }
    if let Some(n) = v.get("listenWindowMs") {
        let n = n
            .as_u64()
            .ok_or_else(|| "voice.listenWindowMs must be 5000–60000".to_string())?;
        if !(5000..=60_000).contains(&n) {
            return Err("voice.listenWindowMs must be 5000–60000".into());
        }
        next.listen_window_ms = n;
    }
    if let Some(n) = v.get("energyThreshold") {
        next.energy_threshold = n
            .as_f64()
            .ok_or_else(|| "voice.energyThreshold must be a number".to_string())?;
    }
    if let Some(b) = v.get("karaokeMode") {
        next.karaoke_mode = b
            .as_bool()
            .ok_or_else(|| "voice.karaokeMode must be a boolean".to_string())?;
    }
    if let Some(b) = v.get("textWakeFallback") {
        next.text_wake_fallback = b
            .as_bool()
            .ok_or_else(|| "voice.textWakeFallback must be a boolean".to_string())?;
    }
    Ok(next)
}

pub async fn start_bot(
    State(st): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<String>,
) -> Response {
    if id != st.bot_id {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"Bot not found"}))).into_response();
    }
    Json(json!({ "ok": true, "message": "already managed by TS6_HOST" })).into_response()
}

pub async fn stop_bot(
    State(st): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<String>,
) -> Response {
    if id != st.bot_id {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"Bot not found"}))).into_response();
    }
    Json(json!({ "ok": true, "message": "stop is a process restart in the rust runtime" })).into_response()
}

pub async fn bot_config(
    State(st): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<String>,
) -> Response {
    if id != st.bot_id {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"Bot config not found"}))).into_response();
    }
    Json(json!({
        "id": st.bot_id,
        "name": st.bot_name,
        "serverAddress": std::env::var("TS6_HOST").unwrap_or_default(),
        "serverPort": std::env::var("TS6_PORT").ok().and_then(|s| s.parse::<u16>().ok()).unwrap_or(9987),
        "nickname": st.bot_name,
        "defaultChannel": std::env::var("DEFAULT_CHANNEL").unwrap_or_default(),
        "autoStart": true,
        "serverProtocol": "ts6",
    }))
    .into_response()
}

pub async fn create_bot(_admin: AdminUser) -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({"error":"multi-bot create not ported (single rust process)"})),
    )
        .into_response()
}

pub async fn delete_bot(_admin: AdminUser) -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({"error":"multi-bot delete not ported"})),
    )
        .into_response()
}

pub async fn recordings_list(_user: AuthUser) -> Json<Value> {
    Json(json!({ "enabled": false, "recordings": [] }))
}
