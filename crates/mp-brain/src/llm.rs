// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! OpenAI-compat chat client + in-process LlmModule (ask / chatForIntent).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::text::extract_assistant_text;
use crate::tools::{
    DEFAULT_CHAT_MODEL, DEFAULT_SYSTEM_PROMPT, intent_system_prompt, music_control_tools,
};

/// Output caps. These are generation limits, not context.
pub const LLM_DEFAULT_MAX_TOKENS: u32 = 8192;
pub const LLM_ASK_MAX_TOKENS: u32 = 16_384;
pub const LLM_INTENT_MAX_TOKENS: u32 = 1024;
pub const LLM_VOICE_MAX_TOKENS: u32 = 384;

/// Penny stays hot. Ollama ignores this on vLLM; vLLM ignores `num_ctx`.
pub const LLM_PENNY_KEEP_ALIVE: &str = "24h";

/// Voice and typed `!ask` share Radiance `max_model_len`. Never default 256k.
pub const LLM_NUM_CTX: u32 = 32_768;

/// Settings sometimes paste an OpenAI base (`…/v1`). The client appends
/// `/v1/chat/completions`, so a trailing `/v1` would 404 as `/v1/v1/…`.
pub fn normalize_llm_base_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if let Some(tail) = trimmed.get(trimmed.len().saturating_sub(3)..) {
        if tail.eq_ignore_ascii_case("/v1") {
            return trimmed[..trimmed.len() - 3]
                .trim_end_matches('/')
                .to_string();
        }
    }
    trimmed.to_string()
}

#[derive(Clone, Copy)]
struct CompletionTune {
    temperature: f32,
    max_tokens: u32,
    /// `None` omits the Ollama `think` field. `chat_template_kwargs.enable_thinking`
    /// is still sent, and is true only when this is `Some(true)`.
    think: Option<bool>,
    num_ctx: Option<u32>,
    flash_attention: bool,
    stream: bool,
}

fn ask_tune(spoken: bool, temperature: f32) -> CompletionTune {
    CompletionTune {
        temperature,
        max_tokens: if spoken {
            LLM_VOICE_MAX_TOKENS
        } else {
            LLM_ASK_MAX_TOKENS
        },
        think: Some(!spoken),
        num_ctx: Some(LLM_NUM_CTX),
        flash_attention: true,
        stream: false,
    }
}

fn intent_tune(spoken: bool, temperature: f32) -> CompletionTune {
    CompletionTune {
        temperature,
        max_tokens: if spoken {
            LLM_VOICE_MAX_TOKENS
        } else {
            LLM_INTENT_MAX_TOKENS
        },
        think: Some(false),
        num_ctx: Some(LLM_NUM_CTX),
        flash_attention: true,
        stream: false,
    }
}

/// Ollama `POST /api/generate` body that drops the model from VRAM.
pub fn ollama_unload_body(model: &str) -> Value {
    json!({
        "model": model,
        "prompt": "",
        "keep_alive": 0,
        "stream": false,
    })
}

fn build_chat_payload(
    model: &str,
    messages: &[ChatMessage],
    tools: Option<&Vec<Value>>,
    tool_choice: Option<&str>,
    tune: CompletionTune,
) -> Value {
    let mut payload = json!({
        "model": model,
        "messages": messages,
        "temperature": tune.temperature,
        "max_tokens": tune.max_tokens,
        "stream": tune.stream,
        "keep_alive": LLM_PENNY_KEEP_ALIVE,
        "chat_template_kwargs": { "enable_thinking": tune.think == Some(true) },
    });
    if let Some(think) = tune.think {
        payload["think"] = json!(think);
    }
    if let Some(tools) = tools {
        payload["tools"] = Value::Array(tools.clone());
    }
    if let Some(choice) = tool_choice {
        payload["tool_choice"] = json!(choice);
    }
    let mut options = serde_json::Map::new();
    if let Some(n) = tune.num_ctx {
        options.insert("num_ctx".into(), json!(n));
    }
    if tune.flash_attention {
        options.insert("flash_attention".into(), json!(true));
    }
    if !options.is_empty() {
        payload["options"] = Value::Object(options);
    }
    payload
}

