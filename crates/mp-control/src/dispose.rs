// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Dispose a brain tool proposal: harness policy → tool-map → rights → executor.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::policy::{decide_harness_tool, HarnessToolDecision};
use crate::tool_map::tool_call_to_command;
use crate::{CommandExecutor, Subject, ToolProposal};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDisposeRecord {
    pub name: String,
    pub args: Value,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct BrainDisposer {
    pub executor: Arc<CommandExecutor>,
    pub rights: Option<Arc<mp_rights::RightsEngine>>,
    pub rights_enabled: bool,
}

impl BrainDisposer {
    pub fn new(executor: Arc<CommandExecutor>, rights: Option<Arc<mp_rights::RightsEngine>>) -> Self {
        Self {
            executor,
            rights,
            rights_enabled: true,
        }
    }

    pub async fn dispose_tool(
        &self,
        name: &str,
        args: &Value,
        subject: &Subject,
        dry_run: bool,
        allow_dangerous: bool,
    ) -> ToolDisposeRecord {
        let args = if args.is_object() {
            args.clone()
        } else {
            serde_json::json!({})
        };
        match decide_harness_tool(name, dry_run, allow_dangerous, None) {
            HarnessToolDecision::DryRun => {
                return ToolDisposeRecord {
                    name: name.to_string(),
                    args,
                    ok: true,
                    result: Some(format!("[dry-run] would run {name}")),
                    error: None,
                };
            }
            HarnessToolDecision::Block { reason } => {
                return ToolDisposeRecord {
                    name: name.to_string(),
                    args,
                    ok: false,
                    result: None,
                    error: Some(reason),
                };
            }
            HarnessToolDecision::Execute => {}
        }

        let Some(cmd) = tool_call_to_command(name, &args) else {
            return ToolDisposeRecord {
                name: name.to_string(),
                args,
                ok: false,
                result: None,
                error: Some(format!("unknown or invalid tool: {name}")),
            };
        };

        if !self.may_run(subject, &cmd.name) {
            return ToolDisposeRecord {
                name: name.to_string(),
                args,
                ok: false,
                result: None,
                error: Some(format!("You don't have permission to use '{}'.", cmd.name)),
            };
        }

        match self.executor.execute(&cmd).await {
            Some(text) => ToolDisposeRecord {
                name: name.to_string(),
                args,
                ok: true,
                result: Some(if text.is_empty() {
                    "(ok)".into()
                } else {
                    text
                }),
                error: None,
            },
            None => ToolDisposeRecord {
                name: name.to_string(),
                args,
                ok: true,
                result: Some("(ok)".into()),
                error: None,
            },
        }
    }

    fn may_run(&self, subject: &Subject, command: &str) -> bool {
        if !self.rights_enabled {
            return true;
        }
        let Some(engine) = self.rights.as_ref() else {
            return true;
        };
        let Some(uid) = subject.uid.as_deref().filter(|s| !s.is_empty()) else {
            // Admin session with no impersonated TS subject — HTTP route is admin-only.
            return true;
        };
        let rs = mp_rights::Subject {
            uid: uid.to_string(),
            server_groups: subject.server_groups.clone(),
            nickname: subject.nickname.clone(),
        };
        engine.can(&rs, command, mp_rights::Scope::Chat)
    }
}

impl crate::ToolExecutor for BrainDisposer {
    fn dispose(
        &self,
        proposal: ToolProposal,
        subject: Subject,
    ) -> impl std::future::Future<Output = crate::DisposeResult> + Send {
        async move {
            let rec = self
                .dispose_tool(&proposal.name, &proposal.arguments, &subject, false, true)
                .await;
            crate::DisposeResult {
                ok: rec.ok,
                message: rec
                    .result
                    .or(rec.error)
                    .unwrap_or_default(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::legacy_rights_config;
    use mp_rights::RightsEngine;
    use std::sync::Arc;

    fn tmp_station() -> (std::path::PathBuf, Arc<mp_music::MusicStation>) {
        let dir = std::env::temp_dir().join(format!(
            "mp-disp-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("sine.mp3"), b"fake").unwrap();
        let st = Arc::new(mp_music::MusicStation::new(&dir, None));
        st.set_dry_run(true);
        (dir, st)
    }

    fn admin_subject() -> Subject {
        Subject {
            uid: None,
            nickname: Some("admin".into()),
            server_groups: vec![],
        }
    }

    #[tokio::test]
    async fn dry_run_does_not_mutate_queue() {
        let (dir, st) = tmp_station();
        let ex = Arc::new(CommandExecutor::new(st.clone(), "!"));
        let d = BrainDisposer::new(ex, None);
        let rec = d
            .dispose_tool(
                "play_music",
                &serde_json::json!({ "query": "sine" }),
                &admin_subject(),
                true,
                false,
            )
            .await;
        assert!(rec.ok);
        assert!(rec.result.unwrap().contains("[dry-run]"));
        assert_eq!(st.queue.lock().unwrap().size(), 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn execute_play_music_after_rights() {
        let (dir, st) = tmp_station();
        let ex = Arc::new(CommandExecutor::new(st.clone(), "!"));
        let d = BrainDisposer::new(ex, None);
        let rec = d
            .dispose_tool(
                "play_music",
                &serde_json::json!({ "query": "sine" }),
                &admin_subject(),
                false,
                false,
            )
            .await;
        assert!(rec.ok, "{rec:?}");
        assert!(rec.result.as_deref().unwrap_or("").starts_with("Now playing"));
        assert_eq!(st.queue.lock().unwrap().size(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn member_denied_stop() {
        let (dir, st) = tmp_station();
        let ex = Arc::new(CommandExecutor::new(st, "!"));
        let rights = Arc::new(RightsEngine::new(legacy_rights_config(&[])));
        let d = BrainDisposer::new(ex, Some(rights));
        let rec = d
            .dispose_tool(
                "stop",
                &serde_json::json!({}),
                &Subject {
                    uid: Some("member".into()),
                    nickname: None,
                    server_groups: vec!["100".into()],
                },
                false,
                true,
            )
            .await;
        assert!(!rec.ok);
        assert!(rec
            .error
            .as_deref()
            .unwrap_or("")
            .contains("don't have permission"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn unknown_or_invalid_tool() {
        let (dir, st) = tmp_station();
        let ex = Arc::new(CommandExecutor::new(st, "!"));
        let d = BrainDisposer::new(ex, None);
        let rec = d
            .dispose_tool(
                "play_music",
                &serde_json::json!({ "query": "  " }),
                &admin_subject(),
                false,
                false,
            )
            .await;
        assert!(!rec.ok);
        assert!(
            rec.error.as_deref().unwrap_or("").contains("unknown or invalid"),
            "{rec:?}"
        );
        let blocked = d
            .dispose_tool("frobnicate", &serde_json::json!({}), &admin_subject(), false, true)
            .await;
        assert!(!blocked.ok);
        assert!(
            blocked.error.as_deref().unwrap_or("").contains("not allowed"),
            "{blocked:?}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
