// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! HTTP client for the MemPalace sidecar. Fail-soft — SQLite remains authority.

use std::time::Duration;

use serde_json::{json, Value};

#[derive(Clone)]
pub struct MemPalaceClient {
    base: String,
    timeout: Duration,
    http: reqwest::Client,
}

impl MemPalaceClient {
    pub fn new(url: impl Into<String>) -> Self {
        let base = url.into().trim().trim_end_matches('/').to_string();
        let timeout = Duration::from_secs(20);
        let http = reqwest::Client::builder().timeout(timeout).build().expect("reqwest");
        Self { base, timeout, http }
    }

    pub fn from_env() -> Option<Self> {
        let url = std::env::var("MEMPALACE_URL").ok()?.trim().to_string();
        if url.is_empty() {
            None
        } else {
            Some(Self::new(url))
        }
    }

    pub fn from_url(url: &str) -> Option<Self> {
        let t = url.trim();
        if t.is_empty() {
            Self::from_env()
        } else {
            Some(Self::new(t))
        }
    }

    pub async fn is_available(&self) -> bool {
        let url = format!("{}/health", self.base);
        match self.http.get(&url).timeout(Duration::from_secs(5)).send().await {
            Ok(res) => res
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| v.get("ok").and_then(|x| x.as_bool()))
                .unwrap_or(false),
            Err(_) => false,
        }
    }

    pub async fn remember(&self, user_id: &str, fact: &str) -> bool {
        let url = format!("{}/v1/remember", self.base);
        match self
            .http
            .post(&url)
            .timeout(self.timeout)
            .json(&json!({ "userId": user_id, "fact": fact }))
            .send()
            .await
        {
            Ok(res) => res
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| v.get("ok").and_then(|x| x.as_bool()))
                .unwrap_or(false),
            Err(e) => {
                tracing::warn!(error = %e, "MemPalace remember failed");
                false
            }
        }
    }

    pub async fn search(&self, user_id: &str, query: &str, limit: u32) -> Vec<String> {
        let url = format!("{}/v1/search", self.base);
        match self
            .http
            .post(&url)
            .timeout(self.timeout)
            .json(&json!({ "userId": user_id, "query": query, "limit": limit }))
            .send()
            .await
        {
            Ok(res) => res
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| v.get("results").and_then(|r| r.as_array()).cloned())
                .unwrap_or_default()
                .into_iter()
                .filter_map(|row| row.get("fact").and_then(|f| f.as_str()).map(str::to_string))
                .collect(),
            Err(e) => {
                tracing::warn!(error = %e, "MemPalace search failed");
                Vec::new()
            }
        }
    }

    pub async fn forget(&self, user_id: &str, all: bool, index: Option<i64>) -> bool {
        let url = format!("{}/v1/forget", self.base);
        let body = json!({ "userId": user_id, "all": all, "index": index });
        match self.http.post(&url).timeout(self.timeout).json(&body).send().await {
            Ok(res) => res
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| v.get("ok").and_then(|x| x.as_bool()))
                .unwrap_or(false),
            Err(_) => false,
        }
    }
}
