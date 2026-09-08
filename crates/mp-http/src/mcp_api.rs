// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Bearer MCP REST surface. Not the Node SDK streamable-HTTP transport.
//! GET /mcp/tools + POST /mcp/tools/call. Confirm-for-high-impact.
//! Mounted outside CSRF (Bearer, not cookie).

use std::time::Instant;

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::bot_api::{bot_status_json, queue_json};
use crate::command::dispatch_command;
use crate::AppState;
use mp_control::{parse_command, ParsedCommand};
use mp_mcp::{
    check_confirm, err_envelope, extract_bearer, ok_envelope, token_eq, McpConfig, McpEnvelope,
    McpProfile,
};
use mp_rights::{Scope, Subject};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/mcp", get(mcp_root).post(mcp_jsonrpc))
        .route("/mcp/tools", get(list_tools))
        .route("/mcp/tools/call", post(call_tool))
}

fn mcp_unauth() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({"error":"unauthorized","code":"UNAUTHORIZED"})),
    )
        .into_response()
}

fn mcp_disabled() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error":"MCP disabled","code":"MCP_DISABLED"})),
    )
        .into_response()
}

fn authenticate(st: &AppState, auth: Option<&str>) -> Result<(), Response> {
    if !st.mcp.enabled {
        return Err(mcp_disabled());
    }
    let Some(token) = extract_bearer(auth) else {
        return Err(mcp_unauth());
    };
    if !token_eq(&token, &st.mcp.token) {
        return Err(mcp_unauth());
    }
    Ok(())
}

async fn mcp_jsonrpc(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !st.mcp.enabled {
        return mcp_disabled();
    }
    let auth = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok());
    let token_ok = extract_bearer(auth)
        .as_deref()
        .is_some_and(|t| token_eq(t, &st.mcp.token));
    if !token_ok {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "jsonrpc": "2.0",
                "error": { "code": -32001, "message": "Unauthorized: invalid or missing Bearer token" },
                "id": null
            })),
        )
            .into_response();
    }
    let method = body.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let id = body.get("id").cloned();
    let params = body.get("params").cloned().unwrap_or_else(|| json!({}));
    if id.is_none() {
        // JSON-RPC notification (no response body).
        return StatusCode::ACCEPTED.into_response();
    }
    let result = match method {
        "initialize" => json!({
            "protocolVersion": "2025-03-26",
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "moneypenny", "version": "0.1.0" },
            "instructions": "Structured music/status tools. High-impact tools need confirm:true."
        }),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": jsonrpc_tool_list(&st) }),
        "tools/call" => {
            return jsonrpc_tools_call(&st, &params, id, &headers).await;
        }
        _ => {
            return jsonrpc_error(
                id,
                -32601,
                format!("Method not found: {method}"),
                wants_sse(&headers),
            );
        }
    };
    jsonrpc_ok(id, result, wants_sse(&headers))
}

fn wants_sse(headers: &axum::http::HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_ascii_lowercase().contains("text/event-stream"))
        .unwrap_or(false)
}

fn jsonrpc_ok(id: Option<Value>, result: Value, sse: bool) -> Response {
    let body = json!({ "jsonrpc": "2.0", "id": id, "result": result });
    jsonrpc_body(body, sse)
}

fn jsonrpc_error(id: Option<Value>, code: i64, message: String, sse: bool) -> Response {
    let body = json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    });
    jsonrpc_body(body, sse)
}

fn jsonrpc_body(body: Value, sse: bool) -> Response {
    let raw = serde_json::to_string(&body).unwrap_or_else(|_| "{}".into());
    if sse {
        let payload = format!("event: message\ndata: {raw}\n\n");
        (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/event-stream"),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            payload,
        )
            .into_response()
    } else {
        (StatusCode::OK, Json(body)).into_response()
    }
}

fn jsonrpc_tool_list(st: &AppState) -> Vec<Value> {
    st.mcp
        .tool_names()
        .into_iter()
        .map(|n| {
            json!({
                "name": n,
                "description": tool_desc(n),
                "inputSchema": jsonrpc_input_schema(n),
            })
        })
        .collect()
}

