// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Brain turn contract (`docs/brain-boundary.md`).
//! Brain *proposes*; bot *disposes*. `POST /v1/turn` JSON is frozen.

mod complete;
mod dispose;
mod factory;
mod http;
mod in_process;
mod llm;
mod runtime;
mod text;
mod tools;
mod types;

pub use complete::{complete_turn, complete_turn_opts};
pub use dispose::dispose_tool_proposals;
pub use factory::{
    in_process_from_settings, resolve_brain_transport, transport_from_settings, BrainTransport,
};
pub use http::{FetchFn, HttpBrain, RawHttp};
pub use in_process::{InProcessBrain, RetrieveFn};
pub use llm::{
    IntentResult, IntentToolCall, LlmBackend, LlmSettings, OpenAiLlm, ScriptedLlm,
};
pub use runtime::BrainRuntime;
pub use text::extract_assistant_text;
pub use tools::{music_control_tools, DEFAULT_CHAT_MODEL, DEFAULT_SYSTEM_PROMPT};
pub use types::{
    empty_turn, Brain, BrainError, DisposedTool, ToolProposal, TurnChannel, TurnMode, TurnOptions,
    TurnRequest, TurnResponse, TurnSource, TurnSubject,
};

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    fn req(text: &str, mode: TurnMode) -> TurnRequest {
        TurnRequest {
            client_turn_id: None,
            channel: TurnChannel::Dashboard,
            text: text.into(),
            conversation_id: None,
            subject: None,
            mode: Some(mode),
            options: None,
        }
    }

    #[test]
    fn turn_json_camel_case() {
        let req = TurnRequest {
            client_turn_id: Some("c1".into()),
            channel: TurnChannel::Dashboard,
            text: "skip".into(),
            conversation_id: None,
            subject: None,
            mode: Some(TurnMode::Intent),
            options: Some(TurnOptions {
                include_sources: Some(true),
                max_tools: Some(4),
            }),
        };
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v["clientTurnId"], "c1");
        assert_eq!(v["channel"], "dashboard");
        assert_eq!(v["options"]["includeSources"], true);
        assert_eq!(v["options"]["maxTools"], 4);
    }

    #[tokio::test]
    async fn ask_mode_returns_reply_and_sources_without_tools() {
        let retrieve: RetrieveFn = Arc::new(|_q| {
            Box::pin(async {
                Ok(vec![TurnSource {
                    source: "doc.md".into(),
                    text: Some("snippet".into()),
                    classification: Some("unclassified".into()),
                    score: Some(0.9),
                }])
            })
        });
        let brain = InProcessBrain::scripted(ScriptedLlm::ask_only(|q| format!("Answer: {q}")))
            .with_retrieve(retrieve)
            .with_id_factory(|| "t1".into());
        let r = brain.complete(req("hello", TurnMode::Ask)).await;
        assert_eq!(r.reply_text, "Answer: hello");
        assert_eq!(r.sources.len(), 1);
        assert!(r.tool_proposals.is_empty());
        assert!(r.error.is_none());
    }

    #[tokio::test]
    async fn intent_mode_proposes_tools_but_does_not_execute() {
        let brain = InProcessBrain::scripted(ScriptedLlm::with_intent(
            |_| String::new(),
            |_| IntentResult {
                content: Some("Sure".into()),
                tool_calls: vec![IntentToolCall {
                    name: "play_music".into(),
                    arguments: json!({ "query": "ambient" }),
                }],
            },
        ))
        .with_id_factory(|| "t2".into());
        let r = brain.complete(req("play ambient", TurnMode::Intent)).await;
        assert_eq!(r.tool_proposals.len(), 1);
        assert_eq!(r.tool_proposals[0].name, "play_music");
        assert_eq!(r.tool_proposals[0].arguments["query"], "ambient");
        assert_eq!(r.reply_text, "Sure");
    }

    #[tokio::test]
    async fn errors_when_llm_disabled() {
        let brain = InProcessBrain::disabled().with_id_factory(|| "t3".into());
        let r = brain.complete(req("x", TurnMode::Ask)).await;
        assert!(r.error.as_deref().unwrap_or("").contains("not enabled"));
    }

    #[tokio::test]
    async fn http_brain_posts_and_normalizes() {
        let fetch: FetchFn = Arc::new(|url, _body| {
            Box::pin(async move {
                assert_eq!(url, "http://brain.example/v1/turn");
                Ok(RawHttp {
                    status: 200,
                    body: serde_json::to_vec(&json!({
                        "turnId": "remote-1",
                        "replyText": "hi",
                        "sources": [],
                        "toolProposals": [{ "name": "skip", "arguments": {} }],
                        "error": null
                    }))
                    .unwrap(),
                })
            })
        });
        let brain = HttpBrain::with_fetch("http://brain.example", fetch);
        let r = brain.turn(req("hey", TurnMode::Ask)).await.unwrap();
        assert_eq!(r.turn_id, "remote-1");
        assert_eq!(r.tool_proposals[0].name, "skip");
    }

    #[tokio::test]
    async fn http_brain_503_is_unavailable() {
        let fetch: FetchFn = Arc::new(|_url, _body| {
            Box::pin(async {
                Ok(RawHttp {
                    status: 503,
                    body: b"down".to_vec(),
                })
            })
        });
        let brain = HttpBrain::with_fetch("http://brain.example", fetch);
        let err = brain.turn(req("x", TurnMode::Ask)).await.unwrap_err();
        assert!(matches!(err, BrainError::Unavailable(_)));
    }

    struct DownBrain;
    impl Brain for DownBrain {
        async fn turn(&self, _req: TurnRequest) -> Result<TurnResponse, BrainError> {
            Err(BrainError::Unavailable("Brain unavailable (503)".into()))
        }
    }

    #[tokio::test]
    async fn complete_turn_soft_fail() {
        let r = complete_turn(req("x", TurnMode::Ask), &DownBrain).await;
        assert!(r.error.as_deref().unwrap_or("").contains("unavailable"));
        assert!(r.tool_proposals.is_empty());
    }

    #[tokio::test]
    async fn resolve_in_process_when_brain_url_empty() {
        let t = resolve_brain_transport(
            &LlmSettings {
                brain_url: String::new(),
                ..LlmSettings::default()
            },
            InProcessBrain::scripted(ScriptedLlm::ask_only(|_| "local".into()))
                .with_id_factory(|| "x".into()),
        );
        let r = t.turn(req("q", TurnMode::Ask)).await.unwrap();
        assert_eq!(r.reply_text, "local");
    }

    #[tokio::test]
    async fn resolve_http_when_brain_url_set() {
        let fetch: FetchFn = Arc::new(|_url, _body| {
            Box::pin(async {
                Ok(RawHttp {
                    status: 200,
                    body: serde_json::to_vec(&json!({
                        "turnId": "r",
                        "replyText": "remote",
                        "sources": [],
                        "toolProposals": [],
                        "error": null
                    }))
                    .unwrap(),
                })
            })
        });
        let t = BrainTransport::Http(HttpBrain::with_fetch("http://remote", fetch));
        let r = t.turn(req("q", TurnMode::Ask)).await.unwrap();
        assert_eq!(r.reply_text, "remote");
    }
}
