// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Push-to-talk. The phone uploads 16 kHz mono PCM. Whisper and Piper stay
//! on localhost. The reply is the first spoken sentence. The same flight lock
//! and turn map as typed chat apply. One 20 s timeout covers transcription
//! and the model call. Dispose and speech run in a spawned task.

use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use serde_json::{Value, json};
use tokio::sync::{OwnedMutexGuard, oneshot};
use tracing::Instrument;

use crate::AppState;
use crate::handset_auth::HandsetUser;
use crate::handset_turn::{dispose_proposals, handset_tools};

const TURN_ID_MAX: usize = 64;
const PCM_MIN: usize = 3200;
const SPEAK_MAX: usize = 400;

pub(crate) async fn utterance(
    State(st): State<AppState>,
    user: HandsetUser,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let span = tracing::info_span!("handset.utterance", device_id = %user.id);
    async move { handle(st, user, headers, body).await }
        .instrument(span)
        .await
}

async fn handle(st: AppState, user: HandsetUser, headers: HeaderMap, body: Bytes) -> Response {
    if !is_octet_stream(headers.get(header::CONTENT_TYPE)) {
        return coded(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported media type",
            "UNSUPPORTED_MEDIA",
        );
    }
    let Some(client_turn_id) = header_text(&headers, "x-client-turn-id") else {
        return coded(
            StatusCode::BAD_REQUEST,
            "clientTurnId is required",
            "CLIENT_TURN_ID",
        );
    };
    if client_turn_id.trim().is_empty() || client_turn_id.chars().count() > TURN_ID_MAX {
        return coded(
            StatusCode::BAD_REQUEST,
            "clientTurnId is required",
            "CLIENT_TURN_ID",
        );
    }
    if header_text(&headers, "x-sample-rate").and_then(|v| v.parse::<u32>().ok()) != Some(16_000) {
        return coded(
            StatusCode::BAD_REQUEST,
            "sample rate must be 16000",
            "BAD_SAMPLE_RATE",
        );
    }
    if header_text(&headers, "x-channels").and_then(|v| v.parse::<u32>().ok()) != Some(1) {
        return coded(
            StatusCode::BAD_REQUEST,
            "channels must be 1",
            "BAD_CHANNELS",
        );
    }
    if body.len() < PCM_MIN {
        return coded(
            StatusCode::BAD_REQUEST,
            "audio too short",
            "AUDIO_TOO_SHORT",
        );
    }
    if body.len() > 960_000 {
        return coded(
            StatusCode::PAYLOAD_TOO_LARGE,
            "audio too long",
            "AUDIO_TOO_LONG",
        );
    }

    let Ok(guard) = Arc::clone(&st.handset_flight).try_lock_owned() else {
        return coded(StatusCode::CONFLICT, "handset busy", "BUSY");
    };
    if let Some((status, stored)) = st.handset_turns.lookup(&user.id, &client_turn_id) {
        drop(guard);
        return stored_response(status, stored);
    }

    let tools = handset_tools();
    let prompt = mp_brain::handset_intent_prompt(&st.read_config().llm_system_prompt);
    let utterance = mp_voice::Utterance {
        speaker_client_id: 0,
        speaker_uid: None,
        pcm: body.to_vec(),
        sample_rate: 16_000,
        channels: 1,
        duration_ms: body.len() as f64 / 32.0,
    };
    let stt_url = st.read_config().voice.stt_url.clone();
    let heard = {
        let stt = mp_voice::HttpSttClient::new(&stt_url);
        let brain = Arc::clone(&st.brain);
        let turn_id = client_turn_id.clone();
        let device_id = user.id.clone();
        let work = async move {
            let transcript = match stt.transcribe_result(&utterance).await {
                Ok(text) => text,
                Err(err) => return Err(err),
            };
            if transcript.is_empty() {
                return Ok(Heard::Silence);
            }
            if !brain.transport_is_in_process().await {
                return Ok(Heard::Remote);
            }
            let req = mp_brain::TurnRequest {
                client_turn_id: Some(turn_id),
                channel: mp_brain::TurnChannel::Voice,
                text: transcript.clone(),
                conversation_id: Some(format!("handset:{device_id}")),
                subject: None,
                mode: Some(mp_brain::TurnMode::Intent),
                options: Some(mp_brain::TurnOptions {
                    include_sources: Some(false),
                    max_tools: Some(2),
                }),
                skill: None,
            };
            let res = brain.complete_with_tools(req, &tools, &prompt).await;
            Ok(Heard::Ready { transcript, res })
        };
        match tokio::time::timeout(st.handset_deadline, work).await {
            Ok(heard) => heard,
            Err(_) => {
                drop(guard);
                tracing::info!("handset_deadline");
                return (
                    StatusCode::GATEWAY_TIMEOUT,
                    Json(json!({
                        "error": "handset deadline",
                        "code": "DEADLINE",
                        "disposed": false,
                    })),
                )
                    .into_response();
            }
        }
    };
    let heard = match heard {
        Ok(heard) => heard,
        Err(err) => {
            drop(guard);
            tracing::warn!(error = %err, "handset stt failed");
            return coded(
                StatusCode::SERVICE_UNAVAILABLE,
                "stt unavailable",
                "VOICE_UNAVAILABLE",
            );
        }
    };

    match heard {
        Heard::Silence => {
            let body = silence_body(&client_turn_id);
            st.handset_turns
                .insert(&user.id, &client_turn_id, 200, body.clone());
            drop(guard);
            tracing::info!(
                transcript_len = 0,
                status = 200u16,
                "handset utterance silence"
            );
            stored_response(200, body)
        }
        Heard::Remote => {
            drop(guard);
            coded(
                StatusCode::SERVICE_UNAVAILABLE,
                "brain is remote",
                "BRAIN_REMOTE",
            )
        }
        Heard::Ready { transcript, res } => {
            if let Some(err) = res.error.clone() {
                drop(guard);
                if err == "LLM is not enabled" {
                    return coded(StatusCode::CONFLICT, "LLM is not enabled", "LLM_DISABLED");
                }
                if err == "BRAIN_REMOTE" {
                    return coded(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "brain is remote",
                        "BRAIN_REMOTE",
                    );
                }
                tracing::warn!(error = %err, "handset intent failed");
                return coded(StatusCode::BAD_GATEWAY, "intent failed", "INTENT_FAILED");
            }
            if !res.tool_proposals.is_empty() && st.executor.is_none() {
                drop(guard);
                return coded(StatusCode::CONFLICT, "No bot instance available", "NO_BOT");
            }
            let (tx, rx) = oneshot::channel();
            let task_span = tracing::Span::current();
            let device_id = user.id.clone();
            let st_task = st.clone();
            tokio::spawn(
                async move {
                    finish(
                        st_task,
                        guard,
                        device_id,
                        client_turn_id,
                        transcript,
                        res.turn_id,
                        res.reply_text,
                        res.tool_proposals,
                        tx,
                    )
                    .await;
                }
                .instrument(task_span),
            );
            match rx.await {
                Ok((status, body)) => stored_response(status, body),
                Err(_) => coded(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "handset failed",
                    "HANDSET_FAILED",
                ),
            }
        }
    }
}

