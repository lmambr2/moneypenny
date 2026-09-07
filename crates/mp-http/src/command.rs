// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Shared chat/voice dispose. Rights live here, never in the model.

use mp_brain::{TurnChannel, TurnMode, TurnOptions, TurnRequest, TurnSubject};
use mp_control::{CommandExecutor, ParsedCommand};
use mp_db::Database;
use mp_rag::allowed_classifications_for;
use mp_rights::{RightsEngine, Scope, Subject};

pub async fn dispatch_command(
    parsed: &ParsedCommand,
    subject: &Subject,
    scope: Scope,
    executor: &CommandExecutor,
    rights: Option<&RightsEngine>,
    db: &Database,
    brain: &mp_brain::BrainRuntime,
    rag: Option<&mp_rag::RagRuntime>,
) -> Option<String> {
    if let Some(engine) = rights {
        if !engine.can(subject, &parsed.name, scope) {
            return Some(format!(
                "You don't have permission to use '{}'.",
                parsed.name
            ));
        }
    }
    match parsed.name.as_str() {
        "remember" => Some(cmd_remember(db, rag, &parsed.args, &subject.uid)),
        "recall" => Some(cmd_recall(db, &subject.uid)),
        "forget" => Some(cmd_forget(db, &parsed.args, &subject.uid)),
        "ask" => Some(cmd_ask(brain, rights, subject, scope, &parsed.args).await),
        "reindex" => Some(cmd_reindex(rag, &parsed.args).await),
        _ => executor.execute(parsed).await,
    }
}

fn cmd_remember(db: &Database, rag: Option<&mp_rag::RagRuntime>, args: &str, uid: &str) -> String {
    let fact = args.trim();
    if fact.is_empty() {
        return "Usage: !remember <something about you>".into();
    }
    if let Err(e) = db.memory().add(uid, fact) {
        return format!("Couldn't save that: {e}");
    }
    let injection = rag.is_some_and(|r| r.memory_enabled());
    if injection {
        "Noted — I shan't forget, darling.".into()
    } else {
        "Noted (memory injection is off; an admin can enable it in Settings).".into()
    }
}

fn cmd_recall(db: &Database, uid: &str) -> String {
    let facts = db.memory().recall(uid, 15).unwrap_or_default();
    if facts.is_empty() {
        return "I've nothing on you yet. Use !remember <fact>.".into();
    }
    let lines: Vec<String> = facts
        .iter()
        .enumerate()
        .map(|(i, f)| format!("{}. {}", i + 1, f.fact))
        .collect();
    format!("What I remember about you:\n{}", lines.join("\n"))
}

fn cmd_forget(db: &Database, args: &str, uid: &str) -> String {
    let trimmed = args.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        return "Usage: !forget <number> or !forget all".into();
    }
    if trimmed == "all" {
        let n = db.memory().forget(uid).unwrap_or(0);
        return if n > 0 {
            format!("Forgotten {n} fact{}.", if n == 1 { "" } else { "s" })
        } else {
            "Nothing to forget.".into()
        };
    }
    let Ok(index) = trimmed.parse::<i64>() else {
        return "Usage: !forget <number> (from !recall) or !forget all".into();
    };
    if index < 1 {
        return "Usage: !forget <number> (from !recall) or !forget all".into();
    }
    match db.memory().forget_at_index(uid, index) {
        Ok(true) => "Forgotten.".into(),
        _ => "No fact at that number — run !recall to see your list.".into(),
    }
}

async fn cmd_ask(
    brain: &mp_brain::BrainRuntime,
    rights: Option<&RightsEngine>,
    subject: &Subject,
    scope: Scope,
    args: &str,
) -> String {
    let q = args.trim();
    if q.is_empty() {
        return "Usage: !ask <question>".into();
    }
    let allowed = allowed_classifications_for(rights, subject);
    let channel = match scope {
        Scope::Voice => TurnChannel::Voice,
        _ => TurnChannel::Teamspeak,
    };
    let req = TurnRequest {
        client_turn_id: None,
        channel,
        text: q.to_string(),
        conversation_id: Some(if matches!(scope, Scope::Voice) {
            format!("voice:{}", subject.uid)
        } else {
            "channel".into()
        }),
        subject: Some(TurnSubject {
            uid: Some(subject.uid.clone()),
            server_groups: Some(subject.server_groups.clone()),
            allowed_classifications: Some(allowed),
        }),
        mode: Some(TurnMode::Ask),
        options: Some(TurnOptions {
            include_sources: Some(true),
            max_tools: None,
        }),
    };
    let r = brain.complete(req).await;
    if !r.reply_text.trim().is_empty() {
        r.reply_text
    } else {
        r.error
            .unwrap_or_else(|| "Sorry, the local brain is having a moment.".into())
    }
}

async fn cmd_reindex(rag: Option<&mp_rag::RagRuntime>, args: &str) -> String {
    let Some(rag) = rag else {
        return "RAG is not configured.".into();
    };
    let arg = args.trim();
    let result = if arg.is_empty() {
        mp_rag::reindex_doctrine(&rag.retrieval, &rag.doctrine).await
    } else {
        mp_rag::reindex_sources(
            &rag.retrieval,
            &rag.doctrine,
            [arg.to_string()],
            true,
        )
        .await
    };
    match result {
        Ok(docs) => {
            if docs.is_empty() {
                "Doctrine already up to date.".into()
            } else {
                format!(
                    "Reindexed {} doc{}.",
                    docs.len(),
                    if docs.len() == 1 { "" } else { "s" }
                )
            }
        }
        Err(e) => format!("Reindex failed: {e}"),
    }
}
