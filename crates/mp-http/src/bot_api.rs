// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! `/api/bot` — list/status/settings/live. Multi-bot CRUD stays a stub.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use crate::AppState;
use crate::authz::{AdminUser, AuthUser};
use crate::json_song::queued_json;
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
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"Bot not found"})),
        )
            .into_response();
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
        let now = cur
            .as_ref()
            .map(|s| json!({ "name": s.name, "artist": s.artist }));
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
    let (llm_enabled, llm_url, llm_model) = st.brain.llm_snapshot().await;
    let (llm_system_prompt, llm_temperature) = st.brain.llm_form_snapshot().await;
    let c = st.read_config().clone();
    Json(json!({
        "idleTimeoutMinutes": 0,
        "llmEnabled": llm_enabled,
        "llmUrl": llm_url,
        "llmModel": llm_model,
        "llmFallbackUrl": c.llm_fallback_url,
        "llmFallbackModel": c.llm_fallback_model,
        "llmDelegateUrl": c.llm_delegate_url,
        "llmDelegateModel": c.llm_delegate_model,
        "llmSystemPrompt": llm_system_prompt,
        "llmSystemPromptDefault": mp_brain::DEFAULT_SYSTEM_PROMPT,
        "llmTemperature": llm_temperature,
        "roastEnabled": st.roast.config().enabled,
        "roastMinPresent": st.roast.config().min_present,
        "roastCooldownMinutes": st.roast.config().cooldown_minutes,
        "roastMinScore": st.roast.config().min_score,
        "youtubeSaveEnabled": st.station.as_ref().is_some_and(|s| s.youtube_save_enabled()),
        "musicOpusBitrateKbps": c.music_opus_bitrate_kbps,
        "musicBlockedGenres": c.music_blocked_genres,
        "autoFollowEnabled": st.follow.enabled(),
        "autoFollowCooldownSec": st.follow.cooldown_sec(),
        "scOrgStatusUrl": st.sc_org.url(),
        "scOrgName": st.sc_org.name(),
        "ragEnabled": st.rag.as_ref().map(|r| r.rag_enabled()).unwrap_or(c.rag_enabled),
        "ragTopK": st.rag.as_ref().map(|r| r.top_k() as u32).unwrap_or(c.rag_top_k),
        "memoryEnabled": st.rag.as_ref().map(|r| r.memory_enabled()).unwrap_or(c.memory_enabled),
        "kgEnabled": st.rag.as_ref().map(|r| r.kg_enabled()).unwrap_or(c.kg_enabled),
        "mempalaceEnabled": st.rag.as_ref().is_some_and(|r| r.mempalace_enabled()),
        "mempalaceUrl": c.mempalace_url,
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
        "streamBridgeUrl": c.stream_bridge_url,
        "pokeCommandsEnabled": c.poke_commands_enabled,
        "pokeCommandsPerMinute": 12,
        "trustProxy": c.trust_proxy,
        "trustProxyHops": c.trust_proxy_hops,
        "scope": { "channelHint": "", "serverLabel": "", "virtualServerId": "" },
        "harnessIntentAllowDangerous": st.harness_allow_dangerous.load(std::sync::atomic::Ordering::SeqCst),
        "recordingsEnabled": st.recordings_enabled.load(std::sync::atomic::Ordering::SeqCst),
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
    if let Some(on) = body.get("autoFollowEnabled").and_then(|v| v.as_bool()) {
        st.follow.set_enabled(on);
    }
    if let Some(n) = body.get("autoFollowCooldownSec").and_then(|v| v.as_u64()) {
        st.follow.set_cooldown_sec(n);
    }
    if let Some(s) = body.get("scOrgStatusUrl").and_then(|v| v.as_str()) {
        match crate::sc_org::normalize_sc_org_base_url(s) {
            Ok(u) => st.sc_org.set_url(u),
            Err(msg) => {
                return Json(json!({ "ok": false, "error": msg, "code": "VALIDATION_ERROR" }));
            }
        }
    }
    if let Some(s) = body.get("scOrgName").and_then(|v| v.as_str()) {
        st.sc_org.set_name(s.trim().to_string());
    }
    if let Some(on) = body.get("youtubeSaveEnabled").and_then(|v| v.as_bool()) {
        if let Some(station) = st.station.as_ref() {
            station.set_youtube_save_enabled(on);
        }
    }
    if let Some(rag) = st.rag.as_ref() {
        if let Some(v) = body.get("mempalaceEnabled").and_then(|v| v.as_bool()) {
            rag.set_mempalace_enabled(v);
        }
    }
    if let Some(v) = body.get("rights") {
        if !v.is_null() && mp_rights::parse_rights_config(v).is_none() {
            return Json(json!({
                "ok": false,
                "error": "rights JSON is invalid",
                "code": "VALIDATION_ERROR"
            }));
        }
    }
    if body.get("llmEnabled").is_some()
        || body.get("llmUrl").is_some()
        || body.get("llmModel").is_some()
        || body.get("llmSystemPrompt").is_some()
        || body.get("llmTemperature").is_some()
        || body.get("llmFallbackUrl").is_some()
        || body.get("llmFallbackModel").is_some()
        || body.get("llmDelegateUrl").is_some()
        || body.get("llmDelegateModel").is_some()
    {
        st.brain
            .update_llm(
                body.get("llmEnabled").and_then(|v| v.as_bool()),
                body.get("llmUrl")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                body.get("llmModel")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
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
                body.get("llmDelegateUrl")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                body.get("llmDelegateModel")
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
        if let Some(v) = body.get("kgEnabled").and_then(|v| v.as_bool()) {
            rag.set_kg_enabled(v);
        }
        if let Some(v) = body.get("ragTopK").and_then(|v| v.as_u64()) {
            rag.set_top_k(v as usize);
        }
    }
    if let Some(v) = body.get("voice") {
        match patch_voice(&st.voice.config(), v) {
            Ok(next) => {
                st.radio
                    .set_tts(next.tts_url.clone(), next.tts_voice.clone());
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
    if body.get("roastEnabled").is_some()
        || body.get("roastMinPresent").is_some()
        || body.get("roastCooldownMinutes").is_some()
        || body.get("roastMinScore").is_some()
    {
        let mut next = st.roast.config();
        if let Some(b) = body.get("roastEnabled") {
            match b.as_bool() {
                Some(v) => next.enabled = v,
                None => {
                    return Json(
                        json!({ "ok": false, "error": "roastEnabled must be a boolean", "code": "VALIDATION_ERROR" }),
                    );
                }
            }
        }
        if let Some(n) = body.get("roastMinPresent") {
            match n.as_u64() {
                Some(v) => next.min_present = v.max(1) as u32,
                None => {
                    return Json(
                        json!({ "ok": false, "error": "roastMinPresent must be a number", "code": "VALIDATION_ERROR" }),
                    );
                }
            }
        }
        if let Some(n) = body.get("roastCooldownMinutes") {
            match n.as_u64() {
                Some(v) => next.cooldown_minutes = v as u32,
                None => {
                    return Json(
                        json!({ "ok": false, "error": "roastCooldownMinutes must be a number", "code": "VALIDATION_ERROR" }),
                    );
                }
            }
        }
        if let Some(n) = body.get("roastMinScore") {
            match n.as_i64() {
                Some(v) => next.min_score = v.clamp(0, 10),
                None => {
                    return Json(
                        json!({ "ok": false, "error": "roastMinScore must be a number", "code": "VALIDATION_ERROR" }),
                    );
                }
            }
        }
        st.roast.apply(next);
    }
    if let Some(v) = body.get("recordingsEnabled").and_then(|x| x.as_bool()) {
        st.recordings_enabled
            .store(v, std::sync::atomic::Ordering::SeqCst);
    }
    if let Some(v) = body
        .get("harnessIntentAllowDangerous")
        .and_then(|x| x.as_bool())
    {
        st.harness_allow_dangerous
            .store(v, std::sync::atomic::Ordering::SeqCst);
    }
    if let Err(msg) = sync_saved_config(&st, &body) {
        return Json(json!({ "ok": false, "error": msg, "code": "VALIDATION_ERROR" }));
    }
    if body.get("rights").is_some()
        || body.get("rightsEnabled").is_some()
        || body.get("adminGroups").is_some()
    {
        reload_rights(&st);
    }
    if let Err(e) = persist_settings(&st, &body) {
        tracing::error!(error = %e, path = %st.config_path.display(), "config.json write failed");
        return Json(json!({
            "ok": false,
            "error": format!("failed to write config.json: {e}"),
            "code": "CONFIG_WRITE"
        }));
    }
    Json(json!({ "ok": true }))
}

fn persist_settings(st: &AppState, body: &Value) -> Result<(), String> {
    if st.config_path.as_os_str().is_empty() {
        return Ok(());
    }
    let mut patch = serde_json::Map::new();
    const KEYS: &[&str] = &[
        "llmEnabled",
        "llmUrl",
        "llmModel",
        "llmFallbackUrl",
        "llmFallbackModel",
        "llmDelegateUrl",
        "llmDelegateModel",
        "llmSystemPrompt",
        "llmTemperature",
        "embeddingUrl",
        "embeddingModel",
        "vectorDbUrl",
        "ragCollection",
        "ragEnabled",
        "ragTopK",
        "memoryEnabled",
        "kgEnabled",
        "roastEnabled",
        "roastMinPresent",
        "roastCooldownMinutes",
        "roastMinScore",
        "musicOpusBitrateKbps",
        "musicBlockedGenres",
        "autoFollowEnabled",
        "autoFollowCooldownSec",
        "scOrgStatusUrl",
        "scOrgName",
        "youtubeSaveEnabled",
        "mempalaceEnabled",
        "mempalaceUrl",
        "streamBridgeUrl",
        "recordingsEnabled",
        "harnessIntentAllowDangerous",
        "rightsEnabled",
        "adminGroups",
        "rights",
        "pokeCommandsEnabled",
        "trustProxy",
        "trustProxyHops",
    ];
    for k in KEYS {
        if let Some(v) = body.get(*k) {
            patch.insert((*k).to_string(), v.clone());
        }
    }
    if body.get("voice").is_some() {
        patch.insert(
            "voice".into(),
            serde_json::to_value(st.voice.config()).unwrap_or_else(|_| json!({})),
        );
    }
    if body.get("radio").is_some() {
        patch.insert(
            "radio".into(),
            serde_json::to_value(st.radio.config()).unwrap_or_else(|_| json!({})),
        );
    }
    if patch.is_empty() {
        return Ok(());
    }
    mp_config::save_config_merge(&st.config_path, &Value::Object(patch)).map_err(|e| e.to_string())
}

fn patch_radio(prev: &mp_config::RadioConfig, v: &Value) -> Result<mp_config::RadioConfig, String> {
    if !v.is_object() {
        return Err("radio must be an object".into());
    }
    let mut base = serde_json::to_value(prev).map_err(|e| e.to_string())?;
    mp_config::merge_json_objects(&mut base, v);
    let mut next: mp_config::RadioConfig =
        serde_json::from_value(base).map_err(|e| format!("radio: {e}"))?;
    if next.active_profile.trim().is_empty() {
        next.active_profile = prev.active_profile.clone();
    }
    if next.speech_volume_pct > 100 {
        return Err("radio.speechVolumePct must be 0–100".into());
    }
    Ok(next)
}

/// Copy the fields Settings posted onto the live config snapshot.
/// A persona-only body writes only the prompt. Embedding clients stay on the
/// process that booted them; the saved URL is what the next start loads.
fn sync_saved_config(st: &AppState, body: &Value) -> Result<(), String> {
    let mut cfg = st.config.write().unwrap_or_else(|e| e.into_inner());
    fn text<'a>(body: &'a Value, key: &str) -> Option<&'a str> {
        body.get(key).and_then(|v| v.as_str())
    }
    if let Some(s) = text(body, "llmUrl") {
        cfg.llm_url = s.to_string();
    }
    if let Some(s) = text(body, "llmModel") {
        cfg.llm_model = s.to_string();
    }
    if let Some(s) = text(body, "llmFallbackUrl") {
        cfg.llm_fallback_url = s.to_string();
    }
    if let Some(s) = text(body, "llmFallbackModel") {
        cfg.llm_fallback_model = s.to_string();
    }
    if let Some(s) = text(body, "llmDelegateUrl") {
        cfg.llm_delegate_url = s.to_string();
    }
    if let Some(s) = text(body, "llmDelegateModel") {
        cfg.llm_delegate_model = s.to_string();
    }
    if let Some(s) = text(body, "llmSystemPrompt") {
        cfg.llm_system_prompt = s.to_string();
    }
    if let Some(n) = body.get("llmTemperature").and_then(|v| v.as_f64()) {
        cfg.llm_temperature = n as f32;
    }
    if let Some(b) = body.get("llmEnabled").and_then(|v| v.as_bool()) {
        cfg.llm_enabled = b;
    }
    if let Some(s) = text(body, "embeddingUrl") {
        cfg.embedding_url = s.to_string();
    }
    if let Some(s) = text(body, "embeddingModel") {
        cfg.embedding_model = s.to_string();
    }
    if let Some(s) = text(body, "vectorDbUrl") {
        cfg.vector_db_url = s.to_string();
    }
    if let Some(s) = text(body, "ragCollection") {
        cfg.rag_collection = s.to_string();
    }
    if let Some(s) = text(body, "mempalaceUrl") {
        cfg.mempalace_url = s.to_string();
    }
    if let Some(s) = text(body, "streamBridgeUrl") {
        cfg.stream_bridge_url = s.to_string();
    }
    if let Some(b) = body.get("mempalaceEnabled").and_then(|v| v.as_bool()) {
        cfg.mempalace_enabled = b;
    }
    if let Some(b) = body.get("ragEnabled").and_then(|v| v.as_bool()) {
        cfg.rag_enabled = b;
    }
    if let Some(b) = body.get("memoryEnabled").and_then(|v| v.as_bool()) {
        cfg.memory_enabled = b;
    }
    if let Some(b) = body.get("kgEnabled").and_then(|v| v.as_bool()) {
        cfg.kg_enabled = b;
    }
    if let Some(n) = body.get("ragTopK").and_then(|v| v.as_u64()) {
        cfg.rag_top_k = n as u32;
    }
    if let Some(b) = body.get("rightsEnabled").and_then(|v| v.as_bool()) {
        cfg.rights_enabled = b;
    }
    if let Some(v) = body.get("rights") {
        cfg.rights = if v.is_null() { None } else { Some(v.clone()) };
    }
    if let Some(arr) = body.get("adminGroups") {
        let arr = arr
            .as_array()
            .ok_or_else(|| "adminGroups must be an array".to_string())?;
        cfg.admin_groups = arr
            .iter()
            .map(|n| {
                n.as_i64()
                    .map(|i| i as i32)
                    .ok_or_else(|| "adminGroups must be integers".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
    }
    if let Some(arr) = body.get("musicBlockedGenres") {
        let arr = arr
            .as_array()
            .ok_or_else(|| "musicBlockedGenres must be an array".to_string())?;
        cfg.music_blocked_genres = arr
            .iter()
            .map(|s| {
                s.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| "musicBlockedGenres must be strings".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
    }
    if let Some(b) = body.get("pokeCommandsEnabled").and_then(|v| v.as_bool()) {
        cfg.poke_commands_enabled = b;
    }
    if let Some(b) = body.get("trustProxy").and_then(|v| v.as_bool()) {
        cfg.trust_proxy = b;
    }
    if let Some(n) = body.get("trustProxyHops").and_then(|v| v.as_u64()) {
        cfg.trust_proxy_hops = n.min(5) as u32;
    }
    if let Some(n) = body.get("musicOpusBitrateKbps").and_then(|v| v.as_u64()) {
        cfg.music_opus_bitrate_kbps = n as u32;
    }
    if let Some(b) = body.get("youtubeSaveEnabled").and_then(|v| v.as_bool()) {
        cfg.youtube_save_enabled = b;
    }
    if let Some(b) = body.get("recordingsEnabled").and_then(|v| v.as_bool()) {
        cfg.recordings_enabled = b;
    }
    if let Some(b) = body
        .get("harnessIntentAllowDangerous")
        .and_then(|v| v.as_bool())
    {
        cfg.harness_intent_allow_dangerous = b;
    }
    if let Some(s) = text(body, "scOrgStatusUrl") {
        cfg.sc_org_status_url = s.to_string();
    }
    if let Some(s) = text(body, "scOrgName") {
        cfg.sc_org_name = s.to_string();
    }
    if let Some(b) = body.get("autoFollowEnabled").and_then(|v| v.as_bool()) {
        cfg.auto_follow_enabled = b;
    }
    if let Some(n) = body.get("autoFollowCooldownSec").and_then(|v| v.as_u64()) {
        cfg.auto_follow_cooldown_sec = n;
    }
    if body.get("voice").is_some() {
        cfg.voice = st.voice.config();
    }
    if body.get("radio").is_some() {
        cfg.radio = st.radio.config();
    }
    Ok(())
}

fn reload_rights(st: &AppState) {
    let Some(engine) = st.rights.as_ref() else {
        return;
    };
    let cfg = st.read_config();
    if !cfg.rights_enabled {
        return;
    }
    let next = if let Some(v) = cfg.rights.as_ref() {
        match mp_rights::parse_rights_config(v) {
            Some(parsed) => parsed,
            None => return,
        }
    } else {
        mp_control::legacy_rights_config(&cfg.admin_groups)
    };
    drop(cfg);
    engine.reload(next);
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
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"Bot not found"})),
        )
            .into_response();
    }
    Json(json!({
        "ok": true,
        "code": "ALREADY_MANAGED",
        "message": "already managed by TS6_HOST"
    }))
    .into_response()
}

pub async fn stop_bot(
    State(st): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<String>,
) -> Response {
    if id != st.bot_id {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"Bot not found"})),
        )
            .into_response();
    }
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "ok": false,
            "error": "stop is a process restart in the rust runtime",
            "code": "NOT_PORTED"
        })),
    )
        .into_response()
}

