// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Rank-filtered intent tools and the Hermes delegate hook.
//! The model is offered only the tools this subject may run. The hook is
//! installed only when a delegate URL is set, and `BrainDisposer` still
//! checks `@analyst` before it calls the hook.

use std::sync::Arc;

use serde_json::Value;

use crate::AppState;
use mp_brain::{delegate_tool, music_control_tools};
use mp_control::{BrainDisposer, DelegateFn, Subject};
use mp_rights::Scope;

pub(crate) fn offer_intent_tools(allows: impl Fn(&str) -> bool, delegate_configured: bool) -> Vec<Value> {
    let mut tools = music_control_tools();
    tools.retain(|tool| {
        let name = tool["function"]["name"].as_str().unwrap_or("");
        mp_control::tool_right(name).is_some_and(|cmd| allows(cmd))
    });
    if delegate_configured && allows("analyst") {
        tools.push(delegate_tool());
    }
    tools
}

pub(crate) fn delegate_hook(url: &str, model: &str) -> Option<DelegateFn> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    let url = url.to_string();
    let model = model.to_string();
    Some(Arc::new(move |task, extra| {
        let url = url.clone();
        let model = model.clone();
        Box::pin(async move {
            match mp_brain::delegate_complete(&url, &model, &task, &extra).await {
                Ok(text) => text,
                Err(_) => mp_brain::ANALYST_OFFLINE.into(),
            }
        })
    }))
}

pub(crate) fn disposer_with_delegate(
    st: &AppState,
    executor: Arc<mp_control::CommandExecutor>,
) -> BrainDisposer {
    let mut disposer = BrainDisposer {
        executor,
        rights: st.rights.clone(),
        rights_enabled: st.config.rights_enabled,
        delegate: None,
    };
    disposer.delegate = delegate_hook(&st.config.llm_delegate_url, &st.config.llm_delegate_model);
    disposer
}

pub(crate) fn subject_can_analyst(st: &AppState, subject: &Subject, scope: Scope) -> bool {
    if !st.config.rights_enabled {
        return false;
    }
    let Some(engine) = st.rights.as_ref() else {
        return false;
    };
    let Some(uid) = subject.uid.as_deref().filter(|s| !s.is_empty()) else {
        return false;
    };
    let rs = mp_rights::Subject {
        uid: uid.to_string(),
        server_groups: subject.server_groups.clone(),
        nickname: subject.nickname.clone(),
    };
    engine.can(&rs, "analyst", scope) || engine.can(&rs, "agent", scope)
}
