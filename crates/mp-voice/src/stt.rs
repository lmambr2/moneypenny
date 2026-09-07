// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! HTTP STT client. Whisper stays out of process (`POST /asr`, `POST /asr/stream`).

use std::time::Duration;

use serde::Deserialize;

use crate::{StreamSttResult, Utterance};

#[derive(Clone)]
pub struct HttpSttClient {
    url: String,
    timeout: Duration,
    http: reqwest::Client,
}

impl HttpSttClient {
    pub fn new(url: impl Into<String>) -> Self {
        Self::with_timeout(url, Duration::from_secs(15))
    }

    pub fn with_timeout(url: impl Into<String>, timeout: Duration) -> Self {
        let url = url.into().trim_end_matches('/').to_string();
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .expect("reqwest");
        Self { url, timeout, http }
    }

    pub async fn transcribe(&self, u: &Utterance) -> String {
        self.transcribe_ex(u).await.0
    }

    /// Returns (text, kws keyword if the sidecar spotted one).
    pub async fn transcribe_ex(&self, u: &Utterance) -> (String, Option<String>) {
        let url = format!("{}/asr", self.url);
        match self
            .http
            .post(&url)
            .timeout(self.timeout)
            .header("content-type", "application/octet-stream")
            .header("X-Sample-Rate", u.sample_rate.to_string())
            .header("X-Channels", u.channels.to_string())
            .body(u.pcm.clone())
            .send()
            .await
        {
            Ok(res) => match res.json::<AsrBody>().await {
                Ok(body) => {
                    let text = body.text.unwrap_or_default().trim().to_string();
                    let kw = body
                        .keyword
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string());
                    (text, kw)
                }
                Err(e) => {
                    tracing::warn!(error = %e, "STT json");
                    (String::new(), None)
                }
            },
            Err(e) => {
                tracing::warn!(error = %e, url = %self.url, "STT request failed");
                (String::new(), None)
            }
        }
    }

    pub async fn feed_stream(
        &self,
        client_id: i32,
        pcm: &[u8],
        sample_rate: u32,
        channels: u32,
    ) -> StreamSttResult {
        let url = format!("{}/asr/stream", self.url);
        match self
            .http
            .post(&url)
            .timeout(self.timeout)
            .header("content-type", "application/octet-stream")
            .header("X-Client-Id", client_id.to_string())
            .header("X-Sample-Rate", sample_rate.to_string())
            .header("X-Channels", channels.to_string())
            .body(pcm.to_vec())
            .send()
            .await
        {
            Ok(res) => match res.json::<StreamBody>().await {
                Ok(data) => {
                    let partial = data.partial.unwrap_or_default().trim().to_string();
                    let final_t = data
                        .r#final
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string());
                    let speaking = data.speaking.unwrap_or(false) || !partial.is_empty() || final_t.is_some();
                    let keyword = data
                        .keyword
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string());
                    let listening = match data.listening.as_deref() {
                        Some("passive") => Some("passive".into()),
                        Some("command") => Some("command".into()),
                        _ => None,
                    };
                    StreamSttResult {
                        partial,
                        final_text: final_t,
                        speaking,
                        keyword,
                        listening,
                        command_final: data.command_final.unwrap_or(false),
                        error: None,
                    }
                }
                Err(e) => StreamSttResult {
                    error: Some(e.to_string()),
                    ..Default::default()
                },
            },
            Err(e) => StreamSttResult {
                error: Some(e.to_string()),
                ..Default::default()
            },
        }
    }

    pub async fn reset_stream(&self, client_id: i32) {
        let url = format!("{}/asr/stream", self.url);
        let _ = self
            .http
            .delete(&url)
            .timeout(self.timeout)
            .header("X-Client-Id", client_id.to_string())
            .send()
            .await;
    }
}

#[derive(Deserialize)]
struct AsrBody {
    text: Option<String>,
    keyword: Option<String>,
}

#[derive(Deserialize)]
struct StreamBody {
    partial: Option<String>,
    r#final: Option<String>,
    speaking: Option<bool>,
    keyword: Option<String>,
    listening: Option<String>,
    #[serde(rename = "commandFinal")]
    command_final: Option<bool>,
}
