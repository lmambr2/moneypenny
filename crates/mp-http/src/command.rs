// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Shared chat/voice dispose. Rights live here, never in the model.

use mp_brain::{TurnChannel, TurnMode, TurnOptions, TurnRequest, TurnSubject};
use mp_control::{CommandExecutor, ParsedCommand};
use mp_db::Database;
use mp_rag::allowed_classifications_for;
use mp_radio::{Boundary, CueResult, RadioRuntime};
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
    radio: Option<&RadioRuntime>,
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
        "radio" => Some(cmd_radio(radio, &executor.prefix, parsed).await),
        "skip" | "next" => {
            if let Some(r) = radio {
                if r.enabled() {
                    return Some(skip_via_radio(r).await);
                }
            }
            executor.execute(parsed).await
        }
        _ => executor.execute(parsed).await,
    }
}

async fn skip_via_radio(radio: &RadioRuntime) -> String {
    match radio.on_track_boundary().await {
        Boundary::Bumper { label } => {
            if label.is_empty() {
                "📻 Bumper playing.".into()
            } else {
                format!("📻 Bumper playing ({label}).")
            }
        }
        Boundary::Advanced { song: Some(s) } => format!("Skipped — now playing: {s}"),
        Boundary::Advanced { song: None } => "Queue is empty".into(),
    }
}

async fn cmd_radio(radio: Option<&RadioRuntime>, prefix: &str, parsed: &ParsedCommand) -> String {
    let Some(radio) = radio else {
        return "Radio controls are not available.".into();
    };
    let sub = parsed
        .raw_args
        .first()
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| "status".into());
    match sub.as_str() {
        "on" => {
            radio.set_enabled(true);
            let st = radio.status();
            format!(
                "📻 Radio mode ON. Profile {} · bumper every {} songs · dead air {}s (runtime toggle — set a persistent default in Settings.)",
                st.active_profile, st.every_n_songs, st.dead_air_seconds
            )
        }
        "off" => {
            radio.set_enabled(false);
            "📻 Radio mode OFF.".into()
        }
        "ops" => {
            let arg = parsed
                .raw_args
                .get(1)
                .map(|s| s.to_ascii_lowercase())
                .unwrap_or_else(|| "list".into());
            if arg == "list" {
                let names = radio.profile_names();
                let active = radio.config().active_profile;
                return if names.is_empty() {
                    "No radio profiles configured.".into()
                } else {
                    format!("Profiles: {} (active: {active})", names.join(", "))
                };
            }
            match radio.set_profile(&arg) {
                Ok(n) => format!(
                    "🎛 Op context: {arg}. {}",
                    if n > 0 {
                        format!("Programmed {n} track{}.", if n == 1 { "" } else { "s" })
                    } else {
                        "Bumper topics retuned; no music sources matched.".into()
                    }
                ),
                Err(e) => e,
            }
        }
        "bumper" => {
            let topic = parsed.raw_args.get(1..).map(|p| p.join(" ")).filter(|s| !s.trim().is_empty());
            match radio.cue_bumper(topic).await {
                CueResult::Played => "📻 Bumper playing.".into(),
                CueResult::Cued => {
                    "📻 Bumper cued — plays on next skip, track end, or dead air.".into()
                }
                CueResult::Unavailable => {
                    "No bumper available (radio off, or no source could produce one).".into()
                }
            }
        }
        "say" => {
            let text = parsed.raw_args.get(1..).map(|p| p.join(" ")).unwrap_or_default();
            let text = text.trim();
            if text.is_empty() {
                return format!("Usage: {prefix}radio say <text>");
            }
            match radio.cue_say(text).await {
                CueResult::Played => "📻 On air.".into(),
                CueResult::Cued => {
                    "📻 Liner cued — plays on next skip, track end, or dead air.".into()
                }
                CueResult::Unavailable => "Can't speak right now (radio off or TTS unavailable).".into(),
            }
        }
        "skipbumper" | "skip-bumper" | "skip" => {
            let msg = if radio.skip_bumper() == "cue" {
                "Cued bumper cancelled."
            } else {
                "Next scheduled bumper will be skipped."
            };
            if sub == "skip" {
                format!("{msg} (Tip: prefer {prefix}radio skipbumper — bare {prefix}skip is for the track.)")
            } else {
                msg.into()
            }
        }
        "status" => {
            if !radio.enabled() {
                return format!("📻 Radio mode OFF. Use {prefix}radio on to start.");
            }
            let st = radio.status();
            let until = match st.songs_until_bumper {
                None => String::new(),
                Some(0) => " Bumper due at the next break.".into(),
                Some(n) => format!(" Next bumper in {n} track{}.", if n == 1 { "" } else { "s" }),
            };
            format!(
                "📻 Radio mode ON. Profile {} · bumper every {} songs.{until}",
                st.active_profile, st.every_n_songs
            )
        }
        _ => format!(
            "Usage: {prefix}radio [on|off|status|ops <profile>|ops list|bumper [topic]|say <text>|skipbumper]"
        ),
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
