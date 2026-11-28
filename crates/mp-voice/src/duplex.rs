// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! PersonaPlex adapter client. HTTP `/health` + `POST /v1/control`, binary WS `/v1/pcm`.
//! Inbound 0x02 is an agent caption and is never user ASR.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::duplex_text::user_text_from_agent_monologue;
use crate::duplex_watch::{DuplexHealth, parse_health};

pub const KIND_PCM: u8 = 0x01;
pub const KIND_TEXT: u8 = 0x02;
pub const KIND_META: u8 = 0x04;

pub fn ws_url(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    let rest = trimmed
        .strip_prefix("https://")
        .map(|s| format!("wss://{s}"))
        .or_else(|| trimmed.strip_prefix("http://").map(|s| format!("ws://{s}")))
        .unwrap_or_else(|| trimmed.to_string());
    format!("{rest}/v1/pcm")
}

pub async fn fetch_health(http: &reqwest::Client, base: &str) -> DuplexHealth {
    let url = format!("{}/health", base.trim().trim_end_matches('/'));
    match http.get(&url).timeout(Duration::from_secs(3)).send().await {
        Ok(res) => match res.json::<Value>().await {
            Ok(v) => parse_health(&v),
            Err(_) => DuplexHealth::unreachable(),
        },
        Err(_) => DuplexHealth::unreachable(),
    }
}

pub async fn post_control(http: &reqwest::Client, base: &str, op: &str) -> DuplexHealth {
    let url = format!("{}/v1/control", base.trim().trim_end_matches('/'));
    match http
        .post(&url)
        .timeout(Duration::from_secs(15))
        .json(&json!({ "op": op }))
        .send()
        .await
    {
        Ok(res) => match res.json::<Value>().await {
            Ok(v) => parse_health(&v),
            Err(_) => DuplexHealth::unreachable(),
        },
        Err(_) => DuplexHealth::unreachable(),
    }
}

pub struct Inbound {
    pub pcm: Option<Vec<u8>>,
    pub caption: Option<String>,
    pub speaking: Option<bool>,
}

/// Split one binary WS payload. 0x02 never becomes a user command.
pub fn decode_inbound(bytes: &[u8]) -> Option<Inbound> {
    if bytes.is_empty() {
        return None;
    }
    let kind = bytes[0];
    let payload = &bytes[1..];
    match kind {
        KIND_PCM => Some(Inbound {
            pcm: Some(payload.to_vec()),
            caption: None,
            speaking: None,
        }),
        KIND_TEXT => {
            let text = String::from_utf8_lossy(payload).into_owned();
            let _ = user_text_from_agent_monologue(&text);
            Some(Inbound {
                pcm: None,
                caption: Some(text),
                speaking: None,
            })
        }
        KIND_META => {
            let speaking = serde_json::from_slice::<Value>(payload)
                .ok()
                .and_then(|v| v.get("speaking").and_then(|s| s.as_bool()));
            Some(Inbound {
                pcm: None,
                caption: None,
                speaking,
            })
        }
        _ => None,
    }
}

pub fn encode_pcm(pcm: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + pcm.len());
    out.push(KIND_PCM);
    out.extend_from_slice(pcm);
    out
}

/// Read Talker frames and write user PCM. Stops when `stop` is closed or the socket ends.
pub async fn run_pcm_link(
    base: &str,
    mut outbound: mpsc::UnboundedReceiver<Vec<u8>>,
    inbound: mpsc::UnboundedSender<Inbound>,
) {
    let url = ws_url(base);
    let Ok((ws, _)) = connect_async(&url).await else {
        tracing::warn!(url = %url, "Voice: duplex PCM socket failed");
        return;
    };
    let (mut write, mut read) = ws.split();
    loop {
        tokio::select! {
            msg = read.next() => {
                let Some(msg) = msg else { break };
                let Ok(msg) = msg else { break };
                let Message::Binary(bytes) = msg else { continue };
                if let Some(frame) = decode_inbound(&bytes) {
                    if inbound.send(frame).is_err() {
                        break;
                    }
                }
            }
            pcm = outbound.recv() => {
                let Some(pcm) = pcm else { break };
                if write.send(Message::Binary(encode_pcm(&pcm).into())).await.is_err() {
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_frame_is_a_caption() {
        let frame = decode_inbound(&[KIND_TEXT, b'h', b'i']).unwrap();
        assert_eq!(frame.caption.as_deref(), Some("hi"));
        assert!(frame.pcm.is_none());
        assert_eq!(
            ws_url("http://127.0.0.1:8999"),
            "ws://127.0.0.1:8999/v1/pcm"
        );
    }
}
