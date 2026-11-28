// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Dispose a brain tool proposal: harness policy → tool-map → rights → executor.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::policy::{HarnessToolDecision, decide_harness_tool};
use crate::tool_map::{is_library_tool, tool_call_to_command};
use crate::{CommandExecutor, Subject, ToolProposal};

pub const ANALYST_UNCONFIGURED: &str =
    "Analyst delegation is not configured. Set a delegate URL in Settings.";

/// `(task, extra context) -> analyst text`. Installed only when a delegate URL is set.
pub type DelegateFn =
    Arc<dyn Fn(String, String) -> Pin<Box<dyn Future<Output = String> + Send>> + Send + Sync>;

/// `(tool name, arguments, subject) -> tool text`. Installed when the doctrine library is up.
pub type LibraryFn = Arc<
    dyn Fn(String, Value, Subject) -> Pin<Box<dyn Future<Output = String> + Send>> + Send + Sync,
>;

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
    /// Present only when `llmDelegateUrl` is set. A missing hook never calls Hermes.
    pub delegate: Option<DelegateFn>,
    /// Present when doctrine storage is configured. A missing hook never writes a file.
    pub library: Option<LibraryFn>,
}

impl BrainDisposer {
    pub fn new(
        executor: Arc<CommandExecutor>,
        rights: Option<Arc<mp_rights::RightsEngine>>,
    ) -> Self {
        Self {
            executor,
            rights,
            rights_enabled: true,
            delegate: None,
            library: None,
        }
    }

    pub fn allows(&self, subject: &Subject, command: &str) -> bool {
        self.may_run(subject, command)
    }

    /// TeamSpeak `reindex`, or a dashboard admin session (`web:…`).
    /// The harness route is already admin-only. A channel user still needs `reindex`.
    pub fn allows_library(&self, subject: &Subject) -> bool {
        self.may_run(subject, "reindex") || subject.uid.as_deref().unwrap_or("").starts_with("web:")
    }

    pub async fn dispose_tool(
        &self,
        name: &str,
        args: &Value,
        subject: &Subject,
        dry_run: bool,
        allow_dangerous: bool,
    ) -> ToolDisposeRecord {
        self.dispose_tool_allow(name, args, subject, dry_run, allow_dangerous, None)
            .await
    }