pub fn sse_delta_content(data: &str) -> Option<String> {
    let v: Value = serde_json::from_str(data).ok()?;
    v.get("choices")?
        .get(0)?
        .get("delta")?
        .get("content")
        .and_then(|c| c.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

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
            return normalize_llm_base_url(u);
        }
        std::env::var("RKLLAMA_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .map(|s| normalize_llm_base_url(&s))
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
    delta_hook: Mutex<Option<Arc<dyn Fn(&str) + Send + Sync>>>,
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
                Some(normalize_llm_base_url(u))
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
                delta_hook: Mutex::new(None),
            }),
        }
    }

    pub fn set_delta_hook(&self, hook: Option<Arc<dyn Fn(&str) + Send + Sync>>) {
        *self.inner.delta_hook.lock().expect("delta") = hook;
    }

    /// SSE chat completion. `stream` is true. Each content delta is delivered
    /// before the next chunk is read, so speech can start on the first sentence.
    pub async fn stream_user_prompt<F>(&self, user: &str, on_delta: F) -> Result<String, String>
    where
        F: FnMut(&str),
    {
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: Some(user.to_string()),
        }];
        let mut tune = ask_tune(true, self.inner.temperature);
        tune.stream = true;
        self.stream_content(&messages, tune, on_delta).await
    }

    pub(crate) async fn stream_content<F>(
        &self,
        messages: &[ChatMessage],
        mut tune: CompletionTune,
        mut on_delta: F,
    ) -> Result<String, String>
    where
        F: FnMut(&str),
    {
        tune.stream = true;
        let url = format!(
            "{}/v1/chat/completions",
            normalize_llm_base_url(&self.inner.primary_url)
        );
        let payload = build_chat_payload(
            &self.inner.primary_model,
            messages,
            None,
            Some("none"),
            tune,
        );
        let res = self
            .inner
            .client
            .post(&url)
            .header("content-type", "application/json")
            .json(&payload)
            .timeout(self.inner.timeout)
            .send()
            .await
            .map_err(|e| format!("LLM stream failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("LLM stream HTTP {}", res.status()));
        }
        let mut carry = String::new();
        let mut raw = String::new();
        let mut res = res;
        loop {
            let chunk = res
                .chunk()
                .await
                .map_err(|e| format!("LLM stream read failed: {e}"))?;
            let Some(chunk) = chunk else { break };
            carry.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(nl) = carry.find('\n') {
                let line = carry.drain(..=nl).collect::<String>();
                let line = line.trim();
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                if let Some(text) = sse_delta_content(data) {
                    raw.push_str(&text);
                    on_delta(&text);
                    if let Some(hook) = self.inner.delta_hook.lock().expect("delta").clone() {
                        hook(&text);
                    }
                }
            }
        }
        Ok(raw)
    }

    /// Drop this model from Ollama VRAM. 404/405 from non-Ollama servers is success.
    pub async fn unload(&self) -> Result<(), String> {
        let url = format!(
            "{}/api/generate",
            normalize_llm_base_url(&self.inner.primary_url)
        );
        let body = ollama_unload_body(&self.inner.primary_model);
        let res = self
            .inner
            .client
            .post(&url)
            .header("content-type", "application/json")
            .json(&body)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| format!("LLM unload failed: {e}"))?;
        let status = res.status();
        if status.is_success() || status.as_u16() == 404 || status.as_u16() == 405 {
            return Ok(());
        }
        Err(format!("LLM unload HTTP {status}"))
    }

    /// Tiny completion so Ollama loads weights before the next real turn.
    pub async fn warm(&self) -> Result<(), String> {
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: Some("ok".into()),
        }];
        self.chat(
            &messages,
            None,
            Some("none"),
            CompletionTune {
                temperature: 0.0,
                max_tokens: 1,
                think: None,
                num_ctx: Some(LLM_NUM_CTX),
                flash_attention: false,
                stream: false,
            },
        )
        .await
        .map(|_| ())
    }

    /// One-shot completion with a custom system prompt (roast grader, etc.).
    /// Does not touch conversation history. Fail-open at the caller.
    pub async fn complete_system(&self, system: &str, user: &str) -> Result<String, String> {
        let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: Some(system.to_string()),
            },
            ChatMessage {
                role: "user".into(),
                content: Some(user.to_string()),
            },
        ];
        let resp = self
            .chat(
                &messages,
                None,
                Some("none"),
                CompletionTune {
                    temperature: self.inner.temperature,
                    max_tokens: LLM_DEFAULT_MAX_TOKENS,
                    think: None,
                    num_ctx: None,
                    flash_attention: false,
                    stream: false,
                },
            )
            .await?;
        let msg = resp.choices.first().map(|c| &c.message);
        let content = msg
            .map(|m| extract_assistant_text(m.content.as_deref(), m.reasoning.as_deref()))
            .unwrap_or_default();
        Ok(content)
    }

    pub async fn ask(
        &self,
        question: &str,
        conversation_id: Option<&str>,
        spoken: bool,
    ) -> Result<String, String> {
        let mut messages = vec![ChatMessage {
            role: "system".into(),
            content: Some(self.inner.system_prompt.clone()),
        }];
        messages.extend(self.history_messages(conversation_id));
        messages.push(ChatMessage {
            role: "user".into(),
            content: Some(question.to_string()),
        });
        if spoken {
            let tune = ask_tune(true, self.inner.temperature);
            if let Ok(text) = self.stream_content(&messages, tune, |_| {}).await {
                let text = text.trim().to_string();
                if !text.is_empty() {
                    self.record(conversation_id, question, &text);
                    return Ok(text);
                }
            }
        }
        let resp = self
            .chat(
                &messages,
                None,
                Some("none"),
                ask_tune(spoken, self.inner.temperature),
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
        spoken: bool,
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
                intent_tune(spoken, self.inner.temperature),
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
        tune: CompletionTune,
    ) -> Result<ChatCompletionResponse, String> {
        let primary = self
            .post_chat(
                &self.inner.primary_url,
                &self.inner.primary_model,
                messages,
                tools.as_ref(),
                tool_choice,
                tune,
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
                self.post_chat(url, model, messages, tools.as_ref(), tool_choice, tune)
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
        tune: CompletionTune,
    ) -> Result<ChatCompletionResponse, String> {
        let url = format!("{}/v1/chat/completions", normalize_llm_base_url(base));
        let payload = build_chat_payload(model, messages, tools, tool_choice, tune);
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
    pub chat_for_intent: Option<Arc<dyn Fn(&str) -> Result<IntentResult, String> + Send + Sync>>,
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
    pub async fn ask(
        &self,
        question: &str,
        conversation_id: Option<&str>,
        spoken: bool,
    ) -> Result<String, String> {
        match self {
            Self::OpenAi(c) => c.ask(question, conversation_id, spoken).await,
            Self::Scripted(s) => (s.ask)(question),
        }
    }

    pub async fn chat_for_intent(
        &self,
        user_message: &str,
        conversation_id: Option<&str>,
        spoken: bool,
    ) -> Result<IntentResult, String> {
        match self {
            Self::OpenAi(c) => {
                c.chat_for_intent(user_message, conversation_id, spoken)
                    .await
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn msg() -> ChatMessage {
        ChatMessage {
            role: "user".into(),
            content: Some("hi".into()),
        }
    }

    #[test]
    fn normalize_strips_openai_v1_suffix() {
        assert_eq!(
            normalize_llm_base_url("http://127.0.0.1:8080/v1"),
            "http://127.0.0.1:8080"
        );
        assert_eq!(
            normalize_llm_base_url("http://127.0.0.1:8080/v1/"),
            "http://127.0.0.1:8080"
        );
        assert_eq!(
            normalize_llm_base_url("http://127.0.0.1:11434"),
            "http://127.0.0.1:11434"
        );
    }

    #[test]
    fn payload_disables_qwen_thinking_unless_asked() {
        let off = build_chat_payload(
            "Qwen3.8",
            &[msg()],
            None,
            Some("none"),
            CompletionTune {
                temperature: 0.2,
                max_tokens: LLM_ASK_MAX_TOKENS,
                think: Some(false),
                num_ctx: Some(LLM_NUM_CTX),
                flash_attention: true,
                stream: false,
            },
        );
        assert_eq!(off["chat_template_kwargs"]["enable_thinking"], false);
        assert_eq!(off["think"], false);
        assert_eq!(off["keep_alive"], LLM_PENNY_KEEP_ALIVE);
        assert_eq!(off["options"]["num_ctx"], LLM_NUM_CTX);
        assert_eq!(off["options"]["flash_attention"], true);
        assert_eq!(off["max_tokens"], LLM_ASK_MAX_TOKENS);
        assert_eq!(off["stream"], false);

        let on = build_chat_payload(
            "Qwen3.8",
            &[msg()],
            None,
            Some("none"),
            CompletionTune {
                temperature: 0.2,
                max_tokens: LLM_VOICE_MAX_TOKENS,
                think: Some(true),
                num_ctx: Some(LLM_NUM_CTX),
                flash_attention: true,
                stream: false,
            },
        );
        assert_eq!(on["think"], true);
        assert_eq!(on["chat_template_kwargs"]["enable_thinking"], true);
        assert_eq!(on["max_tokens"], LLM_VOICE_MAX_TOKENS);

        let omitted = build_chat_payload(
            "Qwen3.8",
            &[msg()],
            None,
            None,
            CompletionTune {
                temperature: 0.2,
                max_tokens: LLM_DEFAULT_MAX_TOKENS,
                think: None,
                num_ctx: None,
                flash_attention: false,
                stream: false,
            },
        );
        assert!(omitted.get("think").is_none());
        assert_eq!(omitted["chat_template_kwargs"]["enable_thinking"], false);
        assert!(omitted.get("options").is_none());
    }

    #[test]
    fn ask_and_intent_tunes_match_node_caps() {
        let voice = ask_tune(true, 0.2);
        assert_eq!(voice.max_tokens, LLM_VOICE_MAX_TOKENS);
        assert_eq!(voice.think, Some(false));
        assert_eq!(voice.num_ctx, Some(LLM_NUM_CTX));
        assert!(voice.flash_attention);
        let typed = ask_tune(false, 0.2);
        assert_eq!(typed.max_tokens, LLM_ASK_MAX_TOKENS);
        assert_eq!(typed.think, Some(true));
        assert_eq!(typed.num_ctx, Some(LLM_NUM_CTX));
        let intent = intent_tune(false, 0.2);
        assert_eq!(intent.max_tokens, LLM_INTENT_MAX_TOKENS);
        assert_eq!(intent.think, Some(false));
        assert_eq!(intent.num_ctx, Some(LLM_NUM_CTX));
        let spoken_intent = intent_tune(true, 0.2);
        assert_eq!(spoken_intent.max_tokens, LLM_VOICE_MAX_TOKENS);
        assert_eq!(spoken_intent.think, Some(false));
        let unload = ollama_unload_body("gemma-test");
        assert_eq!(unload["model"], "gemma-test");
        assert_eq!(unload["prompt"], "");
        assert_eq!(unload["keep_alive"], 0);
        assert_eq!(unload["stream"], false);
    }
}
