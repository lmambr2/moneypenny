// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! OpenAI-compat chat client + in-process LlmModule (ask / chatForIntent).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
/// While Talker weights are resident, penny chat stays at 8k, including typed `!ask`.
pub const TALKER_RESIDENT_NUM_CTX: u32 = 8_192;

pub fn penny_num_ctx(talker_resident: bool) -> u32 {
    if talker_resident {
        TALKER_RESIDENT_NUM_CTX
    } else {
        LLM_NUM_CTX
    }
}

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
    /// Inkling ignores that flag. `effort` is the field its template reads.
    think: Option<bool>,
    /// Inkling `reasoning_effort`: `minimal` on a spoken turn, `high` on a typed one.
    /// `none` is for one-shot calls that are not a conversation.
    effort: &'static str,
    num_ctx: Option<u32>,
    flash_attention: bool,
    stream: bool,
}

fn effort_for(spoken: bool) -> &'static str {
    if spoken { "minimal" } else { "high" }
}

fn ask_tune(spoken: bool, temperature: f32) -> CompletionTune {
    ask_tune_ctx(spoken, temperature, false)
}

fn ask_tune_ctx(spoken: bool, temperature: f32, talker_resident: bool) -> CompletionTune {
    CompletionTune {
        temperature,
        max_tokens: if spoken {
            LLM_VOICE_MAX_TOKENS
        } else {
            LLM_ASK_MAX_TOKENS
        },
        // Qwen still honors `enable_thinking`. Leave it false so a Qwen fallback
        // does not spend the turn inside `answer_room`. Inkling reads `effort`.
        think: Some(false),
        effort: effort_for(spoken),
        num_ctx: Some(penny_num_ctx(talker_resident)),
        flash_attention: true,
        stream: false,
    }
}

fn intent_tune(spoken: bool, temperature: f32) -> CompletionTune {
    intent_tune_ctx(spoken, temperature, false)
}

fn intent_tune_ctx(spoken: bool, temperature: f32, talker_resident: bool) -> CompletionTune {
    CompletionTune {
        temperature,
        max_tokens: if spoken {
            LLM_VOICE_MAX_TOKENS
        } else {
            LLM_INTENT_MAX_TOKENS
        },
        think: Some(false),
        effort: effort_for(spoken),
        num_ctx: Some(penny_num_ctx(talker_resident)),
        flash_attention: true,
        stream: false,
    }
}

fn push_skill(messages: &mut Vec<ChatMessage>, skill: Option<&str>) {
    let Some(skill) = skill.map(str::trim).filter(|s| !s.is_empty()) else {
        return;
    };
    messages.push(ChatMessage::text(
        "system",
        format!("Operator skills (static, capped):\n\n{skill}"),
    ));
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
        "chat_template_kwargs": {
            "enable_thinking": tune.think == Some(true),
            "reasoning_effort": tune.effort,
        },
        "reasoning_effort": tune.effort,
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
    sse_delta_field(data, "content")
}

fn sse_delta_field(data: &str, field: &str) -> Option<String> {
    let v: Value = serde_json::from_str(data).ok()?;
    v.get("choices")?
        .get(0)?
        .get("delta")?
        .get(field)
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
    pub delegate_url: String,
    pub delegate_model: String,
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
            delegate_url: String::new(),
            delegate_model: String::new(),
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
    /// Scratchpad from the last `ask` on this conversation, consumed by `record`.
    pending_reasoning: Mutex<HashMap<String, String>>,
    delta_hook: Mutex<Option<Arc<dyn Fn(&str) + Send + Sync>>>,
    talker_resident: AtomicBool,
}

#[derive(Clone)]
struct HistoryEntry {
    role: &'static str,
    content: String,
    reasoning: Option<String>,
}

#[derive(Debug, Clone)]
pub struct IntentResult {
    pub content: Option<String>,
    pub tool_calls: Vec<IntentToolCall>,
}

#[derive(Debug, Clone)]
pub struct IntentToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone)]
pub struct ToolResultTurn {
    pub id: String,
    pub content: String,
}

pub const DELEGATE_UNCONFIGURED: &str =
    "Analyst delegation is not configured. Set a delegate URL in Settings.";
pub const ANALYST_OFFLINE: &str =
    "The analyst node is offline — try again later or use !ask for a quicker answer.";
pub const ANALYST_DENIED: &str = "You don't have permission to use 'analyst'.";

