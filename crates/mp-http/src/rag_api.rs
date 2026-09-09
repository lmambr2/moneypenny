// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Admin doctrine + RAG primitives. Vue Library → Doctrine.

use axum::extract::{Multipart, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::authz::AdminUser;
use crate::AppState;
use mp_rag::{
    export_content_type, export_filename, export_markdown, ingest_doctrine_doc, is_pandoc_available,
    reformat_doctrine_markdown, reindex_doctrine, reindex_sources, should_skip_doctrine_reformat,
    DoctrineStore, DEFAULT_DOCTRINE_TEMPLATE, MAX_DOCTRINE_FILE_BYTES,
};

fn no_rag() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"error":"rag not ready","code":"RAG_ERROR"})),
    )
        .into_response()
}

pub async fn doctrine_list(State(st): State<AppState>, _admin: AdminUser) -> Response {
    let Some(rag) = st.rag.as_ref() else {
        return Json(json!({ "docs": [] })).into_response();
    };
    Json(json!({ "docs": rag.doctrine.list() })).into_response()
}

pub async fn doctrine_hygiene(State(st): State<AppState>, _admin: AdminUser) -> Json<Value> {
    let Some(rag) = st.rag.as_ref() else {
        return Json(json!({
            "docCount": 0,
            "expiredCount": 0,
            "byClassification": {},
            "docs": [],
            "reindex": { "endpoint": "POST /api/rag/doctrine/reindex", "command": "!reindex [source.md]" }
        }));
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let docs = rag.doctrine.list();
    let mut by_classification = serde_json::Map::new();
    let mut expired = 0i64;
    let enriched: Vec<Value> = docs
        .iter()
        .map(|d| {
            let cls = if d.classification.is_empty() {
                "unclassified"
            } else {
                d.classification.as_str()
            };
            let n = by_classification
                .entry(cls.to_string())
                .or_insert(json!(0));
            *n = json!(n.as_i64().unwrap_or(0) + 1);
            let is_expired = mp_rag::is_doctrine_expired(d.valid_until.as_deref(), now_ms);
            if is_expired {
                expired += 1;
            }
            json!({
                "source": d.source,
                "classification": cls,
                "tags": d.tags,
                "chunks": d.chunks,
                "bytes": d.bytes,
                "validUntil": d.valid_until,
                "expired": is_expired,
                "updatedAt": d.updated_at,
            })
        })
        .collect();
    Json(json!({
        "docCount": docs.len(),
        "expiredCount": expired,
        "byClassification": by_classification,
        "docs": enriched,
        "reindex": {
            "endpoint": "POST /api/rag/doctrine/reindex",
            "command": "!reindex [source.md]",
        }
    }))
}

#[derive(Deserialize)]
pub(crate) struct NewBody {
    source: Option<String>,
    content: Option<String>,
}

pub async fn doctrine_new(
    State(st): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<NewBody>,
) -> Response {
    let Some(rag) = st.rag.as_ref() else {
        return no_rag();
    };
    let raw = DoctrineStore::normalize_source(body.source.as_deref().unwrap_or(""));
    let Some(source) = rag.doctrine.safe_name(&raw) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid doctrine source path (must end in .md)","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    };
    if rag.doctrine.read_file(&source).is_some() {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"doctrine already exists","code":"CONFLICT","source": source})),
        )
            .into_response();
    }
    let content = body
        .content
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| DEFAULT_DOCTRINE_TEMPLATE.to_string());
    if content.len() > MAX_DOCTRINE_FILE_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({"error":"content too large (max 15 MiB)","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    match ingest_doctrine_doc(&rag.retrieval, &rag.doctrine, &source, &content).await {
        Ok(ingested) => (
            StatusCode::CREATED,
            Json(json!({ "ok": true, "source": source, "content": content, "ingested": ingested })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error": e.to_string(), "code":"RAG_ERROR"})),
        )
            .into_response(),
    }
}

pub async fn doctrine_get(
    State(st): State<AppState>,
    _admin: AdminUser,
    Path(source): Path<String>,
) -> Response {
    let Some(rag) = st.rag.as_ref() else {
        return no_rag();
    };
    if rag.doctrine.safe_name(&source).is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid doctrine source path","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    let Some(content) = rag.doctrine.read_file(&source) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"doctrine not found","code":"NOT_FOUND"})),
        )
            .into_response();
    };
    Json(json!({
        "source": source,
        "content": content,
        "meta": rag.doctrine.get(&source),
    }))
    .into_response()
}

#[derive(Deserialize)]
pub(crate) struct PutBody {
    content: Option<String>,
}

