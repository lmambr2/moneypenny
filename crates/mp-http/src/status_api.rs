// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Admin status probes + org KG HTTP. Vue Settings / Harness.

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::authz::AdminUser;
use crate::AppState;
use mp_rights::{Scope, Subject};
use mp_voice::probe_http_health;

pub async fn llm_status(State(st): State<AppState>, _admin: AdminUser) -> Json<Value> {
    let (enabled, url, model) = st.brain.llm_snapshot().await;
    let configured = enabled && !url.trim().is_empty();
    let available = if configured {
        probe_llm(&url).await
    } else {
        false
    };
    Json(json!({
        "configured": configured,
        "available": available,
        "primaryAvailable": available,
        "fallbackAvailable": false,
        "fallbackConfigured": !st.config.llm_fallback_url.trim().is_empty(),
        "activeFallback": false,
        "delegateConfigured": false,
        "delegateAvailable": false,
        "url": url,
        "model": model,
    }))
}

async fn probe_llm(url: &str) -> bool {
    let base = url.trim().trim_end_matches('/');
    if base.is_empty() {
        return false;
    }
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    for path in ["/v1/models", "/api/tags", "/health"] {
        if let Ok(res) = client.get(format!("{base}{path}")).send().await {
            if res.status().is_success() {
                return true;
            }
        }
    }
    false
}

pub async fn rag_status(State(st): State<AppState>, _admin: AdminUser) -> Json<Value> {
    let Some(rag) = st.rag.as_ref() else {
        return Json(json!({
            "configured": st.config.rag_enabled,
            "available": false,
            "docCount": 0,
            "topK": st.config.rag_top_k,
            "vectorDbUrl": st.config.vector_db_url,
            "embeddingUrl": st.config.embedding_url,
            "embeddingModel": st.config.embedding_model,
            "ragCollection": st.config.rag_collection,
        }));
    };
    let available = rag.rag_enabled();
    Json(json!({
        "configured": rag.rag_enabled(),
        "available": available,
        "docCount": rag.doctrine.list().len(),
        "topK": rag.top_k(),
        "vectorDbUrl": st.config.vector_db_url,
        "embeddingUrl": st.config.embedding_url,
        "embeddingModel": st.config.embedding_model,
        "ragCollection": st.config.rag_collection,
    }))
}

pub async fn memory_status(State(st): State<AppState>, _admin: AdminUser) -> Json<Value> {
    let url = if st.config.mempalace_url.trim().is_empty() {
        std::env::var("MEMPALACE_URL").unwrap_or_default()
    } else {
        st.config.mempalace_url.clone()
    };
    let url = url.trim().trim_end_matches('/').to_string();
    let configured = st.rag.as_ref().is_some_and(|r| r.mempalace_enabled()) && !url.is_empty();
    let available = if configured {
        if let Some(c) = st.rag.as_ref().and_then(|r| r.mempalace.clone()) {
            c.is_available().await
        } else {
            false
        }
    } else {
        false
    };
    Json(json!({
        "configured": configured,
        "available": available,
        "url": url,
        "memoryEnabled": st.rag.as_ref().is_some_and(|r| r.memory_enabled()),
        "kgEnabled": st.rag.as_ref().is_some_and(|r| r.kg_enabled()),
        "lastUserSync": null,
    }))
}

pub async fn stream_bridge_status(State(st): State<AppState>, _admin: AdminUser) -> Json<Value> {
    let url = if st.config.stream_bridge_url.trim().is_empty() {
        std::env::var("STREAM_BRIDGE_URL").unwrap_or_default()
    } else {
        st.config.stream_bridge_url.clone()
    };
    let url = url.trim().trim_end_matches('/').to_string();
    if url.is_empty() {
        return Json(json!({ "configured": false, "available": false, "loggedIn": false }));
    }
    let available = probe_http_health(&url, std::time::Duration::from_secs(5)).await;
    Json(json!({
        "configured": true,
        "available": available,
        "loggedIn": available,
    }))
}

#[derive(Deserialize)]
pub struct RightsDebugQuery {
    uid: Option<String>,
    groups: Option<String>,
}

pub async fn rights_debug(
    State(st): State<AppState>,
    _admin: AdminUser,
    Query(q): Query<RightsDebugQuery>,
) -> Json<Value> {
    let groups: Vec<String> = q
        .groups
        .as_deref()
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let uid = q
        .uid
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(if groups.is_empty() {
            "debug-public-sample"
        } else {
            "debug-subject"
        });
    let subject = Subject {
        uid: uid.to_string(),
        server_groups: groups,
        nickname: None,
    };
    let Some(engine) = st.rights.as_ref() else {
        return Json(json!({
            "subject": { "uid": subject.uid, "serverGroups": subject.server_groups },
            "rightsEnabled": false,
            "chat": ["*"],
            "voice": ["*"],
        }));
    };
    let mut chat: Vec<String> = engine.compute_allowed(&subject, Scope::Chat).into_iter().collect();
    let mut voice: Vec<String> = engine.compute_allowed(&subject, Scope::Voice).into_iter().collect();
    chat.sort();
    voice.sort();
    Json(json!({
        "subject": { "uid": subject.uid, "serverGroups": subject.server_groups },
        "rightsEnabled": st.config.rights_enabled,
        "chat": chat,
        "voice": voice,
    }))
}