pub async fn bot_config(
    State(st): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<String>,
) -> Response {
    if id != st.bot_id {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"Bot config not found"})),
        )
            .into_response();
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

#[cfg(test)]
mod tests {
    use super::*;
    use mp_config::{BumperSource, QuietWindow, RadioConfig};

    #[test]
    fn radio_patch_keeps_lines_zones_sources_and_quiet_hours() {
        let prev = RadioConfig {
            station_id_lines: vec!["This is the station.".into()],
            quiet_hours: vec![QuietWindow {
                from: "01:00".into(),
                to: "02:00".into(),
            }],
            empty_channel_stop_seconds: 10,
            ..RadioConfig::default()
        };
        let patch = json!({
            "enabled": true,
            "emptyChannelStopSeconds": -1,
            "speechVolumePct": 85,
            "stationIdLines": ["This is the station.", "Stay tuned."],
            "timeCheckTimezones": ["America/Denver|Denver"],
            "sources": ["stationId", "timeCheck", "doctrine"],
            "profiles": {
                "focus": {
                    "name": "focus",
                    "music": { "select": { "bpmMax": 110, "mood": ["calm"] } },
                    "bumper": { "topics": ["ops"], "tone": "dry" }
                }
            },
            "icecast": { "enabled": false, "mountUrl": "" }
        });
        let next = patch_radio(&prev, &patch).expect("radio patch");
        assert_eq!(next.empty_channel_stop_seconds, -1);
        assert_eq!(
            next.station_id_lines,
            vec![
                "This is the station.".to_string(),
                "Stay tuned.".to_string()
            ]
        );
        assert_eq!(next.time_check_timezones, vec!["America/Denver|Denver"]);
        assert!(next.sources.contains(&BumperSource::Doctrine));
        assert_eq!(next.quiet_hours[0].from, "01:00");
        assert!(next.profiles.contains_key("lobby"));
        let select = next.profiles["focus"].music.select.as_ref().unwrap();
        assert_eq!(select.bpm_max, Some(110.0));
        assert_eq!(select.mood, vec!["calm".to_string()]);
        assert!(patch_radio(&prev, &json!({ "speechVolumePct": 140 })).is_err());
    }
}