const ANALYST_SYSTEM: &str = "\
You are Colonel Moneypenny acting as senior intelligence analyst for this operations channel. \
Field-grade manner: thorough, well-structured answers; headings and bullets when helpful; \
state uncertainty plainly. You do not outrank the Chairman. Reply in direct speech; no stage directions. \
When additional context is present, answer only from it. Do not name a document, file, charter, or policy that is not in that context. \
When no documents were retrieved, do not invent any. If the context does not cover the question, say you have no document on it. \
Do not use tools or the web.";

/// Hermes web-search plus a thinking pass ran past two minutes on the live box.
/// The old 120s client timeout dropped that answer and reported the node offline.
const DELEGATE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Serialize)]
struct ChatMessage {
    role: String,
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    /// Prior assistant scratchpad. Inkling's template renders this as `<|content_thinking|>`.
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_content: Option<String>,
}

impl ChatMessage {
    fn text(role: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: Some(content.into()),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
        }
    }
}

/// `required` only when the line is clearly a music request the matcher missed.
pub fn tool_choice_for(text: &str) -> &'static str {
    let t = text
        .trim()
        .trim_start_matches('!')
        .trim()
        .to_ascii_lowercase();
    const PREFIXES: &[&str] = &[
        "play ",
        "play something",
        "put on ",
        "queue ",
        "spin ",
        "throw on ",
    ];
    if PREFIXES.iter().any(|p| t.starts_with(p)) {
        "required"
    } else {
        "auto"
    }
}

/// Music requests force a tool only when a music tool is actually offered.
/// A library-only `!ask` stays on `auto` so a question can be answered in text.
fn choice_for_tools(user_message: &str, tools: &[Value]) -> &'static str {
    let music = tools
        .iter()
        .any(|t| t["function"]["name"].as_str() == Some("play_music"));
    if music {
        tool_choice_for(user_message)
    } else {
        "auto"
    }
}

/// Library edits ride the typed `!ask` budget. Harness music turns stay at the
/// short intent cap. Voice stays at the spoken cap either way.
fn tune_for_tools(
    spoken: bool,
    temperature: f32,
    talker_resident: bool,
    tools: &[Value],
) -> CompletionTune {
    if library_only(tools) {
        ask_tune_ctx(spoken, temperature, talker_resident)
    } else {
        intent_tune_ctx(spoken, temperature, talker_resident)
    }
}

fn library_only(tools: &[Value]) -> bool {
    let mut library = false;
    let mut other = false;
    for tool in tools {
        match tool["function"]["name"].as_str() {
            Some("list_library_docs" | "read_library_doc" | "edit_library_doc") => library = true,
            Some(_) => other = true,
            None => {}
        }
    }
    library && !other
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
    /// Strata and Hermes put the scratchpad in `reasoning_content`. The older
    /// field name is `reasoning`. Either one can salvage an empty `content`.
    #[serde(default, alias = "reasoning_content")]
    reasoning: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ApiToolCall>>,
}