enum Heard {
    Silence,
    Remote,
    Ready {
        transcript: String,
        res: mp_brain::TurnResponse,
    },
}

async fn finish(
    st: AppState,
    guard: OwnedMutexGuard<()>,
    device_id: String,
    client_turn_id: String,
    transcript: String,
    turn_id: String,
    reply_text: String,
    proposals: Vec<mp_brain::ToolProposal>,
    tx: oneshot::Sender<(u16, Value)>,
) {
    let (wire, disposed_ok, ran) = dispose_proposals(&st, &proposals).await;
    if ran {
        crate::bot_api::broadcast_state(&st);
    }
    if !st.handset_dispose_delay.is_zero() {
        tokio::time::sleep(st.handset_dispose_delay).await;
    }
    let spoken = speak_line(&reply_text, &wire);
    let (audio, error) = match spoken {
        None => (None, Value::Null),
        Some(line) => match synthesize(&st, &line).await {
            Ok(bytes) => (Some(audio_json(&bytes)), Value::Null),
            Err(err) => {
                tracing::warn!(error = %err, "handset tts failed");
                (
                    None,
                    json!({"code": "TTS_UNAVAILABLE", "error": "tts unavailable"}),
                )
            }
        },
    };
    let body = json!({
        "transcript": transcript,
        "turnId": turn_id,
        "clientTurnId": client_turn_id,
        "replyText": reply_text,
        "disposedTools": wire,
        "audio": audio,
        "error": error,
    });
    st.handset_turns
        .insert(&device_id, &client_turn_id, 200, body.clone());
    drop(guard);
    let _ = tx.send((200, body));
    tracing::info!(
        transcript_len = transcript.chars().count(),
        tool_count = proposals.len(),
        disposed_ok,
        status = 200u16,
        "handset utterance finished",
    );
}