fn jsonrpc_input_schema(name: &str) -> Value {
    match name {
        "music_play" | "music_add" | "music_play_next" => json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "platform": { "type": "string", "enum": ["local", "youtube", "stream"] },
                "bot_id": { "type": "string" },
                "dry_run": { "type": "boolean" }
            },
            "required": ["query"]
        }),
        "music_skip" | "music_pause" | "music_resume" | "music_stop" | "music_clear" => json!({
            "type": "object",
            "properties": { "bot_id": { "type": "string" }, "confirm": { "type": "boolean" } }
        }),
        _ => json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "bot_id": { "type": "string" },
                "confirm": { "type": "boolean" }
            },
            "additionalProperties": true
        }),
    }
}

async fn jsonrpc_tools_call(
    st: &AppState,
    params: &Value,
    id: Option<Value>,
    headers: &axum::http::HeaderMap,
) -> Response {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if name.is_empty() {
        return jsonrpc_error(id, -32602, "name is required".into(), wants_sse(headers));
    }
    if !st.mcp.tool_names().iter().any(|n| *n == name) {
        return jsonrpc_error(
            id,
            -32602,
            format!("Unknown tool '{name}'"),
            wants_sse(headers),
        );
    }
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let args = if args.is_object() { args } else { json!({}) };
    let started = Instant::now();
    let request_id = format!(
        "mcp-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let confirm = args.get("confirm").and_then(|v| v.as_bool()).unwrap_or(false);
    let bot_id = args
        .get("bot_id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| st.mcp.bot_id.clone())
        .or_else(|| Some(st.bot_id.clone()));
    if let Some(blocked) = check_confirm(&st.mcp, name, confirm, bot_id.clone(), started, &request_id)
    {
        record_mcp_audit(st, name, &blocked);
        let text = serde_json::to_string(&blocked).unwrap_or_else(|_| blocked.message.clone());
        return jsonrpc_ok(
            id,
            json!({
                "content": [{ "type": "text", "text": text }],
                "isError": true
            }),
            wants_sse(headers),
        );
    }
    let env = dispatch_mcp(st, name, &args, bot_id, started, &request_id).await;
    record_mcp_audit(st, name, &env);
    let text = if env.message.is_empty() {
        env.code.clone()
    } else {
        env.message.clone()
    };
    jsonrpc_ok(
        id,
        json!({
            "content": [{ "type": "text", "text": text }],
            "isError": !env.ok
        }),
        wants_sse(headers),
    )
}

async fn mcp_root(State(st): State<AppState>) -> Response {
    if !st.mcp.enabled {
        return mcp_disabled();
    }
    Json(json!({
        "ok": true,
        "name": "moneypenny",
        "version": "0.1.0",
        "transport": "rest",
        "tools": "/mcp/tools",
        "call": "/mcp/tools/call",
    }))
    .into_response()
}

async fn list_tools(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Response {
    let auth = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok());
    if let Err(r) = authenticate(&st, auth) {
        return r;
    }
    let names = st.mcp.tool_names();
    Json(json!({
        "tools": names.iter().map(|n| json!({"name": n, "description": tool_desc(n)})).collect::<Vec<_>>(),
        "profile": st.mcp.default_profile.as_str(),
        "requireConfirm": st.mcp.require_confirm,
        "highImpact": mp_mcp::HIGH_IMPACT_TOOLS,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct CallBody {
    name: String,
    #[serde(default)]
    arguments: Value,
}

async fn call_tool(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<CallBody>,
) -> Response {
    let auth = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok());
    if let Err(r) = authenticate(&st, auth) {
        return r;
    }
    let started = Instant::now();
    let request_id = format!(
        "mcp-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let name = body.name.trim();
    if name.is_empty() {
        return Json(err_envelope(
            "VALIDATION_ERROR",
            "name is required",
            None,
            started,
            &request_id,
        ))
        .into_response();
    }
    if !st.mcp.tool_names().iter().any(|n| *n == name) {
        return Json(err_envelope(
            "UNKNOWN_TOOL",
            format!("Unknown tool '{name}'"),
            None,
            started,
            &request_id,
        ))
        .into_response();
    }
    let args = if body.arguments.is_object() {
        body.arguments
    } else {
        json!({})
    };
    let confirm = args.get("confirm").and_then(|v| v.as_bool()).unwrap_or(false);
    let bot_id = args
        .get("bot_id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| st.mcp.bot_id.clone())
        .or_else(|| Some(st.bot_id.clone()));
    if let Some(blocked) = check_confirm(
        &st.mcp,
        name,
        confirm,
        bot_id.clone(),
        started,
        &request_id,
    ) {
        record_mcp_audit(&st, name, &blocked);
        return Json(blocked).into_response();
    }
    let env = dispatch_mcp(&st, name, &args, bot_id, started, &request_id).await;
    record_mcp_audit(&st, name, &env);
    Json(env).into_response()
}

fn record_mcp_audit(st: &AppState, tool_name: &str, env: &McpEnvelope<Value>) {
    let action = if !env.ok && env.code == "PERMISSION_DENIED" {
        "mcp.tool.denied"
    } else if env.ok {
        "mcp.tool"
    } else {
        "mcp.tool.error"
    };
    let actor = format!(
        "{}|{}|mcp",
        st.mcp.invoker_name,
        st.mcp.default_profile.as_str()
    );
    st.db.audit().record(
        Some(&st.mcp.invoker_uid),
        Some(&actor),
        env.meta.bot_id.as_deref(),
        Some(tool_name),
        action,
    );
}

fn str_arg(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn bool_arg(args: &Value, key: &str) -> bool {
    args.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn profile_ok(st: &AppState, required: McpProfile) -> bool {
    st.mcp.default_profile.allows(required)
}

fn mcp_subject(st: &AppState) -> Subject {
    Subject {
        uid: st.mcp.invoker_uid.clone(),
        server_groups: Vec::new(),
        nickname: Some(st.mcp.invoker_name.clone()),
    }
}

fn parsed(name: &str, args: &str) -> ParsedCommand {
    ParsedCommand {
        name: name.to_string(),
        args: args.to_string(),
        raw_args: if args.is_empty() {
            vec![]
        } else {
            args.split_whitespace().map(str::to_string).collect()
        },
        flags: Default::default(),
    }
}

async fn run_cmd(
    st: &AppState,
    name: &str,
    args: &str,
    required: McpProfile,
    started: Instant,
    request_id: &str,
    bot_id: Option<String>,
) -> McpEnvelope<Value> {
    if !profile_ok(st, required) {
        return err_envelope(
            "PERMISSION_DENIED",
            format!(
                "Profile '{}' cannot run '{name}' (needs {}+)",
                st.mcp.default_profile.as_str(),
                required.as_str()
            ),
            bot_id,
            started,
            request_id,
        );
    }
    let Some(ex) = st.executor.as_ref() else {
        return err_envelope(
            "UNAVAILABLE",
            "music station not ready",
            bot_id,
            started,
            request_id,
        );
    };
    let cmd = if let Some(p) = parse_command(
        &format!(
            "{}{name}{}",
            ex.prefix,
            if args.is_empty() {
                String::new()
            } else {
                format!(" {args}")
            }
        ),
        &ex.prefix,
        &Default::default(),
    ) {
        p
    } else {
        parsed(name, args)
    };
    let subject = mcp_subject(st);
    // Node `asWebUser`: dj/admin MCP profiles map to web admin and skip rank gates.
    // Profile was already checked above. Readonly still hits RightsEngine.
    let rights = match st.mcp.default_profile {
        McpProfile::Readonly => st.rights.as_deref(),
        McpProfile::Dj | McpProfile::Admin => None,
    };
    let msg = dispatch_command(
        &cmd,
        &subject,
        Scope::Chat,
        ex,
        rights,
        &st.db,
        &st.brain,
        st.rag.as_deref(),
        Some(&st.radio),
        Some(&st.roast),
    )
    .await
    .unwrap_or_default();
    if msg.contains("don't have permission") {
        return err_envelope("PERMISSION_DENIED", msg, bot_id, started, request_id);
    }
    ok_envelope(
        msg.clone(),
        Some(json!({ "command": name, "message": msg })),
        bot_id,
        started,
        request_id,
    )
}

async fn dispatch_mcp(
    st: &AppState,
    name: &str,
    args: &Value,
    bot_id: Option<String>,
    started: Instant,
    request_id: &str,
) -> McpEnvelope<Value> {
    let dry = bool_arg(args, "dry_run") || bool_arg(args, "dryRun");
    match name {
        "status_health" => {
            let stj = bot_status_json(st);
            ok_envelope(
                "ok",
                Some(json!({
                    "status": "ok",
                    "version": "0.1.0",
                    "mcp": { "enabled": true, "profile": st.mcp.default_profile.as_str() },
                    "bots": [{
                        "id": stj["id"],
                        "name": stj["name"],
                        "connected": stj["connected"],
                        "playing": stj["playing"],
                        "paused": stj["paused"],
                        "queueSize": stj["queueSize"],
                    }],
                })),
                bot_id,
                started,
                request_id,
            )
        }
        "status_now_playing" => {
            let stj = bot_status_json(st);
            let song = &stj["currentSong"];
            let msg = if song.is_null() {
                "Nothing playing".into()
            } else {
                format!("Now playing: {}", song["name"].as_str().unwrap_or(""))
            };
            ok_envelope(
                msg,
                Some(json!({
                    "connected": stj["connected"],
                    "playing": stj["playing"],
                    "paused": stj["paused"],
                    "volume": stj["volume"],
                    "playMode": stj["playMode"],
                    "elapsed": stj["elapsed"],
                    "queueSize": stj["queueSize"],
                    "current": if song.is_null() { json!(null) } else {
                        json!({
                            "id": song["id"],
                            "title": song["name"],
                            "artist": song["artist"],
                            "platform": song["platform"],
                            "url": song["url"],
                        })
                    },
                })),
                bot_id,
                started,
                request_id,
            )
        }
        "status_queue" => {
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(30)
                .clamp(1, 100) as usize;
            let items = queue_json(st);
            let size = items.len();
            let clipped: Vec<Value> = items.into_iter().take(limit).enumerate().map(|(i, s)| {
                json!({
                    "index": i,
                    "id": s["id"],
                    "title": s["name"],
                    "artist": s["artist"],
                    "platform": s["platform"],
                })
            }).collect();
            ok_envelope(
                format!("Queue size {size}"),
                Some(json!({
                    "size": size,
                    "mode": bot_status_json(st)["playMode"],
                    "items": clipped,
                })),
                bot_id,
                started,
                request_id,
            )
        }
        "status_radio" => ok_envelope(
            "ok",
            Some(json!({ "radio": {
                "enabled": st.radio.enabled(),
                "activeProfile": st.radio.config().active_profile,
                "everyNSongs": st.radio.status().every_n_songs,
                "songsUntilBumper": st.radio.status().songs_until_bumper,
            }})),
            bot_id,
            started,
            request_id,
        ),
        "status_rag" => {
            let enabled = st.rag.as_ref().is_some_and(|r| r.rag_enabled());
            ok_envelope(
                "ok",
                Some(json!({
                    "configured": enabled,
                    "available": enabled,
                    "vectorDbUrl": st.config.vector_db_url,
                    "embeddingModel": st.config.embedding_model,
                })),
                bot_id,
                started,
                request_id,
            )
        }
        "music_play" | "music_add" | "music_play_next" => {
            let query = str_arg(args, "query");
            if query.is_empty() {
                return err_envelope("VALIDATION_ERROR", "query is required", bot_id, started, request_id);
            }
            let verb = match name {
                "music_add" => "add",
                "music_play_next" => "playnext",
                _ => "play",
            };
            let platform = str_arg(args, "platform");
            let flag = match platform.as_str() {
                "youtube" => "-y ",
                "stream" => "-s ",
                "local" => "-l ",
                "" => "",
                _ => "",
            };
            if dry {
                return ok_envelope(
                    format!("[dry-run] would {verb}: {query}"),
                    Some(json!({
                        "dry_run": true,
                        "verb": verb,
                        "query": query,
                        "platform": if platform.is_empty() { Value::Null } else { json!(platform) },
                    })),
                    bot_id,
                    started,
                    request_id,
                );
            }
            let cmd_args = format!("{flag}{query}");
            run_cmd(st, verb, &cmd_args, McpProfile::Dj, started, request_id, bot_id).await
        }
        "music_skip" => run_cmd(st, "skip", "", McpProfile::Dj, started, request_id, bot_id).await,
        "music_pause" => run_cmd(st, "pause", "", McpProfile::Dj, started, request_id, bot_id).await,
        "music_resume" => run_cmd(st, "resume", "", McpProfile::Dj, started, request_id, bot_id).await,
        "music_ban" => {
            run_cmd(st, "ban", &str_arg(args, "query"), McpProfile::Dj, started, request_id, bot_id).await
        }
        "music_unban" => {
            let q = str_arg(args, "query");
            if q.is_empty() {
                return err_envelope(
                    "VALIDATION_ERROR",
                    "query is required for unban",
                    bot_id,
                    started,
                    request_id,
                );
            }
            run_cmd(st, "unban", &q, McpProfile::Dj, started, request_id, bot_id).await
        }
        "music_stop" => run_cmd(st, "stop", "", McpProfile::Admin, started, request_id, bot_id).await,
        "music_clear" => run_cmd(st, "clear", "", McpProfile::Admin, started, request_id, bot_id).await,
        "music_volume" => {
            let Some(vol) = args.get("volume").and_then(|v| v.as_f64()) else {
                return err_envelope(
                    "VALIDATION_ERROR",
                    "volume must be a number between 0 and 100",
                    bot_id,
                    started,
                    request_id,
                );
            };
            if !(0.0..=100.0).contains(&vol) {
                return err_envelope(
                    "VALIDATION_ERROR",
                    "volume must be a number between 0 and 100",
                    bot_id,
                    started,
                    request_id,
                );
            }
            run_cmd(
                st,
                "vol",
                &format!("{}", vol.round() as i64),
                McpProfile::Admin,
                started,
                request_id,
                bot_id,
            )
            .await
        }
        "music_mode" => {
            let mode = str_arg(args, "mode");
            if !matches!(mode.as_str(), "seq" | "loop" | "random" | "rloop") {
                return err_envelope(
                    "VALIDATION_ERROR",
                    "mode must be one of: seq, loop, random, rloop",
                    bot_id,
                    started,
                    request_id,
                );
            }
            run_cmd(st, "mode", &mode, McpProfile::Admin, started, request_id, bot_id).await
        }
        "music_history" => {
            if !profile_ok(st, McpProfile::Readonly) {
                return err_envelope(
                    "PERMISSION_DENIED",
                    "music_history requires readonly+ profile",
                    bot_id,
                    started,
                    request_id,
                );
            }
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(50)
                .clamp(1, 200) as u32;
            let rows = st
                .db
                .play_history()
                .list(&st.bot_id, limit)
                .unwrap_or_default();
            let history: Vec<Value> = rows
                .iter()
                .map(|r| {
                    json!({
                        "id": r.song_id,
                        "name": r.song_name,
                        "artist": r.artist,
                        "album": r.album,
                        "platform": r.platform,
                        "playedAt": r.played_at,
                        "coverUrl": r.cover_url,
                    })
                })
                .collect();
            ok_envelope(
                format!("{} history item(s)", history.len()),
                Some(json!({ "history": history })),
                bot_id,
                started,
                request_id,
            )
        }
        "radio_set" => {
            let sub = str_arg(args, "args");
            if dry {
                return ok_envelope(
                    format!("[dry-run] would radio {}", if sub.is_empty() { "(status)" } else { &sub }),
                    Some(json!({ "dry_run": true, "args": sub })),
                    bot_id,
                    started,
                    request_id,
                );
            }
            run_cmd(st, "radio", &sub, McpProfile::Admin, started, request_id, bot_id).await
        }
        "doctrine_list" => {
            if !profile_ok(st, McpProfile::Dj) {
                return err_envelope(
                    "PERMISSION_DENIED",
                    "doctrine_list requires dj+ profile",
                    bot_id,
                    started,
                    request_id,
                );
            }
            let docs = st
                .rag
                .as_ref()
                .map(|r| r.doctrine.list())
                .unwrap_or_default();
            ok_envelope(
                format!("{} doctrine doc(s)", docs.len()),
                Some(json!({ "docs": docs })),
                bot_id,
                started,
                request_id,
            )
        }
        "doctrine_reindex" => {
            let sources: Vec<String> = args
                .get("sources")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .filter(|s| !s.trim().is_empty())
                        .collect()
                })
                .unwrap_or_default();
            let one = str_arg(args, "source");
            let joined = if sources.is_empty() { one } else { sources.join(" ") };
            if dry {
                return ok_envelope(
                    format!(
                        "[dry-run] would reindex {}",
                        if joined.is_empty() { "all".into() } else { joined.clone() }
                    ),
                    Some(json!({ "dry_run": true, "sources": joined })),
                    bot_id,
                    started,
                    request_id,
                );
            }
            run_cmd(st, "reindex", &joined, McpProfile::Admin, started, request_id, bot_id).await
        }
        "doctrine_ingest_status" => {
            run_cmd(st, "ingeststatus", "", McpProfile::Admin, started, request_id, bot_id).await
        }
        "memory_remember" => {
            let fact = str_arg(args, "fact");
            let fact = if fact.is_empty() { str_arg(args, "text") } else { fact };
            if fact.is_empty() {
                return err_envelope("VALIDATION_ERROR", "fact is required", bot_id, started, request_id);
            }
            run_cmd(st, "remember", &fact, McpProfile::Dj, started, request_id, bot_id).await
        }
        "memory_recall" => {
            run_cmd(st, "recall", "", McpProfile::Dj, started, request_id, bot_id).await
        }
        "memory_forget" => {
            let which = str_arg(args, "which");
            if which.is_empty() {
                return err_envelope(
                    "VALIDATION_ERROR",
                    "which is required (index or 'all')",
                    bot_id,
                    started,
                    request_id,
                );
            }
            run_cmd(st, "forget", &which, McpProfile::Dj, started, request_id, bot_id).await
        }
        "rag_search" => {
            let q = str_arg(args, "q");
            if q.is_empty() {
                return err_envelope("VALIDATION_ERROR", "q is required", bot_id, started, request_id);
            }
            let Some(rag) = st.rag.as_ref() else {
                return err_envelope("RAG_ERROR", "RAG is not configured", bot_id, started, request_id);
            };
            let top_k = args
                .get("top_k")
                .and_then(|v| v.as_u64())
                .unwrap_or(rag.top_k() as u64)
                .clamp(1, 20) as usize;
            let chunks = rag.retrieval.query(&q, Some(top_k), None).await;
            let chunks_json: Vec<Value> = chunks
                .iter()
                .map(|c| {
                    json!({
                        "text": c.text,
                        "source": c.source,
                        "score": c.score,
                        "classification": c.classification,
                    })
                })
                .collect();
            ok_envelope(
                format!("{} chunk(s)", chunks_json.len()),
                Some(json!({ "chunks": chunks_json })),
                bot_id,
                started,
                request_id,
            )
        }
        "rag_ask" | "harness_turn" => {
            let q = str_arg(args, "question");
            let q = if q.is_empty() { str_arg(args, "q") } else { q };
            if q.is_empty() {
                return err_envelope(
                    "VALIDATION_ERROR",
                    "question is required",
                    bot_id,
                    started,
                    request_id,
                );
            }
            run_cmd(st, "ask", &q, McpProfile::Dj, started, request_id, bot_id).await
        }
        "harness_turns" => ok_envelope(
            "ok",
            Some(json!({ "turns": [] })),
            bot_id,
            started,
            request_id,
        ),
        "econ_run" => {
            let cmd = str_arg(args, "command");
            let rest = str_arg(args, "args");
            if !matches!(cmd.as_str(), "mine" | "refine" | "craft" | "econ" | "trade") {
                return err_envelope(
                    "VALIDATION_ERROR",
                    "command must be mine|refine|craft|econ|trade",
                    bot_id,
                    started,
                    request_id,
                );
            }
            if dry {
                return ok_envelope(
                    format!("[dry-run] would !{cmd} {rest}"),
                    Some(json!({ "dry_run": true, "command": cmd, "args": rest })),
                    bot_id,
                    started,
                    request_id,
                );
            }
            run_cmd(st, &cmd, &rest, McpProfile::Readonly, started, request_id, bot_id).await
        }
        "workorder_run" => {
            let rest = str_arg(args, "args");
            if dry {
                return ok_envelope(
                    format!("[dry-run] would !workorder {rest}"),
                    Some(json!({ "dry_run": true, "args": rest })),
                    bot_id,
                    started,
                    request_id,
                );
            }
            run_cmd(st, "workorder", &rest, McpProfile::Dj, started, request_id, bot_id).await
        }
        "work_items" => {
            run_cmd(st, "work-items", "", McpProfile::Readonly, started, request_id, bot_id).await
        }
        "generate_music" => err_envelope(
            "UNAVAILABLE",
            "ACE-Step music generation is not ported on the Rust bot.",
            bot_id,
            started,
            request_id,
        ),
        "mod_mute" | "mod_kick" => {
            run_cmd(
                st,
                if name == "mod_mute" { "mute" } else { "kick" },
                &str_arg(args, "target"),
                McpProfile::Admin,
                started,
                request_id,
                bot_id,
            )
            .await
        }
        other => err_envelope(
            "UNKNOWN_TOOL",
            format!("Unknown tool '{other}'"),
            bot_id,
            started,
            request_id,
        ),
    }
}

fn tool_desc(name: &str) -> &'static str {
    match name {
        "status_health" => "Health of the Moneypenny bot host and connected bot instances.",
        "status_now_playing" => "Current track, playback state, volume, and queue size.",
        "status_queue" => "List upcoming tracks in the music queue.",
        "status_radio" => "Autonomous radio / auto-DJ director status.",
        "status_rag" => "Doctrine knowledge base / RAG substrate status.",
        "music_play" => "Play a track or URL on the TeamSpeak music bot.",
        "music_add" => "Add a track to the queue without interrupting.",
        "music_play_next" => "Queue a track to play immediately after the current song.",
        "music_skip" => "Skip to the next track in the queue.",
        "music_pause" => "Pause playback.",
        "music_resume" => "Resume paused playback.",
        "music_ban" => "Ban a track from search/auto-DJ. High-impact: confirm:true.",
        "music_unban" => "Remove a track from the playback ban list.",
        "music_stop" => "Stop playback (admin). High-impact: confirm:true.",
        "music_clear" => "Clear the queue and stop (admin). High-impact: confirm:true.",
        "music_volume" => "Set playback volume 0–100 (admin).",
        "music_mode" => "Set queue play mode: seq | loop | random | rloop (admin).",
        "music_history" => "Recent play history for the bot.",
        "radio_set" => "Radio / auto-DJ control (same as !radio <args>).",
        "doctrine_list" => "List doctrine documents in the knowledge base registry.",
        "doctrine_reindex" => "Re-embed doctrine into the vector store.",
        "doctrine_ingest_status" => "File-drop / doctrine ingest status.",
        "memory_remember" => "Store a private !remember fact for the MCP invoker.",
        "memory_recall" => "List private !remember facts for the MCP invoker.",
        "memory_forget" => "Forget a private fact by recall index or 'all'.",
        "rag_search" => "Semantic search over doctrine (chunks only).",
        "rag_ask" => "Ask a question grounded in org doctrine.",
        "harness_turn" => "Admin harness cockpit turn (ask path on Rust).",
        "harness_turns" => "List recent harness cockpit turns.",
        "econ_run" => "Org economy command (mine/refine/craft/econ/trade).",
        "workorder_run" => "Work-order shopping list (!workorder <args>).",
        "work_items" => "List aggregated work-order materials.",
        "generate_music" => "ACE-Step music generation (not ported).",
        "mod_mute" => "Mute a client (MCP_ENABLE_MODERATION=1). High-impact.",
        "mod_kick" => "Kick a client (MCP_ENABLE_MODERATION=1). High-impact.",
        _ => "",
    }
}

#[allow(dead_code)]
pub fn _touch_config(c: &McpConfig) -> bool {
    c.enabled
}
