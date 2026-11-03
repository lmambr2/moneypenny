// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! In-process brain: local LLM + optional RAG. Never executes tools.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::llm::{LlmBackend, ScriptedLlm};
use crate::types::{
    Brain, BrainError, ToolProposal, TurnChannel, TurnMode, TurnRequest, TurnResponse, TurnSource,
    empty_turn,
};

#[derive(Debug, Clone, Default)]
pub struct RetrieveCtx {
    pub allowed_classifications: Option<Vec<String>>,
    pub user_uid: Option<String>,
}

pub type RetrieveFn = Arc<
    dyn Fn(
            String,
            RetrieveCtx,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<TurnSource>, String>> + Send>>
        + Send
        + Sync,
>;

pub type IdFn = Arc<dyn Fn() -> String + Send + Sync>;

#[derive(Clone)]
pub struct InProcessBrain {
    llm: Option<LlmBackend>,
    retrieve: Option<RetrieveFn>,
    id_factory: IdFn,
    delegate_url: String,
    delegate_model: String,
}

impl InProcessBrain {
    pub fn new(llm: Option<LlmBackend>) -> Self {
        Self {
            llm,
            retrieve: None,
            id_factory: default_id_factory(),
            delegate_url: String::new(),
            delegate_model: String::new(),
        }
    }

    pub fn with_delegate(mut self, url: impl Into<String>, model: impl Into<String>) -> Self {
        self.delegate_url = url.into();
        self.delegate_model = model.into();
        self
    }

    pub fn scripted(llm: ScriptedLlm) -> Self {
        Self::new(Some(LlmBackend::Scripted(llm)))
    }

    pub fn disabled() -> Self {
        Self::new(None)
    }

    pub fn with_retrieve(mut self, retrieve: RetrieveFn) -> Self {
        self.retrieve = Some(retrieve);
        self
    }

    pub fn set_delta_hook(&self, hook: Option<Arc<dyn Fn(&str) + Send + Sync>>) {
        if let Some(crate::llm::LlmBackend::OpenAi(llm)) = &self.llm {
            llm.set_delta_hook(hook);
        }
    }

    pub fn set_talker_resident(&self, on: bool) {
        if let Some(llm) = &self.llm {
            llm.set_talker_resident(on);
        }
    }

    pub fn with_id_factory(mut self, f: impl Fn() -> String + Send + Sync + 'static) -> Self {
        self.id_factory = Arc::new(f);
        self
    }

    fn next_id(&self) -> String {
        (self.id_factory)()
    }
}

impl Brain for InProcessBrain {
    async fn turn(&self, req: TurnRequest) -> Result<TurnResponse, BrainError> {
        Ok(self.complete(req).await)
    }
}

impl InProcessBrain {
    pub async fn complete(&self, req: TurnRequest) -> TurnResponse {
        let turn_id = self.next_id();
        let text = req.text.trim();
        let mode = match req.mode {
            Some(TurnMode::Intent) => TurnMode::Intent,
            Some(TurnMode::Delegate) => TurnMode::Delegate,
            _ => TurnMode::Ask,
        };
        let include_sources = req
            .options
            .as_ref()
            .and_then(|o| o.include_sources)
            .unwrap_or(true);
        let max_tools = req
            .options
            .as_ref()
            .and_then(|o| o.max_tools)
            .unwrap_or(4)
            .clamp(0, 16) as usize;

        if text.is_empty() {
            return empty_turn(turn_id, &req, "text is required");
        }
        if mode == TurnMode::Delegate {
            return self.delegate_turn(turn_id, &req, text).await;
        }
        let Some(llm) = self.llm.as_ref() else {
            return empty_turn(turn_id, &req, "LLM is not enabled");
        };

        let mut sources: Vec<TurnSource> = Vec::new();
        if include_sources {
            if let Some(retrieve) = self.retrieve.as_ref() {
                let ctx = RetrieveCtx {
                    allowed_classifications: req
                        .subject
                        .as_ref()
                        .and_then(|s| s.allowed_classifications.clone()),
                    user_uid: req.subject.as_ref().and_then(|s| s.uid.clone()),
                };
                match retrieve(text.to_string(), ctx).await {
                    Ok(chunks) => sources = chunks,
                    Err(msg) => {
                        return empty_turn(turn_id, &req, format!("RAG retrieval failed: {msg}"));
                    }
                }
            }
        }

        let spoken = req.channel == TurnChannel::Voice;
        let skill = req.skill.as_deref();
        if mode == TurnMode::Intent && llm.has_intent() {
            return match llm
                .chat_for_intent(text, req.conversation_id.as_deref(), spoken, skill)
                .await
            {
                Ok(intent) => {
                    let tool_proposals: Vec<ToolProposal> = intent
                        .tool_calls
                        .into_iter()
                        .take(max_tools)
                        .map(|tc| ToolProposal {
                            name: tc.name,
                            arguments: if tc.arguments.is_object() {
                                tc.arguments
                            } else {
                                serde_json::json!({})
                            },
                            id: if tc.id.trim().is_empty() {
                                None
                            } else {
                                Some(tc.id)
                            },
                            reason: None,
                        })
                        .collect();
                    TurnResponse {
                        turn_id,
                        client_turn_id: req.client_turn_id.clone(),
                        reply_text: intent.content.unwrap_or_default().trim().to_string(),
                        sources,
                        tool_proposals,
                        error: None,
                    }
                }
                Err(msg) => TurnResponse {
                    turn_id,
                    client_turn_id: req.client_turn_id.clone(),
                    reply_text: String::new(),
                    sources,
                    tool_proposals: Vec::new(),
                    error: Some(format!("Intent failed: {msg}")),
                },
            };
        }

        match llm
            .ask(text, req.conversation_id.as_deref(), spoken, skill)
            .await
        {
            Ok(reply) => TurnResponse {
                turn_id,
                client_turn_id: req.client_turn_id.clone(),
                reply_text: reply,
                sources,
                tool_proposals: Vec::new(),
                error: None,
            },
            Err(msg) => TurnResponse {
                turn_id,
                client_turn_id: req.client_turn_id.clone(),
                reply_text: String::new(),
                sources,
                tool_proposals: Vec::new(),
                error: Some(format!("LLM ask failed: {msg}")),
            },
        }
    }

    /// Caller supplies the tool list and system prompt. No retrieval and no
    /// `intent_system_prompt`. An empty model is the string `LLM is not enabled`.
    pub async fn complete_with_tools(
        &self,
        req: TurnRequest,
        tools: &[serde_json::Value],
        system_prompt: &str,
    ) -> TurnResponse {
        let turn_id = self.next_id();
        let text = req.text.trim();
        let max_tools = req
            .options
            .as_ref()
            .and_then(|o| o.max_tools)
            .unwrap_or(4)
            .clamp(0, 16) as usize;
        if text.is_empty() {
            return empty_turn(turn_id, &req, "text is required");
        }
        let Some(llm) = self.llm.as_ref() else {
            return empty_turn(turn_id, &req, "LLM is not enabled");
        };
        let spoken = req.channel == TurnChannel::Voice;
        match llm
            .chat_for_intent_with(
                text,
                req.conversation_id.as_deref(),
                spoken,
                req.skill.as_deref(),
                tools,
                system_prompt,
            )
            .await
        {
            Ok(intent) => {
                let tool_proposals: Vec<ToolProposal> = intent
                    .tool_calls
                    .into_iter()
                    .take(max_tools)
                    .map(|tc| ToolProposal {
                        name: tc.name,
                        arguments: if tc.arguments.is_object() {
                            tc.arguments
                        } else {
                            serde_json::json!({})
                        },
                        id: if tc.id.trim().is_empty() {
                            None
                        } else {
                            Some(tc.id)
                        },
                        reason: None,
                    })
                    .collect();
                TurnResponse {
                    turn_id,
                    client_turn_id: req.client_turn_id.clone(),
                    reply_text: intent.content.unwrap_or_default().trim().to_string(),
                    sources: Vec::new(),
                    tool_proposals,
                    error: None,
                }
            }
            Err(msg) => TurnResponse {
                turn_id,
                client_turn_id: req.client_turn_id.clone(),
                reply_text: String::new(),
                sources: Vec::new(),
                tool_proposals: Vec::new(),
                error: Some(format!("Intent failed: {msg}")),
            },
        }
    }

    pub async fn complete_follow_up(
        &self,
        req: TurnRequest,
        tools: &[serde_json::Value],
        system_prompt: &str,
        calls: &[crate::llm::IntentToolCall],
        results: &[crate::llm::ToolResultTurn],
    ) -> TurnResponse {
        let turn_id = self.next_id();
        let text = req.text.trim();
        let max_tools = req
            .options
            .as_ref()
            .and_then(|o| o.max_tools)
            .unwrap_or(4)
            .clamp(0, 16) as usize;
        let Some(llm) = self.llm.as_ref() else {
            return empty_turn(turn_id, &req, "LLM is not enabled");
        };
        let spoken = req.channel == TurnChannel::Voice;
        match llm
            .chat_follow_up(
                text,
                req.conversation_id.as_deref(),
                spoken,
                req.skill.as_deref(),
                tools,
                system_prompt,
                calls,
                results,
            )
            .await
        {
            Ok(intent) => intent_response(turn_id, &req, intent, max_tools),
            Err(msg) => TurnResponse {
                turn_id,
                client_turn_id: req.client_turn_id.clone(),
                reply_text: String::new(),
                sources: Vec::new(),
                tool_proposals: Vec::new(),
                error: Some(format!("Intent failed: {msg}")),
            },
        }
    }

    async fn delegate_turn(&self, turn_id: String, req: &TurnRequest, text: &str) -> TurnResponse {
        if self.delegate_url.trim().is_empty() {
            return TurnResponse {
                turn_id,
                client_turn_id: req.client_turn_id.clone(),
                reply_text: crate::llm::DELEGATE_UNCONFIGURED.into(),
                sources: Vec::new(),
                tool_proposals: Vec::new(),
                error: None,
            };
        }
        match crate::llm::delegate_complete(&self.delegate_url, &self.delegate_model, text, "").await
        {
            Ok(reply) => TurnResponse {
                turn_id,
                client_turn_id: req.client_turn_id.clone(),
                reply_text: reply,
                sources: Vec::new(),
                tool_proposals: Vec::new(),
                error: None,
            },
            Err(_) => TurnResponse {
                turn_id,
                client_turn_id: req.client_turn_id.clone(),
                reply_text: crate::llm::ANALYST_OFFLINE.into(),
                sources: Vec::new(),
                tool_proposals: Vec::new(),
                error: None,
            },
        }
    }
}

fn intent_response(
    turn_id: String,
    req: &TurnRequest,
    intent: crate::llm::IntentResult,
    max_tools: usize,
) -> TurnResponse {
    let tool_proposals = intent
        .tool_calls
        .into_iter()
        .take(max_tools)
        .map(|tc| ToolProposal {
            name: tc.name,
            arguments: if tc.arguments.is_object() {
                tc.arguments
            } else {
                serde_json::json!({})
            },
            id: if tc.id.trim().is_empty() {
                None
            } else {
                Some(tc.id)
            },
            reason: None,
        })
        .collect();
    TurnResponse {
        turn_id,
        client_turn_id: req.client_turn_id.clone(),
        reply_text: intent.content.unwrap_or_default().trim().to_string(),
        sources: Vec::new(),
        tool_proposals,
        error: None,
    }
}

fn default_id_factory() -> IdFn {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    Arc::new(|| {
        let n = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("brain-{ms:x}-{n}")
    })
}