#[derive(Deserialize)]
struct ApiToolCall {
    #[serde(default)]
    id: String,
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
                pending_reasoning: Mutex::new(HashMap::new()),
                delta_hook: Mutex::new(None),
                talker_resident: AtomicBool::new(false),
            }),
        }
    }

    pub fn set_delta_hook(&self, hook: Option<Arc<dyn Fn(&str) + Send + Sync>>) {
        *self.inner.delta_hook.lock().expect("delta") = hook;
    }

    /// Duplex health drives this. Unloaded Talker leaves the 32k window.
    pub fn set_talker_resident(&self, on: bool) {
        self.inner.talker_resident.store(on, Ordering::SeqCst);
    }

    fn resident(&self) -> bool {
        self.inner.talker_resident.load(Ordering::SeqCst)
    }

    /// SSE chat completion. `stream` is true. Each content delta is delivered
    /// before the next chunk is read, so speech can start on the first sentence.
    pub async fn stream_user_prompt<F>(&self, user: &str, on_delta: F) -> Result<String, String>
    where
        F: FnMut(&str),
    {
        let messages = vec![ChatMessage::text("user", user)];
        let mut tune = ask_tune(true, self.inner.temperature);
        tune.stream = true;
        self.stream_content(&messages, tune, on_delta)
            .await
            .map(|(text, _reasoning)| text)
    }

    pub(crate) async fn stream_content<F>(
        &self,
        messages: &[ChatMessage],
        mut tune: CompletionTune,
        mut on_delta: F,
    ) -> Result<(String, String), String>
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
        let mut reasoning = String::new();
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
                if let Some(thought) = sse_delta_field(data, "reasoning_content") {
                    reasoning.push_str(&thought);
                }
            }
        }
        Ok((raw, reasoning))
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
        let messages = vec![ChatMessage::text("user", "ok")];
        self.chat(
            &messages,
            None,
            Some("none"),
            CompletionTune {
                temperature: 0.0,
                max_tokens: 1,
                think: None,
                effort: "none",
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
            ChatMessage::text("system", system),
            ChatMessage::text("user", user),
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
                    effort: "none",
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
        skill: Option<&str>,
        grounding: &str,
    ) -> Result<String, String> {
        let mut messages = vec![ChatMessage::text(
            "system",
            self.inner.system_prompt.clone(),
        )];
        push_skill(&mut messages, skill);
        if !grounding.trim().is_empty() {
            messages.push(ChatMessage::text("system", grounding.trim()));
        }
        messages.extend(self.history_messages(conversation_id));
        messages.push(ChatMessage::text("user", question));
        if spoken {
            let tune = ask_tune_ctx(true, self.inner.temperature, self.resident());
            if let Ok((text, reasoning)) = self.stream_content(&messages, tune, |_| {}).await {
                let text = text.trim().to_string();
                if !text.is_empty() {
                    self.stash_reasoning(conversation_id, Some(reasoning.as_str()));
                    return Ok(text);
                }
            }
        }
        let resp = self
            .chat(
                &messages,
                None,
                Some("none"),
                ask_tune_ctx(spoken, self.inner.temperature, self.resident()),
            )
            .await?;
        let msg = resp.choices.first().map(|c| &c.message);
        self.stash_reasoning(conversation_id, msg.and_then(|m| m.reasoning.as_deref()));
        let mut content = msg
            .map(|m| extract_assistant_text(m.content.as_deref(), m.reasoning.as_deref()))
            .unwrap_or_default();
        if content.is_empty() {
            content = "(no response)".into();
        }
        Ok(content)
    }

    pub async fn chat_for_intent(
        &self,
        user_message: &str,
        conversation_id: Option<&str>,
        spoken: bool,
        skill: Option<&str>,
    ) -> Result<IntentResult, String> {
        self.chat_for_intent_with(
            user_message,
            conversation_id,
            spoken,
            skill,
            &music_control_tools(),
            &intent_system_prompt(&self.inner.system_prompt),
        )
        .await
    }

    /// Same turn as `chat_for_intent`, with the caller's tools and system prompt.
    /// The handset passes the eight music tools and `handset_intent_prompt`.
    pub async fn chat_for_intent_with(
        &self,
        user_message: &str,
        conversation_id: Option<&str>,
        spoken: bool,
        skill: Option<&str>,
        tools: &[Value],
        system_prompt: &str,
    ) -> Result<IntentResult, String> {
        let mut messages = vec![ChatMessage::text("system", system_prompt)];
        push_skill(&mut messages, skill);
        messages.extend(self.history_messages(conversation_id));
        messages.push(ChatMessage::text("user", user_message));
        let resp = self
            .chat(
                &messages,
                Some(tools.to_vec()),
                Some(choice_for_tools(user_message, tools)),
                tune_for_tools(spoken, self.inner.temperature, self.resident(), tools),
            )
            .await?;
        let msg = resp.choices.first().map(|c| &c.message);
        let tool_calls = msg
            .and_then(|m| m.tool_calls.as_ref())
            .map(|calls| parse_tool_calls(calls))
            .unwrap_or_default();
        let reasoning = msg.and_then(|m| m.reasoning.as_deref());
        if !tool_calls.is_empty() {
            let content = msg.and_then(|m| m.content.as_ref().map(|s| s.trim().to_string()));
            let recorded = content
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| summarize_tool_calls(&tool_calls));
            self.stash_reasoning(conversation_id, reasoning);
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
            self.stash_reasoning(conversation_id, reasoning);
            self.record(conversation_id, user_message, c);
        }
        Ok(IntentResult {
            content,
            tool_calls: Vec::new(),
        })
    }

    /// One more completion. Tool results are `role: tool` messages, not user text.
    pub async fn chat_follow_up(
        &self,
        user_message: &str,
        conversation_id: Option<&str>,
        spoken: bool,
        skill: Option<&str>,
        tools: &[Value],
        system_prompt: &str,
        calls: &[IntentToolCall],
        results: &[ToolResultTurn],
    ) -> Result<IntentResult, String> {
        let mut messages = vec![ChatMessage::text("system", system_prompt)];
        push_skill(&mut messages, skill);
        let prior_reasoning = self.latest_assistant_reasoning(conversation_id);
        messages.extend(self.history_messages(conversation_id));
        messages.extend(tool_round_messages(
            user_message,
            calls,
            results,
            prior_reasoning.as_deref(),
        ));
        let resp = self
            .chat(
                &messages,
                Some(tools.to_vec()),
                Some("auto"),
                tune_for_tools(spoken, self.inner.temperature, self.resident(), tools),
            )
            .await?;
        let msg = resp.choices.first().map(|c| &c.message);
        let tool_calls = msg
            .and_then(|m| m.tool_calls.as_ref())
            .map(|calls| parse_tool_calls(calls))
            .unwrap_or_default();
        let content = msg
            .and_then(|m| m.content.as_ref())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        Ok(IntentResult {
            content,
            tool_calls,
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
            .map(|list| history_to_messages(list))
            .unwrap_or_default()
    }

    fn stash_reasoning(&self, conversation_id: Option<&str>, reasoning: Option<&str>) {
        let Some(key) = conversation_id.filter(|s| !s.is_empty()) else {
            return;
        };
        let mut pending = self.inner.pending_reasoning.lock().expect("reasoning");
        match reasoning.map(str::trim).filter(|s| !s.is_empty()) {
            Some(text) => {
                pending.insert(key.to_string(), text.to_string());
            }
            None => {
                pending.remove(key);
            }
        }
    }

    fn take_reasoning(&self, key: &str) -> Option<String> {
        self.inner
            .pending_reasoning
            .lock()
            .expect("reasoning")
            .remove(key)
    }

    fn latest_assistant_reasoning(&self, conversation_id: Option<&str>) -> Option<String> {
        let key = conversation_id.filter(|s| !s.is_empty())?;
        let map = self.inner.history.lock().expect("history");
        map.get(key).and_then(|list| {
            list.iter()
                .rev()
                .find(|e| e.role == "assistant")
                .and_then(|e| e.reasoning.clone())
        })
    }

    fn record(&self, conversation_id: Option<&str>, user: &str, assistant: &str) {
        let Some(key) = conversation_id.filter(|s| !s.is_empty()) else {
            return;
        };
        let reasoning = self.take_reasoning(key);
        let mut map = self.inner.history.lock().expect("history");
        let list = map.entry(key.to_string()).or_default();
        list.push(HistoryEntry {
            role: "user",
            content: user.to_string(),
            reasoning: None,
        });
        list.push(HistoryEntry {
            role: "assistant",
            content: assistant.to_string(),
            reasoning,
        });
        const MAX_TURNS: usize = 20;
        while list.len() > MAX_TURNS * 2 {
            list.remove(0);
        }
    }
}

fn parse_tool_calls(calls: &[ApiToolCall]) -> Vec<IntentToolCall> {
    calls
        .iter()
        .enumerate()
        .map(|(i, tc)| IntentToolCall {
            id: if tc.id.trim().is_empty() {
                format!("call-{i}")
            } else {
                tc.id.clone()
            },
            name: tc.function.name.clone(),
            arguments: serde_json::from_str(&tc.function.arguments).unwrap_or_else(|_| json!({})),
        })
        .collect()
}

fn history_to_messages(list: &[HistoryEntry]) -> Vec<ChatMessage> {
    list.iter()
        .map(|e| {
            let reasoning = if e.role == "assistant" {
                e.reasoning.clone().filter(|s| !s.trim().is_empty())
            } else {
                None
            };
            ChatMessage {
                role: e.role.to_string(),
                content: Some(e.content.clone()),
                tool_calls: None,
                tool_call_id: None,
                reasoning_content: reasoning,
            }
        })
        .collect()
}

fn tool_round_messages(
    user_message: &str,
    calls: &[IntentToolCall],
    results: &[ToolResultTurn],
    reasoning: Option<&str>,
) -> Vec<ChatMessage> {
    let mut messages = vec![ChatMessage::text("user", user_message)];
    if calls.is_empty() {
        return messages;
    }
    let tool_calls: Vec<Value> = calls
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let id = if c.id.trim().is_empty() {
                format!("call-{i}")
            } else {
                c.id.clone()
            };
            json!({
                "id": id,
                "type": "function",
                "function": {
                    "name": c.name,
                    "arguments": c.arguments.to_string(),
                }
            })
        })
        .collect();
    let reasoning = reasoning.map(str::trim).filter(|s| !s.is_empty());
    messages.push(ChatMessage {
        role: "assistant".into(),
        content: None,
        tool_calls: Some(tool_calls),
        tool_call_id: None,
        reasoning_content: reasoning.map(str::to_string),
    });
    for (i, call) in calls.iter().enumerate() {
        let id = if call.id.trim().is_empty() {
            format!("call-{i}")
        } else {
            call.id.clone()
        };
        let content = results
            .iter()
            .find(|r| r.id == id)
            .map(|r| r.content.clone())
            .unwrap_or_else(|| "(no result)".into());
        messages.push(ChatMessage {
            role: "tool".into(),
            content: Some(content),
            tool_calls: None,
            tool_call_id: Some(id),
            reasoning_content: None,
        });
    }
    messages
}