fn silence_body(client_turn_id: &str) -> Value {
    json!({
        "transcript": "",
        "turnId": null,
        "clientTurnId": client_turn_id,
        "replyText": "",
        "disposedTools": [],
        "audio": null,
        "error": null,
    })
}

/// Reply text wins. Otherwise the first successful tool result. A usage line
/// is not spoken. The first sentence is capped at 400 characters.
fn speak_line(reply: &str, tools: &[Value]) -> Option<String> {
    let reply = reply.trim();
    let source = if !reply.is_empty() {
        reply.to_string()
    } else {
        let result = tools.iter().find_map(|tool| {
            if tool.get("ok")?.as_bool() != Some(true) {
                return None;
            }
            let result = tool.get("result")?.as_str()?;
            if result.starts_with("Usage:") {
                return None;
            }
            let result = result.trim();
            if result.is_empty() {
                None
            } else {
                Some(result.to_string())
            }
        })?;
        result
    };
    let chunks = mp_voice::tts_speak_chunks(&source);
    let first = chunks.first().map(String::as_str).unwrap_or("");
    let line: String = first.chars().take(SPEAK_MAX).collect();
    if line.is_empty() { None } else { Some(line) }
}

async fn synthesize(st: &AppState, line: &str) -> Result<Vec<u8>, String> {
    let (url, voice) = {
        let cfg = st.read_config();
        (cfg.voice.tts_url.clone(), cfg.voice.tts_voice.clone())
    };
    if url.trim().is_empty() {
        return Err("tts url empty".into());
    }
    let tts = mp_voice::HttpTtsClient::new(url.trim(), &voice);
    let (bytes, _) = tts.synthesize(line).await?;
    if bytes.is_empty() {
        Err("tts empty".into())
    } else {
        Ok(bytes)
    }
}

fn audio_json(bytes: &[u8]) -> Value {
    let wav = base64::engine::general_purpose::STANDARD.encode(bytes);
    let mut audio = json!({
        "contentType": "audio/wav",
        "wavBase64": wav,
    });
    if let Some(rate) = wav_sample_rate(bytes) {
        audio["sampleRateHz"] = json!(rate);
    }
    audio
}

/// Canonical PCM RIFF: sample rate is a little-endian u32 at offset 24.
fn wav_sample_rate(bytes: &[u8]) -> Option<u32> {
    if bytes.len() < 28 {
        return None;
    }
    if &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" || &bytes[12..16] != b"fmt " {
        return None;
    }
    let format = u16::from_le_bytes([bytes[20], bytes[21]]);
    if format != 1 {
        return None;
    }
    Some(u32::from_le_bytes([
        bytes[24], bytes[25], bytes[26], bytes[27],
    ]))
}

fn is_octet_stream(value: Option<&axum::http::HeaderValue>) -> bool {
    let Ok(text) = value.map(|v| v.to_str()).unwrap_or(Ok("")) else {
        return false;
    };
    let mime = text.split(';').next().unwrap_or("").trim();
    mime.eq_ignore_ascii_case("application/octet-stream")
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

fn coded(status: StatusCode, error: &str, code: &str) -> Response {
    (status, Json(json!({ "error": error, "code": code }))).into_response()
}

fn stored_response(status: u16, body: Value) -> Response {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (code, Json(body)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handset_wav_rate_requires_pcm() {
        let mut bytes = vec![0u8; 44];
        bytes[0..4].copy_from_slice(b"RIFF");
        bytes[8..12].copy_from_slice(b"WAVE");
        bytes[12..16].copy_from_slice(b"fmt ");
        bytes[20..22].copy_from_slice(&1u16.to_le_bytes());
        bytes[24..28].copy_from_slice(&22050u32.to_le_bytes());
        assert_eq!(wav_sample_rate(&bytes), Some(22050));
        bytes[20..22].copy_from_slice(&3u16.to_le_bytes());
        assert!(wav_sample_rate(&bytes).is_none());
    }
}
