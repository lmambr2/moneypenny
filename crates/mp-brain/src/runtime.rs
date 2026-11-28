// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use std::sync::Arc;
use tokio::sync::RwLock;

use serde_json::Value;

use crate::complete::complete_turn;
use crate::factory::{BrainTransport, transport_from_settings};
use crate::in_process::{InProcessBrain, RetrieveFn};
use crate::llm::LlmSettings;
use crate::types::{TurnRequest, TurnResponse};

/// Process-wide brain handle. `BRAIN_URL` vs in-process is resolved at build
/// time; `update_llm` rebuilds the in-process client when Settings change.
pub struct BrainRuntime {
    inner: RwLock<Inner>,
}

pub type PlainHook = std::sync::Arc<dyn Fn(&str, &str) -> Option<String> + Send + Sync>;

struct Inner {
    settings: LlmSettings,
    transport: BrainTransport,
    retrieve: Option<RetrieveFn>,
    plain_hook: Option<PlainHook>,
}

impl BrainRuntime {
    pub fn from_settings(settings: LlmSettings) -> Arc<Self> {
        let transport = transport_from_settings(&settings);
        Arc::new(Self {
            inner: RwLock::new(Inner {
                settings,
                transport,
                retrieve: None,
                plain_hook: None,
            }),
        })
    }

    pub fn with_transport(transport: BrainTransport) -> Arc<Self> {
        Arc::new(Self {
            inner: RwLock::new(Inner {
                settings: LlmSettings::default(),
                transport,
                retrieve: None,
                plain_hook: None,
            }),
        })
    }

    pub fn in_process(brain: InProcessBrain) -> Arc<Self> {
        Self::with_transport(BrainTransport::InProcess(brain))
    }

    pub fn disabled() -> Arc<Self> {
        Self::in_process(InProcessBrain::disabled())
    }

    pub async fn complete(&self, req: TurnRequest) -> TurnResponse {
        let transport = self.inner.read().await.transport.clone();
        complete_turn(req, &transport).await
    }

    pub async fn transport_is_in_process(&self) -> bool {
        let g = self.inner.read().await;
        matches!(&g.transport, BrainTransport::InProcess(_))
    }

    /// In-process only. A remote brain returns `BRAIN_REMOTE` and is not called.
    pub async fn complete_with_tools(
        &self,
        req: TurnRequest,
        tools: &[Value],
        system_prompt: &str,
    ) -> TurnResponse {
        let transport = self.inner.read().await.transport.clone();
        match transport {
            BrainTransport::InProcess(brain) => {
                brain.complete_with_tools(req, tools, system_prompt).await
            }
            BrainTransport::Http(_) => TurnResponse {
                turn_id: "remote".into(),
                client_turn_id: req.client_turn_id,
                reply_text: String::new(),
                sources: Vec::new(),
                tool_proposals: Vec::new(),
                error: Some("BRAIN_REMOTE".into()),
            },
        }
    }

    pub async fn persona(&self) -> String {
        self.inner.read().await.settings.persona().to_string()
    }

    pub async fn delegate_endpoint(&self) -> (String, String) {
        let g = self.inner.read().await;
        (
            g.settings.delegate_url.clone(),
            g.settings.delegate_model.clone(),
        )
    }

    /// Follow-up completion. Tool results stay on `role: tool`.
    pub async fn complete_follow_up(
        &self,
        req: TurnRequest,
        tools: &[Value],
        system_prompt: &str,
        calls: &[crate::llm::IntentToolCall],
        results: &[crate::llm::ToolResultTurn],
    ) -> TurnResponse {
        let transport = self.inner.read().await.transport.clone();
        match transport {
            BrainTransport::InProcess(brain) => {
                brain
                    .complete_follow_up(req, tools, system_prompt, calls, results)
                    .await
            }
            BrainTransport::Http(_) => TurnResponse {
                turn_id: "remote".into(),
                client_turn_id: req.client_turn_id,
                reply_text: String::new(),
                sources: Vec::new(),
                tool_proposals: Vec::new(),
                error: Some("BRAIN_REMOTE".into()),
            },
        }
    }

    /// While Talker weights are resident, penny chat uses the 8k window.
    pub async fn set_talker_resident(&self, on: bool) {
        let transport = self.inner.read().await.transport.clone();
        if let crate::factory::BrainTransport::InProcess(brain) = transport {
            brain.set_talker_resident(on);
        }
    }

    pub async fn set_delta_hook(&self, hook: Option<std::sync::Arc<dyn Fn(&str) + Send + Sync>>) {
        let transport = self.inner.read().await.transport.clone();
        if let crate::factory::BrainTransport::InProcess(brain) = transport {
            brain.set_delta_hook(hook);
        }
    }

    pub async fn set_plain_hook(&self, hook: Option<PlainHook>) {
        self.inner.write().await.plain_hook = hook;
    }