pub async fn ops_status(State(st): State<AppState>, _admin: AdminUser) -> Json<Value> {
    let mut text = ops_brief(&st);
    for r in st.sc_org.get_all().await {
        text.push('\n');
        text.push_str(&format!("{} {}: {}", if r.ok { "✓" } else { "○" }, r.label, r.text));
    }
    Json(json!({ "text": text }))
}

pub(crate) fn ops_brief(st: &AppState) -> String {
    let radio = st.radio.status();
    let now = st.station.as_ref().and_then(|s| {
        s.queue
            .lock()
            .ok()
            .and_then(|q| q.current().map(|c| format!("{} — {}", c.name, c.artist)))
    });
    let kg_n = st.rag.as_ref().map(|r| r.kg.count()).unwrap_or(0);
    let docs = st.rag.as_ref().map(|r| r.doctrine.list().len()).unwrap_or(0);
    let rag_on = st.rag.as_ref().is_some_and(|r| r.rag_enabled());
    format!(
        "📋 Ops status\nRadio: {} (profile {})\nNow playing: {}\nOrg KG: {kg_n} fact(s)\nDoctrine: {docs} doc(s){}\n",
        if radio.enabled { "ON" } else { "OFF" },
        radio.active_profile,
        now.as_deref().unwrap_or("(nothing)"),
        if rag_on { " · RAG on" } else { " · RAG off" },
    )
}

#[derive(Deserialize)]
pub struct MemoryQuery {
    uid: Option<String>,
}

pub async fn memory_scopes(
    State(st): State<AppState>,
    _admin: AdminUser,
    Query(q): Query<MemoryQuery>,
) -> Json<Value> {
    let mem_on = st.rag.as_ref().is_some_and(|r| r.memory_enabled());
    let kg_on = st.rag.as_ref().is_some_and(|r| r.kg_enabled());
    let broadcast = st.radio.config().memory_broadcast_opt_in;
    let private_count = q
        .uid
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|uid| st.db.memory().count(uid).ok());
    let org_count = st.rag.as_ref().map(|r| r.kg.count());
    Json(json!({
        "scopes": [
            {
                "id": "private",
                "label": "Per-user private",
                "commands": ["!remember", "!recall", "!forget"],
                "injectIntoAsk": if mem_on { "Injected into that user's !ask only" } else { "Stored, but injection is off in Settings" },
                "broadcastOk": false,
                "notes": "Never used for radio memory bumpers. Scoped by TeamSpeak uid. MemPalace rooms stay personal.",
            },
            {
                "id": "org",
                "label": "Org knowledge graph",
                "commands": ["!kg remember|who|list|forget", "!diary", "POST /api/bot/org-kg"],
                "injectIntoAsk": if kg_on { "Injected into everyone's !ask when KG is on" } else { "Stored, but org injection is off in Settings" },
                "broadcastOk": broadcast,
                "notes": if broadcast {
                    "Radio memory bumper may speak org facts (opt-in)."
                } else {
                    "Radio memory bumper blocked until “Org memory on air” is enabled."
                },
            }
        ],
        "privateCount": private_count,
        "orgCount": org_count,
        "isolationRule": "Private !remember rooms never feed radio memory bumpers. Org KG only (opt-in).",
    }))
}

pub async fn memory_private(
    State(st): State<AppState>,
    _admin: AdminUser,
    Query(q): Query<MemoryQuery>,
) -> Response {
    let uid = q.uid.unwrap_or_default().trim().to_string();
    if uid.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"uid is required","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    let facts = st.db.memory().recall(&uid, 20).unwrap_or_default();
    Json(json!({
        "uid": uid,
        "facts": facts.iter().map(|f| json!({
            "id": f.id,
            "fact": f.fact,
            "createdAt": f.created_at,
        })).collect::<Vec<_>>(),
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct OrgKgBody {
    fact: Option<String>,
}

pub async fn org_kg_get(State(st): State<AppState>, _admin: AdminUser) -> Json<Value> {
    let facts = st
        .rag
        .as_ref()
        .map(|r| r.kg.list_facts(30))
        .unwrap_or_else(|| st.db.kg().list(30).unwrap_or_default());
    Json(json!({ "facts": facts }))
}

pub async fn org_kg_post(
    State(st): State<AppState>,
    admin: AdminUser,
    Json(body): Json<OrgKgBody>,
) -> Response {
    let fact = body.fact.unwrap_or_default().trim().to_string();
    if fact.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"fact is required","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    let Some(rag) = st.rag.as_ref() else {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"No bot instance available","code":"NO_BOT"})),
        )
            .into_response();
    };
    let uid = format!("web:{}", admin.0.username);
    let (ok, message, synced) = rag.kg.seed_org_fact(&fact, Some(&uid)).await;
    if !ok {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": message, "code":"KG_ERROR"})),
        )
            .into_response();
    }
    Json(json!({
        "ok": true,
        "message": message,
        "syncedToMemPalace": synced,
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct LlmAskBody {
    question: Option<String>,
}

pub async fn llm_ask(
    State(st): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<LlmAskBody>,
) -> Response {
    let q = body.question.unwrap_or_default().trim().to_string();
    if q.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"question is required"})),
        )
            .into_response();
    }
    let (enabled, _, _) = st.brain.llm_snapshot().await;
    if !enabled {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"LLM is not enabled"})),
        )
            .into_response();
    }
    match st
        .brain
        .complete_plain(
            "You are Moneypenny. Answer briefly and factually. No tools.",
            &q,
        )
        .await
    {
        Some(answer) => Json(json!({ "answer": answer })).into_response(),
        None => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error":"LLM request failed"})),
        )
            .into_response(),
    }
}