pub async fn doctrine_put(
    State(st): State<AppState>,
    _admin: AdminUser,
    Path(source): Path<String>,
    Json(body): Json<PutBody>,
) -> Response {
    let Some(rag) = st.rag.as_ref() else {
        return no_rag();
    };
    if rag.doctrine.safe_name(&source).is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid doctrine source path","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    let content = body.content.unwrap_or_default();
    if content.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"content is required","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    if content.len() > MAX_DOCTRINE_FILE_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({"error":"content too large (max 15 MiB)","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    match ingest_doctrine_doc(&rag.retrieval, &rag.doctrine, &source, &content).await {
        Ok(ingested) => Json(json!({ "ok": true, "ingested": ingested })).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error": e.to_string(), "code":"RAG_ERROR"})),
        )
            .into_response(),
    }
}

pub async fn doctrine_delete(
    State(st): State<AppState>,
    _admin: AdminUser,
    Path(source): Path<String>,
) -> Response {
    let Some(rag) = st.rag.as_ref() else {
        return no_rag();
    };
    if rag.doctrine.safe_name(&source).is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid doctrine source path","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    let _ = rag.retrieval.purge(&source).await;
    let removed = rag.doctrine.remove(&source);
    Json(json!({ "ok": removed, "source": source })).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReindexBody {
    sources: Option<Vec<String>>,
    force: Option<bool>,
}

pub async fn doctrine_reindex(
    State(st): State<AppState>,
    _admin: AdminUser,
    body: Option<Json<ReindexBody>>,
) -> Response {
    let Some(rag) = st.rag.as_ref() else {
        return no_rag();
    };
    let body = body.map(|j| j.0).unwrap_or(ReindexBody {
        sources: None,
        force: None,
    });
    let force = body.force.unwrap_or(false);
    let selective = body.sources.as_ref().is_some_and(|s| !s.is_empty());
    let result = if let Some(sources) = body.sources.filter(|s| !s.is_empty()) {
        reindex_sources(&rag.retrieval, &rag.doctrine, sources, force).await
    } else {
        reindex_doctrine(&rag.retrieval, &rag.doctrine).await
    };
    match result {
        Ok(docs) => Json(json!({
            "ok": true,
            "reindexed": docs.len(),
            "docs": docs,
            "selective": selective,
        }))
        .into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error": e.to_string(), "code":"RAG_ERROR"})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueryBody {
    q: Option<String>,
    top_k: Option<usize>,
    allowed_classifications: Option<Vec<String>>,
}

pub async fn rag_query(
    State(st): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<QueryBody>,
) -> Response {
    let Some(rag) = st.rag.as_ref() else {
        return no_rag();
    };
    let q = body.q.unwrap_or_default().trim().to_string();
    if q.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"q is required","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    let allowed = body.allowed_classifications.as_deref();
    match rag.retrieval.query_strict(&q, body.top_k, allowed).await {
        Ok(chunks) => Json(json!({ "q": q, "chunks": chunks })).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error": e.to_string(), "code":"RAG_ERROR"})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
pub(crate) struct EvalBody {
    cases: Option<Vec<mp_rag::EvalCase>>,
}

pub async fn rag_eval(
    State(st): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<EvalBody>,
) -> Response {
    let Some(rag) = st.rag.as_ref() else {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"No bot instance available","code":"NO_BOT"})),
        )
            .into_response();
    };
    let report = rag.run_eval(body.cases).await;
    Json(report).into_response()
}

#[derive(Deserialize)]
pub(crate) struct IngestBody {
    source: Option<String>,
    text: Option<String>,
}

pub async fn rag_ingest(
    State(st): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<IngestBody>,
) -> Response {
    let Some(rag) = st.rag.as_ref() else {
        return no_rag();
    };
    let source = body.source.unwrap_or_default().trim().to_string();
    let text = body.text.unwrap_or_default();
    if source.is_empty() || text.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"source and text are required","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    match rag
        .retrieval
        .ingest(&source, &text, "unclassified", &[], "")
        .await
    {
        Ok(chunks) => Json(json!({ "ok": true, "source": source, "chunks": chunks })).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error": e.to_string(), "code":"RAG_ERROR"})),
        )
            .into_response(),
    }
}

fn is_markdown_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with(".md") || n.ends_with(".markdown")
}

