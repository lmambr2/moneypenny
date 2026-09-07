// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use std::sync::Arc;
use tokio::sync::RwLock;

use crate::complete::complete_turn;
use crate::factory::{transport_from_settings, BrainTransport};
use crate::in_process::{InProcessBrain, RetrieveFn};
use crate::llm::LlmSettings;
use crate::types::{TurnRequest, TurnResponse};

/// Process-wide brain handle. `BRAIN_URL` vs in-process is resolved at build
/// time; `update_llm` rebuilds the in-process client when Settings change.
pub struct BrainRuntime {
    inner: RwLock<Inner>,
}

struct Inner {
    settings: LlmSettings,
    transport: BrainTransport,
    retrieve: Option<RetrieveFn>,
}

impl BrainRuntime {
    pub fn from_settings(settings: LlmSettings) -> Arc<Self> {
        let transport = transport_from_settings(&settings);
        Arc::new(Self {
            inner: RwLock::new(Inner {
                settings,
                transport,
                retrieve: None,
            }),
        })
    }

    pub fn with_transport(transport: BrainTransport) -> Arc<Self> {
        Arc::new(Self {
            inner: RwLock::new(Inner {
                settings: LlmSettings::default(),
                transport,
                retrieve: None,
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

    /// Custom-system completion (roast grader). Never used on skip.
    /// Returns None when LLM is disabled or the request fails (fail-open).
    pub async fn complete_plain(&self, system: &str, user: &str) -> Option<String> {
        let settings = {
            let g = self.inner.read().await;
            if !g.settings.enabled {
                return None;
            }
            g.settings.clone()
        };
        let llm = crate::llm::OpenAiLlm::from_settings(&settings);
        llm.complete_system(system, user)
            .await
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    pub async fn llm_snapshot(&self) -> (bool, String, String) {
        let g = self.inner.read().await;
        (
            g.settings.enabled,
            g.settings.url.clone(),
            g.settings.model.clone(),
        )
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
        rebuild_transport(&mut g);
    }

    pub async fn set_retrieve(&self, retrieve: RetrieveFn) {
        let mut g = self.inner.write().await;
        g.retrieve = Some(retrieve);
        rebuild_transport(&mut g);
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
