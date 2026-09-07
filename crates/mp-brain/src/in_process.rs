// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! In-process brain: local LLM + optional RAG. Never executes tools.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::llm::{LlmBackend, ScriptedLlm};
use crate::types::{
    empty_turn, Brain, BrainError, ToolProposal, TurnMode, TurnRequest, TurnResponse, TurnSource,
};

pub type RetrieveFn = Arc<
    dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<Vec<TurnSource>, String>> + Send>>
        + Send
        + Sync,
>;

pub type IdFn = Arc<dyn Fn() -> String + Send + Sync>;

#[derive(Clone)]
pub struct InProcessBrain {
    llm: Option<LlmBackend>,
    retrieve: Option<RetrieveFn>,
    id_factory: IdFn,
}

impl InProcessBrain {
    pub fn new(llm: Option<LlmBackend>) -> Self {
        Self {
            llm,
            retrieve: None,
            id_factory: default_id_factory(),
        }
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
        let Some(llm) = self.llm.as_ref() else {
            return empty_turn(turn_id, &req, "LLM is not enabled");
        };
        if mode == TurnMode::Delegate {
            return empty_turn(
                turn_id,
                &req,
                "delegate mode is not handled by the brain transport; use ControlRouter !analyst",
            );
        }

        let mut sources: Vec<TurnSource> = Vec::new();
        if include_sources {
            if let Some(retrieve) = self.retrieve.as_ref() {
                match retrieve(text.to_string()).await {
                    Ok(chunks) => sources = chunks,
                    Err(msg) => {
                        return empty_turn(turn_id, &req, format!("RAG retrieval failed: {msg}"));
                    }
                }
            }
        }

        if mode == TurnMode::Intent && llm.has_intent() {
            return match llm.chat_for_intent(text, req.conversation_id.as_deref()).await {
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

        match llm.ask(text, req.conversation_id.as_deref()).await {
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