    /// `allowlist` is the only way a caller runs `stop` or `set_volume` without
    /// also opening `move_client`. `None` keeps the previous safe/dangerous split.
    pub async fn dispose_tool_allow(
        &self,
        name: &str,
        args: &Value,
        subject: &Subject,
        dry_run: bool,
        allow_dangerous: bool,
        allowlist: Option<&[String]>,
    ) -> ToolDisposeRecord {
        let args = if args.is_object() {
            args.clone()
        } else {
            serde_json::json!({})
        };
        match decide_harness_tool(name, dry_run, allow_dangerous, allowlist) {
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

        if is_library_tool(name) {
            return self.call_library(name, args, subject).await;
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

        if cmd.name == "analyst" || cmd.name == "agent" {
            return self.call_analyst(name, args, &cmd.args).await;
        }

        match self.executor.execute(&cmd).await {
            Some(text) => ToolDisposeRecord {
                name: name.to_string(),
                args,
                ok: true,
                result: Some(if text.is_empty() { "(ok)".into() } else { text }),
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

    async fn call_library(&self, name: &str, args: Value, subject: &Subject) -> ToolDisposeRecord {
        if !self.allows_library(subject) {
            return ToolDisposeRecord {
                name: name.to_string(),
                args,
                ok: false,
                result: None,
                error: Some("You don't have permission to use 'reindex'.".into()),
            };
        }
        let Some(run) = self.library.clone() else {
            return ToolDisposeRecord {
                name: name.to_string(),
                args,
                ok: false,
                result: None,
                error: Some("library is not configured".into()),
            };
        };
        let text = run(name.to_string(), args.clone(), subject.clone()).await;
        ToolDisposeRecord {
            name: name.to_string(),
            args,
            ok: true,
            result: Some(text),
            error: None,
        }
    }

    async fn call_analyst(&self, name: &str, args: Value, task: &str) -> ToolDisposeRecord {
        let task = task.trim();
        if task.is_empty() {
            return ToolDisposeRecord {
                name: name.to_string(),
                args,
                ok: false,
                result: None,
                error: Some("Usage: !analyst <task>".into()),
            };
        }
        let extra = args
            .get("context")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let Some(run) = self.delegate.clone() else {
            return ToolDisposeRecord {
                name: name.to_string(),
                args,
                ok: false,
                result: None,
                error: Some(ANALYST_UNCONFIGURED.into()),
            };
        };
        let text = run(task.to_string(), extra).await;
        ToolDisposeRecord {
            name: name.to_string(),
            args,
            ok: true,
            result: Some(text),
            error: None,
        }
    }

    fn may_run(&self, subject: &Subject, command: &str) -> bool {
        let analyst = command == "analyst" || command == "agent";
        if !self.rights_enabled {
            return !analyst;
        }
        let Some(engine) = self.rights.as_ref() else {
            return !analyst;
        };
        let Some(uid) = subject.uid.as_deref().filter(|s| !s.is_empty()) else {
            // A dashboard session with no TeamSpeak subject may run music tools.
            // Analyst still needs a server group that holds @analyst.
            return !analyst;
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
                message: rec.result.or(rec.error).unwrap_or_default(),
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
        assert!(
            rec.result
                .as_deref()
                .unwrap_or("")
                .starts_with("Now playing")
        );
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
        assert!(
            rec.error
                .as_deref()
                .unwrap_or("")
                .contains("don't have permission")
        );
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
            rec.error
                .as_deref()
                .unwrap_or("")
                .contains("unknown or invalid"),
            "{rec:?}"
        );
        let blocked = d
            .dispose_tool(
                "frobnicate",
                &serde_json::json!({}),
                &admin_subject(),
                false,
                true,
            )
            .await;
        assert!(!blocked.ok);
        assert!(
            blocked
                .error
                .as_deref()
                .unwrap_or("")
                .contains("not allowed"),
            "{blocked:?}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn allowlist_runs_stop_and_blocks_move() {
        let (dir, st) = tmp_station();
        let ex = Arc::new(CommandExecutor::new(st.clone(), "!"));
        let d = BrainDisposer::new(ex, None);
        d.dispose_tool(
            "play_music",
            &serde_json::json!({ "query": "sine" }),
            &admin_subject(),
            false,
            false,
        )
        .await;
        assert_eq!(st.queue.lock().unwrap().size(), 1);
        let allow = vec!["stop".to_string(), "set_volume".to_string()];
        let stopped = d
            .dispose_tool_allow(
                "stop",
                &serde_json::json!({}),
                &admin_subject(),
                false,
                false,
                Some(&allow),
            )
            .await;
        assert!(stopped.ok, "{stopped:?}");
        assert!(stopped.result.unwrap().contains("Stopped"));
        assert_eq!(st.queue.lock().unwrap().size(), 0);
        let blocked = d
            .dispose_tool_allow(
                "move_client",
                &serde_json::json!({ "client": "a", "channel": "b" }),
                &admin_subject(),
                false,
                false,
                Some(&allow),
            )
            .await;
        assert!(!blocked.ok);
        assert!(
            blocked
                .error
                .as_deref()
                .unwrap_or("")
                .contains("allowDangerous"),
            "{blocked:?}"
        );
        let still_blocked = d
            .dispose_tool(
                "stop",
                &serde_json::json!({}),
                &admin_subject(),
                false,
                false,
            )
            .await;
        assert!(!still_blocked.ok);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn rank_engine() -> Arc<RightsEngine> {
        use mp_rights::{RightsConfig, RightsRule, RuleMatch};
        use std::collections::HashMap;
        Arc::new(RightsEngine::new(RightsConfig {
            default_allow: Some(vec!["play".into(), "add".into()]),
            command_groups: Some(HashMap::from([
                ("admin".into(), vec!["stop".into()]),
                ("analyst".into(), vec!["analyst".into(), "agent".into()]),
            ])),
            super_admin_uids: Some(Vec::new()),
            rules: Some(vec![
                RightsRule {
                    name: Some("colonel".into()),
                    r#match: RuleMatch {
                        uids: None,
                        server_groups: Some(vec!["9".into()]),
                    },
                    allow: Some(vec!["@admin".into()]),
                    deny: None,
                    scope: None,
                },
                RightsRule {
                    name: Some("chairman".into()),
                    r#match: RuleMatch {
                        uids: None,
                        server_groups: Some(vec!["23".into()]),
                    },
                    allow: Some(vec!["@analyst".into()]),
                    deny: None,
                    scope: None,
                },
            ]),
        }))
    }

    fn who(uid: &str, group: &str) -> Subject {
        Subject {
            uid: Some(uid.into()),
            nickname: None,
            server_groups: vec![group.into()],
        }
    }

    #[tokio::test]
    async fn analyst_is_rank_gated_before_the_delegate_hook() {
        let (dir, st) = tmp_station();
        let ex = Arc::new(CommandExecutor::new(st, "!"));
        let hit = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hit2 = Arc::clone(&hit);
        let mut d = BrainDisposer::new(ex, Some(rank_engine()));
        d.delegate = Some(Arc::new(move |task, _extra| {
            hit2.store(true, std::sync::atomic::Ordering::SeqCst);
            let task = task.clone();
            Box::pin(async move { format!("done:{task}") })
        }));

        let colonel = d
            .dispose_tool(
                "delegate_to_agent",
                &serde_json::json!({ "task": "write the intsum" }),
                &who("col", "9"),
                false,
                true,
            )
            .await;
        assert!(!colonel.ok, "{colonel:?}");
        assert!(colonel.error.unwrap().contains("permission"));
        assert!(!hit.load(std::sync::atomic::Ordering::SeqCst));

        let missing = d
            .dispose_tool(
                "delegate_to_agent",
                &serde_json::json!({ "task": "write the intsum" }),
                &admin_subject(),
                false,
                true,
            )
            .await;
        assert!(!missing.ok, "{missing:?}");
        assert!(missing.error.unwrap().contains("permission"));
        assert!(!hit.load(std::sync::atomic::Ordering::SeqCst));

        let play = d.allows(&admin_subject(), "play");
        assert!(play);

        let chairman = d
            .dispose_tool(
                "delegate_to_agent",
                &serde_json::json!({ "task": "write the intsum" }),
                &who("chair", "23"),
                false,
                true,
            )
            .await;
        assert!(chairman.ok, "{chairman:?}");
        assert_eq!(chairman.result.as_deref(), Some("done:write the intsum"));
        assert!(hit.load(std::sync::atomic::Ordering::SeqCst));

        d.delegate = None;
        let unconfigured = d
            .dispose_tool(
                "delegate_to_agent",
                &serde_json::json!({ "task": "write the intsum" }),
                &who("chair", "23"),
                false,
                true,
            )
            .await;
        assert!(!unconfigured.ok);
        assert!(unconfigured.error.unwrap().contains("not configured"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn library_edit_uses_the_hook_and_stays_behind_reindex() {
        let (dir, st) = tmp_station();
        let ex = Arc::new(CommandExecutor::new(st, "!"));
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hits2 = Arc::clone(&hits);
        let mut d = BrainDisposer::new(
            ex,
            Some(Arc::new(RightsEngine::new(legacy_rights_config(&[9])))),
        );
        d.library = Some(Arc::new(move |name, args, _subject| {
            hits2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let find = args
                .get("find")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Box::pin(async move { format!("ran:{name}:{find}") })
        }));
        let edit = serde_json::json!({"source": "a.md", "find": "one", "replace": "two"});
        let colonel = who("col", "9");
        let member = who("mem", "100");

        let blocked = d
            .dispose_tool("edit_library_doc", &edit, &colonel, false, false)
            .await;
        assert!(!blocked.ok, "{blocked:?}");
        assert!(blocked.error.unwrap().contains("allowDangerous"));
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0);

        let dry = d
            .dispose_tool("edit_library_doc", &edit, &colonel, true, false)
            .await;
        assert!(dry.result.unwrap().contains("[dry-run]"));
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0);

        let denied = d
            .dispose_tool("edit_library_doc", &edit, &member, false, true)
            .await;
        assert!(!denied.ok, "{denied:?}");
        assert!(denied.error.unwrap().contains("reindex"));
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0);

        let ran = d
            .dispose_tool("edit_library_doc", &edit, &colonel, false, true)
            .await;
        assert!(ran.ok, "{ran:?}");
        assert_eq!(ran.result.as_deref(), Some("ran:edit_library_doc:one"));
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);

        let web = d
            .dispose_tool(
                "read_library_doc",
                &serde_json::json!({"source": "a.md"}),
                &Subject {
                    uid: Some("web:4".into()),
                    nickname: None,
                    server_groups: vec![],
                },
                false,
                false,
            )
            .await;
        assert!(web.ok, "{web:?}");
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 2);

        d.library = None;
        let missing = d
            .dispose_tool(
                "list_library_docs",
                &serde_json::json!({}),
                &colonel,
                false,
                false,
            )
            .await;
        assert!(!missing.ok);
        assert!(missing.error.unwrap().contains("not configured"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