/// Bearer for the Hermes API, from the service environment. Empty when unset.
/// The value stays out of `config.json` so the dashboard settings payload never includes it.
pub fn delegate_api_key_from_env() -> String {
    std::env::var("LLM_DELEGATE_API_KEY")
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Analyst completion on the delegate endpoint. Transport failure is `Err`.
/// `api_key` is sent as `Authorization: Bearer` when it is non-empty. Hermes
/// refuses the API server without that header, including on loopback.
pub async fn delegate_complete(
    base: &str,
    model: &str,
    task: &str,
    extra: &str,
    api_key: &str,
) -> Result<String, String> {
    let task = task.trim();
    if task.is_empty() {
        return Err("empty task".into());
    }
    let model = if model.trim().is_empty() {
        "hermes"
    } else {
        model.trim()
    };
    let mut user = task.to_string();
    if !extra.trim().is_empty() {
        user.push_str("\n\nAdditional context:\n");
        user.push_str(extra.trim());
    }
    let messages = vec![
        ChatMessage::text("system", ANALYST_SYSTEM),
        ChatMessage::text("user", user),
    ];
    let url = format!("{}/v1/chat/completions", normalize_llm_base_url(base));
    let payload = json!({
        "model": model,
        "messages": messages,
        "temperature": 0.3,
        "max_tokens": 4096,
        "stream": false,
        "tool_choice": "none",
        // Hermes reads this and turns its own scratchpad off for this call.
        "model_options": { "reasoning_effort": "none" },
    });
    let client = reqwest::Client::builder()
        .timeout(DELEGATE_TIMEOUT)
        .build()
        .map_err(|e| format!("LLM request failed: {e}"))?;
    let mut req = client.post(&url).header("content-type", "application/json");
    let api_key = api_key.trim();
    if !api_key.is_empty() {
        req = req.header("authorization", format!("Bearer {api_key}"));
    }
    let res = req
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("LLM request failed: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("LLM HTTP {status}"));
    }
    let body: ChatCompletionResponse = res
        .json()
        .await
        .map_err(|e| format!("LLM decode failed: {e}"))?;
    let msg = body.choices.first().map(|c| &c.message);
    let text = msg
        .map(|m| extract_assistant_text(m.content.as_deref(), m.reasoning.as_deref()))
        .unwrap_or_default();
    if text.trim().is_empty() {
        Err("empty analyst reply".into())
    } else {
        Ok(text)
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
    /// Used only by `chat_for_intent_with`. The four-arg path does not call it.
    pub chat_for_intent_with:
        Option<Arc<dyn Fn(&str, &[Value]) -> Result<IntentResult, String> + Send + Sync>>,
    /// Shared across `Clone` so a test can delay the handset turn after the brain is built.
    pub intent_delay_ms: Arc<AtomicU64>,
    /// Finished ask replies, when a test wants to see what was stored.
    pub history: Option<Arc<Mutex<Vec<(String, String)>>>>,
}

impl ScriptedLlm {
    pub fn ask_only(reply: impl Fn(&str) -> String + Send + Sync + 'static) -> Self {
        Self {
            ask: Arc::new(move |q| Ok(reply(q))),
            chat_for_intent: None,
            chat_for_intent_with: None,
            intent_delay_ms: Arc::new(AtomicU64::new(0)),
            history: None,
        }
    }

    pub fn with_history(mut self, history: Arc<Mutex<Vec<(String, String)>>>) -> Self {
        self.history = Some(history);
        self
    }

    pub fn with_intent(
        reply: impl Fn(&str) -> String + Send + Sync + 'static,
        intent: impl Fn(&str) -> IntentResult + Send + Sync + 'static,
    ) -> Self {
        Self {
            ask: Arc::new(move |q| Ok(reply(q))),
            chat_for_intent: Some(Arc::new(move |q| Ok(intent(q)))),
            chat_for_intent_with: None,
            intent_delay_ms: Arc::new(AtomicU64::new(0)),
            history: None,
        }
    }

    pub fn with_intent_tools(
        reply: impl Fn(&str) -> String + Send + Sync + 'static,
        intent: impl Fn(&str, &[Value]) -> IntentResult + Send + Sync + 'static,
    ) -> Self {
        Self {
            ask: Arc::new(move |q| Ok(reply(q))),
            chat_for_intent: None,
            chat_for_intent_with: Some(Arc::new(move |q, tools| Ok(intent(q, tools)))),
            intent_delay_ms: Arc::new(AtomicU64::new(0)),
            history: None,
        }
    }

    pub fn set_intent_delay(&self, ms: u64) {
        self.intent_delay_ms.store(ms, Ordering::Relaxed);
    }
}

#[derive(Clone)]
pub enum LlmBackend {
    OpenAi(OpenAiLlm),
    Scripted(ScriptedLlm),
}

impl LlmBackend {
    pub fn set_talker_resident(&self, on: bool) {
        if let Self::OpenAi(c) = self {
            c.set_talker_resident(on);
        }
    }

    pub async fn ask(
        &self,
        question: &str,
        conversation_id: Option<&str>,
        spoken: bool,
        skill: Option<&str>,
        grounding: &str,
    ) -> Result<String, String> {
        match self {
            Self::OpenAi(c) => {
                c.ask(question, conversation_id, spoken, skill, grounding)
                    .await
            }
            Self::Scripted(s) => (s.ask)(question),
        }
    }

    /// Store the reply the caller will show. `ask` itself does not record, so
    /// a stripped sources footer is what the next turn sees.
    pub fn record_exchange(&self, conversation_id: Option<&str>, user: &str, assistant: &str) {
        match self {
            Self::OpenAi(c) => c.record(conversation_id, user, assistant),
            Self::Scripted(s) => {
                let Some(history) = &s.history else {
                    return;
                };
                let Some(key) = conversation_id.filter(|id| !id.is_empty()) else {
                    return;
                };
                history
                    .lock()
                    .expect("scripted history")
                    .push((format!("{key}\n{user}"), assistant.to_string()));
            }
        }
    }

    pub async fn chat_for_intent(
        &self,
        user_message: &str,
        conversation_id: Option<&str>,
        spoken: bool,
        skill: Option<&str>,
    ) -> Result<IntentResult, String> {
        match self {
            Self::OpenAi(c) => {
                c.chat_for_intent(user_message, conversation_id, spoken, skill)
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

    pub async fn chat_for_intent_with(
        &self,
        user_message: &str,
        conversation_id: Option<&str>,
        spoken: bool,
        skill: Option<&str>,
        tools: &[Value],
        system_prompt: &str,
    ) -> Result<IntentResult, String> {
        match self {
            Self::OpenAi(c) => {
                c.chat_for_intent_with(
                    user_message,
                    conversation_id,
                    spoken,
                    skill,
                    tools,
                    system_prompt,
                )
                .await
            }
            Self::Scripted(s) => {
                let ms = s.intent_delay_ms.load(Ordering::Relaxed);
                if ms > 0 {
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                }
                if let Some(f) = &s.chat_for_intent_with {
                    return f(user_message, tools);
                }
                match &s.chat_for_intent {
                    Some(f) => f(user_message),
                    None => Ok(IntentResult {
                        content: Some((s.ask)(user_message)?),
                        tool_calls: Vec::new(),
                    }),
                }
            }
        }
    }

    pub async fn chat_follow_up(
        &self,
        user_message: &str,
        conversation_id: Option<&str>,
        spoken: bool,
        skill: Option<&str>,
        tools: &[Value],
        system_prompt: &str,
        calls: &[IntentToolCall],
        results: &[ToolResultTurn],
    ) -> Result<IntentResult, String> {
        match self {
            Self::OpenAi(c) => {
                c.chat_follow_up(
                    user_message,
                    conversation_id,
                    spoken,
                    skill,
                    tools,
                    system_prompt,
                    calls,
                    results,
                )
                .await
            }
            Self::Scripted(_) => Ok(IntentResult {
                content: None,
                tool_calls: Vec::new(),
            }),
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
        ChatMessage::text("user", "hi")
    }

    #[test]
    fn music_request_requires_a_tool_and_banter_stays_auto() {
        assert_eq!(tool_choice_for("play something chill"), "required");
        assert_eq!(tool_choice_for("put on the beatles"), "required");
        assert_eq!(tool_choice_for("how are you"), "auto");
        assert_eq!(tool_choice_for("!ask what is doctrine"), "auto");
        let library = json!({"function": {"name": "edit_library_doc"}});
        let play = json!({"function": {"name": "play_music"}});
        assert_eq!(choice_for_tools("play the charter", &[library]), "auto");
        assert_eq!(
            choice_for_tools("play the charter", &[play.clone()]),
            "required"
        );
        assert_eq!(
            tune_for_tools(false, 0.2, false, &[play]).max_tokens,
            LLM_INTENT_MAX_TOKENS
        );
        let docs = json!({"function": {"name": "read_library_doc"}});
        assert_eq!(
            tune_for_tools(false, 0.2, false, &[docs]).max_tokens,
            LLM_ASK_MAX_TOKENS
        );
        assert_eq!(
            tune_for_tools(
                true,
                0.2,
                false,
                &[json!({"function": {"name": "list_library_docs"}})]
            )
            .max_tokens,
            LLM_VOICE_MAX_TOKENS
        );
    }

    #[test]
    fn follow_up_uses_tool_role_and_keeps_the_user_text() {
        let calls = vec![IntentToolCall {
            id: "call-1".into(),
            name: "play_music".into(),
            arguments: json!({"query": "misty"}),
        }];
        let results = vec![ToolResultTurn {
            id: "call-1".into(),
            content: "No results found for: misty".into(),
        }];
        let messages = tool_round_messages("play misty", &calls, &results, Some("look up misty"));
        let body = serde_json::to_string(&messages).unwrap();
        assert!(body.contains("\"role\":\"tool\""));
        assert!(body.contains("\"tool_call_id\":\"call-1\""));
        assert!(body.contains("No results found for: misty"));
        assert!(!body.contains("Tool results:"));
        assert!(body.contains("play misty"));
        assert!(body.contains("\"reasoning_content\":\"look up misty\""));
    }

    #[test]
    fn history_sends_assistant_reasoning_back() {
        let list = vec![
            HistoryEntry {
                role: "user",
                content: "what is 2+2".into(),
                reasoning: None,
            },
            HistoryEntry {
                role: "assistant",
                content: "4".into(),
                reasoning: Some("2+2 is 4".into()),
            },
        ];
        let body = serde_json::to_string(&history_to_messages(&list)).unwrap();
        assert!(body.contains("\"reasoning_content\":\"2+2 is 4\""));
        assert!(!body.contains("\"reasoning_content\":null"));
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
                effort: "none",
                num_ctx: Some(LLM_NUM_CTX),
                flash_attention: true,
                stream: false,
            },
        );
        assert_eq!(off["chat_template_kwargs"]["enable_thinking"], false);
        assert_eq!(off["chat_template_kwargs"]["reasoning_effort"], "none");
        assert_eq!(off["reasoning_effort"], "none");
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
                effort: "high",
                num_ctx: Some(LLM_NUM_CTX),
                flash_attention: true,
                stream: false,
            },
        );
        assert_eq!(on["think"], true);
        assert_eq!(on["chat_template_kwargs"]["enable_thinking"], true);
        assert_eq!(on["reasoning_effort"], "high");
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
                effort: "none",
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
        assert_eq!(voice.effort, "minimal");
        assert_eq!(voice.num_ctx, Some(LLM_NUM_CTX));
        assert!(voice.flash_attention);
        let typed = ask_tune(false, 0.2);
        assert_eq!(typed.max_tokens, LLM_ASK_MAX_TOKENS);
        assert_eq!(typed.think, Some(false));
        assert_eq!(typed.effort, "high");
        assert_eq!(typed.num_ctx, Some(LLM_NUM_CTX));
        let intent = intent_tune(false, 0.2);
        assert_eq!(intent.max_tokens, LLM_INTENT_MAX_TOKENS);
        assert_eq!(intent.think, Some(false));
        assert_eq!(intent.effort, "high");
        assert_eq!(intent.num_ctx, Some(LLM_NUM_CTX));
        let spoken_intent = intent_tune(true, 0.2);
        assert_eq!(spoken_intent.max_tokens, LLM_VOICE_MAX_TOKENS);
        assert_eq!(spoken_intent.think, Some(false));
        assert_eq!(spoken_intent.effort, "minimal");
        let resident = ask_tune_ctx(false, 0.2, true);
        assert_eq!(resident.num_ctx, Some(TALKER_RESIDENT_NUM_CTX));
        assert_eq!(penny_num_ctx(false), LLM_NUM_CTX);
        let mut skill_msgs = vec![msg()];
        push_skill(&mut skill_msgs, Some("Prefer local."));
        assert!(
            skill_msgs[1]
                .content
                .as_deref()
                .unwrap()
                .contains("Prefer local.")
        );
        let unload = ollama_unload_body("gemma-test");
        assert_eq!(unload["model"], "gemma-test");
        assert_eq!(unload["prompt"], "");
        assert_eq!(unload["keep_alive"], 0);
        assert_eq!(unload["stream"], false);
    }

    #[test]
    fn voice_intent_tune_keeps_num_ctx() {
        assert_eq!(LLM_NUM_CTX, 32_768);
        assert_eq!(LLM_INTENT_MAX_TOKENS, 1024);
        assert_eq!(LLM_VOICE_MAX_TOKENS, 384);
        assert_eq!(TALKER_RESIDENT_NUM_CTX, 8_192);
        let voice = intent_tune_ctx(true, 0.2, false);
        assert_eq!(voice.max_tokens, LLM_VOICE_MAX_TOKENS);
        assert_eq!(voice.num_ctx, Some(LLM_NUM_CTX));
        assert_eq!(voice.think, Some(false));
        assert_eq!(voice.effort, "minimal");
        let typed = intent_tune_ctx(false, 0.2, false);
        assert_eq!(typed.max_tokens, LLM_INTENT_MAX_TOKENS);
        assert_eq!(typed.num_ctx, Some(LLM_NUM_CTX));
        let resident = intent_tune_ctx(true, 0.2, true);
        assert_eq!(resident.max_tokens, LLM_VOICE_MAX_TOKENS);
        assert_eq!(resident.num_ctx, Some(TALKER_RESIDENT_NUM_CTX));
    }

    #[tokio::test]
    async fn scripted_intent_with_sees_tools_and_four_arg_does_not() {
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen2 = Arc::clone(&seen);
        let llm = ScriptedLlm::with_intent_tools(
            |_| "ask".into(),
            move |_q, tools| {
                *seen2.lock().expect("seen") = tools
                    .iter()
                    .filter_map(|t| t["function"]["name"].as_str().map(str::to_string))
                    .collect();
                IntentResult {
                    content: Some("with".into()),
                    tool_calls: Vec::new(),
                }
            },
        );
        let pace = llm.clone();
        pace.set_intent_delay(60_000);
        let backend = LlmBackend::Scripted(llm);
        let four = tokio::time::timeout(
            Duration::from_millis(200),
            backend.chat_for_intent("hi", None, false, None),
        )
        .await
        .expect("four-arg must not sleep")
        .unwrap();
        assert_eq!(four.content.as_deref(), Some("ask"));
        assert!(seen.lock().expect("seen").is_empty());

        let tools = vec![json!({ "function": { "name": "pause" } })];
        let with = tokio::time::timeout(
            Duration::from_millis(200),
            backend.chat_for_intent_with("hi", None, true, None, &tools, "pocket"),
        )
        .await;
        assert!(with.is_err(), "tools path sleeps before the callback");
        assert!(seen.lock().expect("seen").is_empty());

        pace.set_intent_delay(0);
        let with = backend
            .chat_for_intent_with("hi", None, true, None, &tools, "pocket")
            .await
            .unwrap();
        assert_eq!(with.content.as_deref(), Some("with"));
        assert_eq!(seen.lock().expect("seen").as_slice(), ["pause"]);
    }

    #[tokio::test]
    async fn delegate_complete_sends_bearer_only_when_set() {
        let with_key = serve_delegate().await;
        let reply = delegate_complete(&with_key.base, "hermes-agent", "status", "", "secret-token")
            .await
            .expect("bearer call");
        assert_eq!(reply, "ack");
        let req = with_key.request.await.expect("request");
        assert!(
            req.to_ascii_lowercase()
                .contains("authorization: bearer secret-token")
        );

        let bare = serve_delegate().await;
        let reply = delegate_complete(&bare.base, "hermes-agent", "status", "", "")
            .await
            .expect("open call");
        assert_eq!(reply, "ack");
        let req = bare.request.await.expect("request");
        assert!(!req.to_ascii_lowercase().contains("authorization:"));
    }

    struct DelegateProbe {
        base: String,
        request: tokio::task::JoinHandle<String>,
    }

    async fn serve_delegate() -> DelegateProbe {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let request = tokio::task::spawn_blocking(move || {
            use std::io::{Read, Write};
            let (mut sock, _) = listener.accept().expect("accept");
            sock.set_read_timeout(Some(Duration::from_secs(5))).ok();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 2048];
            loop {
                match sock.read(&mut tmp) {
                    Ok(0) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&tmp[..n]);
                        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let body = br#"{"choices":[{"message":{"content":"ack","reasoning":null}}]}"#;
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            sock.write_all(head.as_bytes()).ok();
            sock.write_all(body).ok();
            String::from_utf8_lossy(&buf).into_owned()
        });
        DelegateProbe {
            base: format!("http://{addr}"),
            request,
        }
    }
}
