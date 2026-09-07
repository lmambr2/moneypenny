// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use std::time::Duration;

use crate::http::HttpBrain;
use crate::in_process::InProcessBrain;
use crate::llm::{LlmBackend, LlmSettings, OpenAiLlm};
use crate::types::{Brain, BrainError, TurnRequest, TurnResponse};

#[derive(Clone)]
pub enum BrainTransport {
    InProcess(InProcessBrain),
    Http(HttpBrain),
}

impl Brain for BrainTransport {
    async fn turn(&self, req: TurnRequest) -> Result<TurnResponse, BrainError> {
        match self {
            Self::InProcess(b) => b.turn(req).await,
            Self::Http(b) => b.turn(req).await,
        }
    }
}

/// Prefer remote brain when `BRAIN_URL` / `brain_url` is set; else in-process.
pub fn resolve_brain_transport(settings: &LlmSettings, in_process: InProcessBrain) -> BrainTransport {
    let url = settings.brain_url.trim();
    if !url.is_empty() {
        let timeout = Duration::from_millis(settings.timeout_ms.max(1_000));
        return BrainTransport::Http(HttpBrain::new(url, timeout));
    }
    BrainTransport::InProcess(in_process)
}

pub fn in_process_from_settings(settings: &LlmSettings) -> InProcessBrain {
    let llm = if settings.enabled {
        Some(LlmBackend::OpenAi(OpenAiLlm::from_settings(settings)))
    } else {
        None
    };
    InProcessBrain::new(llm)
}

pub fn transport_from_settings(settings: &LlmSettings) -> BrainTransport {
    resolve_brain_transport(settings, in_process_from_settings(settings))
}
