// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! OpenAI-compat chat client + in-process LlmModule (ask / chatForIntent).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::text::extract_assistant_text;
use crate::tools::{intent_system_prompt, music_control_tools, DEFAULT_CHAT_MODEL, DEFAULT_SYSTEM_PROMPT};

#[derive(Debug, Clone)]
pub struct LlmSettings {
    pub enabled: bool,
    pub url: String,
    pub model: String,
    pub fallback_url: String,
    pub fallback_model: String,
    pub system_prompt: String,
    pub temperature: f32,
    pub brain_url: String,
    pub timeout_ms: u64,
}

impl Default for LlmSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            url: String::new(),
            model: String::new(),
            fallback_url: String::new(),
            fallback_model: String::new(),
            system_prompt: String::new(),
            temperature: 0.2,
            brain_url: std::env::var("BRAIN_URL").unwrap_or_default(),
            timeout_ms: std::env::var("LLM_TIMEOUT_MS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(180_000),
        }
    }
}

impl LlmSettings {
    pub fn resolved_url(&self) -> String {
        let u = self.url.trim();
        if !u.is_empty() {
            return u.trim_end_matches('/').to_string();
        }
        std::env::var("RKLLAMA_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .map(|s| s.trim_end_matches('/').to_string())
            .unwrap_or_else(|| "http://localhost:8080".into())
    }

    pub fn resolved_model(&self) -> String {
        let m = self.model.trim();
        if !m.is_empty() {
            return m.to_string();
        }
        std::env::var("RKLLAMA_MODEL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_CHAT_MODEL.to_string())
    }

    pub fn persona(&self) -> &str {
        if self.system_prompt.trim().is_empty() {
            DEFAULT_SYSTEM_PROMPT
        } else {
            self.system_prompt.as_str()
        }
    }
}

#[derive(Clone)]
pub struct OpenAiLlm {
    inner: Arc<OpenAiInner>,
}

struct OpenAiInner {
    client: reqwest::Client,
    primary_url: String,
    primary_model: String,
    fallback_url: Option<String>,
    fallback_model: Option<String>,
    timeout: Duration,
    system_prompt: String,
    temperature: f32,
    history: Mutex<HashMap<String, Vec<HistoryEntry>>>,
}

#[derive(Clone)]
struct HistoryEntry {
    role: &'static str,
    content: String,
}

#[derive(Debug, Clone)]
pub struct IntentResult {
    pub content: Option<String>,
    pub tool_calls: Vec<IntentToolCall>,
}

#[derive(Debug, Clone)]
pub struct IntentToolCall {
    pub name: String,
    pub arguments: Value,
}

#[derive(Serialize)]
struct ChatMessage {
    role: String,
    content: Option<String>,
}

#[derive(Deserialize)]
struct ChatCompletionResponse {
    #[serde(default)]
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(Deserialize)]
struct ChatChoiceMessage {
    content: Option<String>,
    reasoning: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ApiToolCall>>,
}

#[derive(Deserialize)]
struct ApiToolCall {
    function: ApiFunction,
}

#[derive(Deserialize)]
struct ApiFunction {
    name: String,
    #[serde(default)]
    arguments: String,
}

impl OpenAiLlm {
    pub fn from_settings(cfg: &LlmSettings) -> Self {
        let timeout = Duration::from_millis(cfg.timeout_ms.max(1_000));
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .expect("reqwest client");
        let fallback_url = {
            let u = cfg.fallback_url.trim();
            if u.is_empty() {
                None
            } else {
                Some(u.trim_end_matches('/').to_string())
            }
        };
        let fallback_model = {
            let m = cfg.fallback_model.trim();
            if m.is_empty() {
                None
            } else {
                Some(m.to_string())
            }
        };
        Self {
            inner: Arc::new(OpenAiInner {
                client,
                primary_url: cfg.resolved_url(),
                primary_model: cfg.resolved_model(),
                fallback_url,
                fallback_model,
                timeout,
                system_prompt: cfg.persona().to_string(),
                temperature: cfg.temperature,
                history: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub async fn ask(&self, question: &str, conversation_id: Option<&str>) -> Result<String, String> {
        let mut messages = vec![ChatMessage {
            role: "system".into(),
            content: Some(self.inner.system_prompt.clone()),
        }];
        messages.extend(self.history_messages(conversation_id));
        messages.push(ChatMessage {
            role: "user".into(),
            content: Some(question.to_string()),
        });
        let resp = self
            .chat(
                &messages,
                None,
                Some("none"),
                self.inner.temperature,
                2048,
            )
            .await?;
        let msg = resp.choices.first().map(|c| &c.message);
        let mut content = msg
            .map(|m| extract_assistant_text(m.content.as_deref(), m.reasoning.as_deref()))
            .unwrap_or_default();
        if content.is_empty() {
            content = "(no response)".into();
        }
        self.record(conversation_id, question, &content);
        Ok(content)
    }

    pub async fn chat_for_intent(
        &self,
        user_message: &str,
        conversation_id: Option<&str>,
    ) -> Result<IntentResult, String> {
        let mut messages = vec![ChatMessage {
            role: "system".into(),
            content: Some(intent_system_prompt(&self.inner.system_prompt)),
        }];
        messages.extend(self.history_messages(conversation_id));
        messages.push(ChatMessage {
            role: "user".into(),
            content: Some(user_message.to_string()),
        });
        let resp = self
            .chat(
                &messages,
                Some(music_control_tools()),
                Some("auto"),
                0.1,
                400,
            )
            .await?;
        let msg = resp.choices.first().map(|c| &c.message);
        let tool_calls = msg
            .and_then(|m| m.tool_calls.as_ref())
            .map(|calls| {
                calls
                    .iter()
                    .map(|tc| IntentToolCall {
                        name: tc.function.name.clone(),
                        arguments: serde_json::from_str(&tc.function.arguments)
                            .unwrap_or_else(|_| json!({})),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !tool_calls.is_empty() {
            let content = msg.and_then(|m| m.content.as_ref().map(|s| s.trim().to_string()));
            let recorded = content
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| summarize_tool_calls(&tool_calls));
            self.record(conversation_id, user_message, &recorded);
            return Ok(IntentResult {
                content: content.filter(|s| !s.is_empty()),
                tool_calls,
            });
        }
        let content = msg
            .and_then(|m| m.content.as_ref())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if let Some(c) = content.as_deref() {
            self.record(conversation_id, user_message, c);
        }
        Ok(IntentResult {
            content,
            tool_calls: Vec::new(),
        })
    }

    async fn chat(
        &self,
        messages: &[ChatMessage],
        tools: Option<Vec<Value>>,
        tool_choice: Option<&str>,
        temperature: f32,
        max_tokens: u32,
    ) -> Result<ChatCompletionResponse, String> {
        let primary = self
            .post_chat(
                &self.inner.primary_url,
                &self.inner.primary_model,
                messages,
                tools.as_ref(),
                tool_choice,
                temperature,
                max_tokens,
            )
            .await;
        match primary {
            Ok(r) => Ok(r),
            Err(e) if is_retryable(&e) && self.inner.fallback_url.is_some() => {
                let url = self.inner.fallback_url.as_ref().unwrap();
                let model = self
                    .inner
                    .fallback_model
                    .as_deref()
                    .unwrap_or(&self.inner.primary_model);
                tracing::warn!(error = %e, "LLM primary failed — trying fallback");
                self.post_chat(
                    url,
                    model,
                    messages,
                    tools.as_ref(),
                    tool_choice,
                    temperature,
                    max_tokens,
                )
                .await
            }
            Err(e) => Err(e),
        }
    }

    async fn post_chat(
        &self,
        base: &str,
        model: &str,
        messages: &[ChatMessage],
        tools: Option<&Vec<Value>>,
        tool_choice: Option<&str>,
        temperature: f32,
        max_tokens: u32,
    ) -> Result<ChatCompletionResponse, String> {
        let url = format!("{}/v1/chat/completions", base.trim_end_matches('/'));
        let mut payload = json!({
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": false,
            "keep_alive": "6h",
        });
        if let Some(tools) = tools {
            payload["tools"] = Value::Array(tools.clone());
        }
        if let Some(choice) = tool_choice {
            payload["tool_choice"] = json!(choice);
        }
        let res = self
            .inner
            .client
            .post(&url)
            .header("content-type", "application/json")
            .json(&payload)
            .timeout(self.inner.timeout)
            .send()
            .await
            .map_err(|e| format!("LLM request failed: {e}"))?;
        let status = res.status();
        if !status.is_success() {
            return Err(format!("LLM HTTP {status}"));
        }
        res.json::<ChatCompletionResponse>()
            .await
            .map_err(|e| format!("LLM decode failed: {e}"))
    }

    fn history_messages(&self, conversation_id: Option<&str>) -> Vec<ChatMessage> {
        let Some(key) = conversation_id.filter(|s| !s.is_empty()) else {
            return Vec::new();
        };
        let map = self.inner.history.lock().expect("history");
        map.get(key)
            .map(|list| {
                list.iter()
                    .map(|e| ChatMessage {
                        role: e.role.to_string(),
                        content: Some(e.content.clone()),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn record(&self, conversation_id: Option<&str>, user: &str, assistant: &str) {
        let Some(key) = conversation_id.filter(|s| !s.is_empty()) else {
            return;
        };
        let mut map = self.inner.history.lock().expect("history");
        let list = map.entry(key.to_string()).or_default();
        list.push(HistoryEntry {
            role: "user",
            content: user.to_string(),
        });
        list.push(HistoryEntry {
            role: "assistant",
            content: assistant.to_string(),
        });
        const MAX_TURNS: usize = 20;
        while list.len() > MAX_TURNS * 2 {
            list.remove(0);
        }
    }
}

fn summarize_tool_calls(calls: &[IntentToolCall]) -> String {
    calls
        .iter()
        .map(|c| c.name.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

fn is_retryable(err: &str) -> bool {
    let m = err.to_ascii_lowercase();
    m.contains("timeout")
        || m.contains("timed out")
        || m.contains("connection")
        || m.contains("connect")
        || m.contains("502")
        || m.contains("503")
        || m.contains("504")
        || m.contains("408")
        || m.contains("decode")
}

#[derive(Clone)]
pub struct ScriptedLlm {
    pub ask: Arc<dyn Fn(&str) -> Result<String, String> + Send + Sync>,
    pub chat_for_intent:
        Option<Arc<dyn Fn(&str) -> Result<IntentResult, String> + Send + Sync>>,
}

impl ScriptedLlm {
    pub fn ask_only(reply: impl Fn(&str) -> String + Send + Sync + 'static) -> Self {
        Self {
            ask: Arc::new(move |q| Ok(reply(q))),
            chat_for_intent: None,
        }
    }

    pub fn with_intent(
        reply: impl Fn(&str) -> String + Send + Sync + 'static,
        intent: impl Fn(&str) -> IntentResult + Send + Sync + 'static,
    ) -> Self {
        Self {
            ask: Arc::new(move |q| Ok(reply(q))),
            chat_for_intent: Some(Arc::new(move |q| Ok(intent(q)))),
        }
    }
}

#[derive(Clone)]
pub enum LlmBackend {
    OpenAi(OpenAiLlm),
    Scripted(ScriptedLlm),
}

impl LlmBackend {
    pub async fn ask(&self, question: &str, conversation_id: Option<&str>) -> Result<String, String> {
        match self {
            Self::OpenAi(c) => c.ask(question, conversation_id).await,
            Self::Scripted(s) => (s.ask)(question),
        }
    }

    pub async fn chat_for_intent(
        &self,
        user_message: &str,
        conversation_id: Option<&str>,
    ) -> Result<IntentResult, String> {
        match self {
            Self::OpenAi(c) => c.chat_for_intent(user_message, conversation_id).await,
            Self::Scripted(s) => match &s.chat_for_intent {
                Some(f) => f(user_message),
                None => Ok(IntentResult {
                    content: Some((s.ask)(user_message)?),
                    tool_calls: Vec::new(),
                }),
            },
        }
    }

    pub fn has_intent(&self) -> bool {
        match self {
            Self::OpenAi(_) => true,
            Self::Scripted(s) => s.chat_for_intent.is_some(),
        }
    }
}