/// POST /api/rag/doctrine — multipart `.md` upload (field `files`, max 20).
pub async fn doctrine_upload(
    State(st): State<AppState>,
    _admin: AdminUser,
    mut multipart: Multipart,
) -> Response {
    let Some(rag) = st.rag.as_ref() else {
        return no_rag();
    };
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    loop {
        match multipart.next_field().await {
            Ok(Some(field)) => {
                let name = field.file_name().unwrap_or("").to_string();
                let data = match field.bytes().await {
                    Ok(b) => b.to_vec(),
                    Err(e) => {
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(json!({"error": e.to_string(), "code":"VALIDATION_ERROR"})),
                        )
                            .into_response();
                    }
                };
                files.push((name, data));
            }
            Ok(None) => break,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error": e.to_string(), "code":"VALIDATION_ERROR"})),
                )
                    .into_response();
            }
        }
        if files.len() > 20 {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"Too many files (max 20 per upload)","code":"VALIDATION_ERROR"})),
            )
                .into_response();
        }
    }
    let files: Vec<(String, Vec<u8>)> = files
        .into_iter()
        .filter(|(n, _)| is_markdown_name(n))
        .collect();
    if files.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"No .md files uploaded","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    let mut ingested = Vec::new();
    let mut failed = Vec::new();
    for (name, data) in files {
        if data.len() > MAX_DOCTRINE_FILE_BYTES {
            failed.push(json!({"name": name, "error": "content too large (max 15 MiB)"}));
            continue;
        }
        let content = String::from_utf8_lossy(&data).into_owned();
        match ingest_doctrine_doc(&rag.retrieval, &rag.doctrine, &name, &content).await {
            Ok(doc) => ingested.push(doc),
            Err(e) => failed.push(json!({"name": name, "error": e.to_string()})),
        }
    }
    Json(json!({
        "ok": !ingested.is_empty(),
        "ingested": ingested,
        "failed": failed,
    }))
    .into_response()
}

#[derive(Deserialize)]
pub(crate) struct ReformatBody {
    sources: Option<Vec<String>>,
}

pub async fn doctrine_reformat(
    State(st): State<AppState>,
    _admin: AdminUser,
    body: Option<Json<ReformatBody>>,
) -> Response {
    let Some(rag) = st.rag.as_ref() else {
        return no_rag();
    };
    let only = body.and_then(|j| j.0.sources).unwrap_or_default();
    let mut candidates: Vec<String> = if only.is_empty() {
        rag.doctrine.files()
    } else {
        only.into_iter()
            .filter_map(|raw| rag.doctrine.safe_name(&raw))
            .collect()
    };
    let mut changed: Vec<String> = Vec::new();
    let mut unchanged: Vec<String> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    for source in candidates.drain(..) {
        if should_skip_doctrine_reformat(&source) {
            skipped.push(json!({"source": source, "reason": "operator cheatsheet"}));
            continue;
        }
        let Some(raw) = rag.doctrine.read_file(&source) else {
            skipped.push(json!({"source": source, "reason": "not found"}));
            continue;
        };
        let Some(next) = reformat_doctrine_markdown(&raw, &source) else {
            unchanged.push(source);
            continue;
        };
        if next.len() > MAX_DOCTRINE_FILE_BYTES {
            skipped.push(json!({"source": source, "reason": "reformatted content too large"}));
            continue;
        }
        if let Err(e) = ingest_doctrine_doc(&rag.retrieval, &rag.doctrine, &source, &next).await {
            skipped.push(json!({"source": source, "reason": e.to_string()}));
            continue;
        }
        changed.push(source);
    }
    Json(json!({
        "ok": true,
        "changed": changed.len(),
        "unchanged": unchanged.len(),
        "skipped": skipped,
        "files": changed,
        "reindexedViaIngest": changed.len(),
        "hint": "Changed files were re-embedded on save. Use Reindex if retrieval still looks stale.",
    }))
    .into_response()
}

pub async fn doctrine_export_caps(_admin: AdminUser) -> Json<Value> {
    let pandoc = is_pandoc_available();
    Json(json!({
        "pandoc": pandoc,
        "formats": if pandoc { json!(["docx", "pdf"]) } else { json!([]) },
    }))
}

#[derive(Deserialize)]
pub(crate) struct ExportQuery {
    format: Option<String>,
}

pub async fn doctrine_export(
    State(st): State<AppState>,
    _admin: AdminUser,
    Path(source): Path<String>,
    Query(q): Query<ExportQuery>,
) -> Response {
    let Some(rag) = st.rag.as_ref() else {
        return no_rag();
    };
    if rag.doctrine.safe_name(&source).is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid doctrine source path","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    let format = match q.format.as_deref() {
        Some("pdf") => "pdf",
        Some("docx") | None => "docx",
        Some(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"format must be docx or pdf","code":"INVALID_FORMAT"})),
            )
                .into_response();
        }
    };
    let Some(content) = rag.doctrine.read_file(&source) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"doctrine not found","code":"NOT_FOUND"})),
        )
            .into_response();
    };
    match export_markdown(&content, format) {
        Ok(bytes) => {
            let filename = export_filename(&source, format);
            let mut res = (
                StatusCode::OK,
                [(header::CONTENT_TYPE, export_content_type(format))],
                bytes,
            )
                .into_response();
            if let Ok(cd) = header::HeaderValue::from_str(&format!(
                "attachment; filename=\"{}\"",
                filename.replace(['"', '\\'], "_")
            )) {
                res.headers_mut().insert(header::CONTENT_DISPOSITION, cd);
            }
            res
        }
        Err(e) => {
            let status = StatusCode::from_u16(e.status()).unwrap_or(StatusCode::BAD_GATEWAY);
            (status, Json(json!({"error": e.to_string(), "code": e.code()}))).into_response()
        }
    }
}