    /// Custom-system completion (roast grader). Never used on skip.
    /// Returns None when LLM is disabled or the request fails (fail-open).
    pub async fn complete_plain(&self, system: &str, user: &str) -> Option<String> {
        let (settings, hook) = {
            let g = self.inner.read().await;
            if !g.settings.enabled {
                return None;
            }
            (g.settings.clone(), g.plain_hook.clone())
        };
        if let Some(hook) = hook {
            return hook(system, user)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
        }
        let llm = crate::llm::OpenAiLlm::from_settings(&settings);
        llm.complete_system(system, user)
            .await
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    /// Ollama keep_alive 0. No-op when the chat model is disabled. 404/405 ignored.
    pub async fn unload(&self) {
        let settings = {
            let g = self.inner.read().await;
            if !g.settings.enabled || g.settings.url.trim().is_empty() {
                return;
            }
            g.settings.clone()
        };
        let llm = crate::llm::OpenAiLlm::from_settings(&settings);
        if let Err(e) = llm.unload().await {
            tracing::warn!(error = %e, "LLM idle unload failed");
        }
    }

    /// One-token warm after a human rejoins an unloaded channel.
    pub async fn warm(&self) {
        let settings = {
            let g = self.inner.read().await;
            if !g.settings.enabled || g.settings.url.trim().is_empty() {
                return;
            }
            g.settings.clone()
        };
        let llm = crate::llm::OpenAiLlm::from_settings(&settings);
        if let Err(e) = llm.warm().await {
            tracing::warn!(error = %e, "LLM idle warm failed");
        }
    }

    pub async fn llm_snapshot(&self) -> (bool, String, String) {
        let g = self.inner.read().await;
        (
            g.settings.enabled,
            g.settings.url.clone(),
            g.settings.model.clone(),
        )
    }

    /// Saved persona text (empty means the built-in default) and temperature.
    pub async fn llm_form_snapshot(&self) -> (String, f32) {
        let g = self.inner.read().await;
        (g.settings.system_prompt.clone(), g.settings.temperature)
    }

    pub async fn update_llm(
        &self,
        enabled: Option<bool>,
        url: Option<String>,
        model: Option<String>,
        system_prompt: Option<String>,
        temperature: Option<f32>,
        fallback_url: Option<String>,
        fallback_model: Option<String>,
        delegate_url: Option<String>,
        delegate_model: Option<String>,
    ) {
        let mut g = self.inner.write().await;
        if let Some(v) = enabled {
            g.settings.enabled = v;
        }
        if let Some(v) = url {
            g.settings.url = v;
        }
        if let Some(v) = model {
            g.settings.model = v;
        }
        if let Some(v) = system_prompt {
            g.settings.system_prompt = v;
        }
        if let Some(v) = temperature {
            g.settings.temperature = v;
        }
        if let Some(v) = fallback_url {
            g.settings.fallback_url = v;
        }
        if let Some(v) = fallback_model {
            g.settings.fallback_model = v;
        }
        if let Some(v) = delegate_url {
            g.settings.delegate_url = v;
        }
        if let Some(v) = delegate_model {
            g.settings.delegate_model = v;
        }
        rebuild_transport(&mut g);
    }

    pub async fn set_retrieve(&self, retrieve: RetrieveFn) {
        let mut g = self.inner.write().await;
        g.retrieve = Some(retrieve);
        rebuild_transport(&mut g);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::{HttpBrain, RawHttp};
    use crate::types::{TurnChannel, TurnMode};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn req() -> TurnRequest {
        TurnRequest {
            client_turn_id: Some("c".into()),
            channel: TurnChannel::Dashboard,
            text: "pause".into(),
            conversation_id: None,
            subject: None,
            mode: Some(TurnMode::Intent),
            options: None,
            skill: None,
        }
    }

    #[tokio::test]
    async fn remote_complete_with_tools_does_not_fetch() {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls2 = Arc::clone(&calls);
        let fetch: crate::http::FetchFn = Arc::new(move |_url, _body| {
            calls2.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                Ok(RawHttp {
                    status: 200,
                    body: b"{}".to_vec(),
                })
            })
        });
        let rt = BrainRuntime::with_transport(BrainTransport::Http(HttpBrain::with_fetch(
            "http://127.0.0.1:9",
            fetch,
        )));
        assert!(!rt.transport_is_in_process().await);
        let res = rt.complete_with_tools(req(), &[], "pocket").await;
        assert_eq!(res.error.as_deref(), Some("BRAIN_REMOTE"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}

fn rebuild_transport(inner: &mut Inner) {
    let mut transport = transport_from_settings(&inner.settings);
    if let Some(r) = inner.retrieve.clone() {
        if let BrainTransport::InProcess(b) = transport {
            transport = BrainTransport::InProcess(b.with_retrieve(r));
        }
    }
    inner.transport = transport;
}
