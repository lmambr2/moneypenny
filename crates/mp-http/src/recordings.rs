// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Dashboard recordings under `data/recordings/`. Opt-in via Settings.

use std::path::{Path, PathBuf};

use axum::extract::{Path as AxumPath, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use std::sync::atomic::Ordering;

use crate::authz::AdminUser;
use crate::AppState;

const ALLOWED_EXT: &[&str] = &["webm", "ogg", "wav", "mp3", "m4a", "opus"];
const MAX_BYTES: usize = 50 * 1024 * 1024;

pub fn safe_recording_basename(name: &str) -> Option<String> {
    let raw = name.trim();
    if raw.is_empty() || raw.contains('/') || raw.contains('\\') || raw.contains("..") {
        return None;
    }
    if raw == "." || raw == ".." {
        return None;
    }
    let base = Path::new(raw)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if base != raw {
        return None;
    }
    let ext = Path::new(base)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ALLOWED_EXT.iter().any(|e| *e == ext) {
        return None;
    }
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '(' | ')' | '+' | ' ') {
                c
            } else {
                '_'
            }
        })
        .take(120)
        .collect();
    if cleaned.is_empty() || cleaned.starts_with('.') {
        None
    } else {
        Some(cleaned)
    }
}

fn recordings_root(data_dir: &Path) -> PathBuf {
    let root = data_dir.join("recordings");
    let _ = std::fs::create_dir_all(&root);
    root
}

fn resolve_path(data_dir: &Path, filename: &str) -> Option<PathBuf> {
    let safe = safe_recording_basename(filename)?;
    let root = recordings_root(data_dir);
    let full = root.join(&safe);
    let root_c = root.canonicalize().unwrap_or(root.clone());
    if full.exists() {
        let full_c = full.canonicalize().ok()?;
        if !full_c.starts_with(&root_c) {
            return None;
        }
        Some(full_c)
    } else if full.starts_with(&root) {
        Some(full)
    } else {
        None
    }
}

pub async fn recordings_list(State(st): State<AppState>, _admin: AdminUser) -> Json<Value> {
    if !st.recordings_enabled.load(Ordering::SeqCst) {
        return Json(json!({ "enabled": false, "recordings": [] }));
    }
    Json(json!({
        "enabled": true,
        "recordings": list_recordings(&st.data_dir),
    }))
}

fn list_recordings(data_dir: &Path) -> Vec<Value> {
    let root = recordings_root(data_dir);
    let Ok(rd) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        let Some(safe) = safe_recording_basename(&name) else {
            continue;
        };
        let Ok(meta) = ent.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let created = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        out.push(json!({
            "id": safe,
            "filename": safe,
            "bytes": meta.len(),
            "createdAt": created,
        }));
    }
    out.sort_by(|a, b| {
        b.get("createdAt")
            .and_then(|v| v.as_i64())
            .cmp(&a.get("createdAt").and_then(|v| v.as_i64()))
    });
    out
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadBody {
    filename: Option<String>,
    data_base64: Option<String>,
    mime: Option<String>,
}

pub async fn recordings_upload(
    State(st): State<AppState>,
    admin: AdminUser,
    Json(body): Json<UploadBody>,
) -> Response {
    if !st.recordings_enabled.load(Ordering::SeqCst) {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"Recordings are disabled (Settings opt-in)","code":"DISABLED"})),
        )
            .into_response();
    }
    let filename = body.filename.unwrap_or_default();
    let b64 = body.data_base64.unwrap_or_default();
    if filename.is_empty() || b64.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"filename and dataBase64 required","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid base64","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    };
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid filename or empty/too-large payload","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    let Some(path) = resolve_path(&st.data_dir, &filename) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid filename or empty/too-large payload","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    };
    if let Err(e) = std::fs::write(&path, &bytes) {
        tracing::error!(error = %e, "recording write");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":"write failed"})),
        )
            .into_response();
    }
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        .to_string();
    let meta = json!({
        "id": name,
        "filename": name,
        "bytes": bytes.len(),
        "createdAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
        "mime": body.mime,
    });
    st.db.audit().record(
        Some(&admin.0.id),
        Some(&admin.0.username),
        None,
        Some(&name),
        "recording.upload",
    );
    (StatusCode::CREATED, Json(json!({ "ok": true, "recording": meta }))).into_response()
}

pub async fn recordings_get(
    State(st): State<AppState>,
    _admin: AdminUser,
    AxumPath(name): AxumPath<String>,
) -> Response {
    if !st.recordings_enabled.load(Ordering::SeqCst) {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"Recordings disabled","code":"DISABLED"})),
        )
            .into_response();
    }
    let Some(safe) = safe_recording_basename(&name) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"not found","code":"NOT_FOUND"})),
        )
            .into_response();
    };
    let Some(path) = resolve_path(&st.data_dir, &safe) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"not found","code":"NOT_FOUND"})),
        )
            .into_response();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"not found","code":"NOT_FOUND"})),
        )
            .into_response();
    };
    let mut res = (StatusCode::OK, bytes).into_response();
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/octet-stream"),
    );
    if let Ok(cd) = header::HeaderValue::from_str(&format!(
        "attachment; filename=\"{}\"",
        safe.replace(['"', '\\'], "_")
    )) {
        res.headers_mut().insert(header::CONTENT_DISPOSITION, cd);
    }
    res
}

pub async fn recordings_delete(
    State(st): State<AppState>,
    admin: AdminUser,
    AxumPath(name): AxumPath<String>,
) -> Response {
    if !st.recordings_enabled.load(Ordering::SeqCst) {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"Recordings disabled","code":"DISABLED"})),
        )
            .into_response();
    }
    let ok = resolve_path(&st.data_dir, &name)
        .and_then(|p| std::fs::remove_file(p).ok().map(|_| true))
        .unwrap_or(false);
    if ok {
        st.db.audit().record(
            Some(&admin.0.id),
            Some(&admin.0.username),
            None,
            Some(&name),
            "recording.delete",
        );
    }
    Json(json!({ "ok": ok })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal() {
        assert!(safe_recording_basename("../x.webm").is_none());
        assert!(safe_recording_basename("take-1.webm").is_some());
        assert!(safe_recording_basename("take-1.exe").is_none());
    }
}
