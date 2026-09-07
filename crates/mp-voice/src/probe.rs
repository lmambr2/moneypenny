// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use std::time::Duration;

use serde::Deserialize;

use crate::tts::HttpTtsClient;

#[derive(Deserialize)]
struct HealthBody {
    ok: Option<bool>,
}

pub async fn probe_http_health(base_url: &str, timeout: Duration) -> bool {
    let url = format!("{}/health", base_url.trim_end_matches('/'));
    let Ok(client) = reqwest::Client::builder().timeout(timeout).build() else {
        return false;
    };
    match client.get(&url).send().await {
        Ok(res) => res
            .json::<HealthBody>()
            .await
            .ok()
            .and_then(|b| b.ok)
            .unwrap_or(false),
        Err(_) => false,
    }
}

pub async fn probe_http_stt(base_url: &str, timeout: Duration) -> bool {
    let url = format!("{}/asr", base_url.trim_end_matches('/'));
    let Ok(http) = reqwest::Client::builder().timeout(timeout).build() else {
        return false;
    };
    match http
        .post(&url)
        .header("content-type", "application/octet-stream")
        .header("X-Sample-Rate", "16000")
        .header("X-Channels", "1")
        .body(vec![1u8; 256])
        .send()
        .await
    {
        Ok(res) => res
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("text").map(|t| t.is_string()))
            .unwrap_or(false),
        Err(_) => false,
    }
}

pub async fn probe_http_tts(base_url: &str, voice: &str, timeout: Duration) -> bool {
    let _ = timeout;
    let client = HttpTtsClient::new(base_url, voice);
    match client.synthesize("ok").await {
        Ok((audio, _)) => !audio.is_empty(),
        Err(_) => false,
    }
}
