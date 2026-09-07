// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! OpenAI-compatible `/v1/audio/speech` (Piper). Whisper/Piper stay out of process.

use std::time::Duration;

use serde_json::json;

use crate::speak::{text_to_spoken, tts_timeout_for_text};

#[derive(Clone)]
pub struct HttpTtsClient {
    url: String,
    voice: String,
    model: String,
    format: String,
    timeout: Duration,
    http: reqwest::Client,
}

impl HttpTtsClient {
    pub fn new(url: impl Into<String>, voice: impl Into<String>) -> Self {
        let url = url.into().trim_end_matches('/').to_string();
        let timeout = Duration::from_secs(20);
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .expect("reqwest");
        Self {
            url,
            voice: {
                let v = voice.into();
                if v.is_empty() {
                    "en_GB-cori-high".into()
                } else {
                    v
                }
            },
            model: "piper".into(),
            format: "wav".into(),
            timeout,
            http,
        }
    }

    pub async fn synthesize(&self, text: &str) -> Result<(Vec<u8>, String), String> {
        let spoken = text_to_spoken(text);
        if spoken.is_empty() {
            return Ok((Vec::new(), self.format.clone()));
        }
        let timeout = Duration::from_millis(tts_timeout_for_text(
            &spoken,
            self.timeout.as_millis() as u64,
            120_000,
        ));
        let url = format!("{}/v1/audio/speech", self.url);
        let res = self
            .http
            .post(&url)
            .timeout(timeout)
            .header("content-type", "application/json")
            .json(&json!({
                "model": self.model,
                "input": spoken,
                "voice": self.voice,
                "response_format": self.format,
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("tts http {}", res.status()));
        }
        let audio = res.bytes().await.map_err(|e| e.to_string())?.to_vec();
        Ok((audio, self.format.clone()))
    }
}
