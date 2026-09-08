// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Shared chat/voice dispose. Rights live here, never in the model.

use mp_brain::{TurnChannel, TurnMode, TurnOptions, TurnRequest, TurnSubject};
use mp_control::{CommandExecutor, ParsedCommand};
use mp_db::{Database, WorkOrderLine};
use mp_economy::{
    find_ore, handle_econ, handle_mine, handle_refine, parse_workorder_args, WorkOrderSub,
    MAX_OPEN_WORK_ORDERS,
};
use mp_rag::allowed_classifications_for;
use mp_radio::{Boundary, CueResult, RadioRuntime};
use mp_rights::{RightsEngine, Scope, Subject};

use crate::roast::RoastRuntime;

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
    roast: Option<&RoastRuntime>,
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
        "kg" => Some(cmd_kg(rag, rights, subject, scope, &parsed.args)),
        "diary" => Some(cmd_diary(rag, rights, subject, scope, &parsed.args)),
        "ops" => Some(cmd_ops(radio, rag, Some(executor.station.as_ref()), &parsed.args)),
        "ask" => Some(cmd_ask(brain, rights, subject, scope, &parsed.args).await),
        "reindex" => Some(cmd_reindex(rag, &parsed.args).await),
        "radio" => Some(cmd_radio(radio, &executor.prefix, parsed).await),
        "roast" => Some(cmd_roast(roast).await),
        "roastout" => Some(cmd_roastout(roast, &subject.uid)),
        "roastin" => Some(cmd_roastin(roast, &subject.uid)),
        "mine" => Some(handle_mine(&parsed.args, &executor.prefix)),
        "refine" => Some(handle_refine(&parsed.args, &executor.prefix)),
        "econ" => Some(handle_econ(&parsed.args, &executor.prefix)),
        "craft" => Some(format!(
            "Craft lookup is not ported (no sc-craft HTTP). Seed catalog: {}mine / {}refine / {}econ ores",
            executor.prefix, executor.prefix, executor.prefix
        )),
        "trade" => Some(
            "Trade lookup is not ported (no sc-trade token/HTTP). Seed catalog: !econ ores".into(),
        ),
        "workorder" => Some(cmd_workorder(db, rights, subject, scope, &executor.prefix, &parsed.args)),
        "work-items" | "workitems" => Some(cmd_work_items(db, &executor.prefix)),
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

fn can_write_org(rights: Option<&RightsEngine>, subject: &Subject, scope: Scope) -> bool {
    let Some(engine) = rights else {
        return true;
    };
    engine.can(subject, "analyst", scope) || engine.can(subject, "agent", scope)
}

fn cmd_kg(
    rag: Option<&mp_rag::RagRuntime>,
    rights: Option<&RightsEngine>,
    subject: &Subject,
    scope: Scope,
    args: &str,
) -> String {
    let Some(rag) = rag else {
        return "Org knowledge graph is not ready.".into();
    };
    rag.kg
        .handle_kg(args, Some(&subject.uid), can_write_org(rights, subject, scope))
}

fn cmd_diary(
    rag: Option<&mp_rag::RagRuntime>,
    rights: Option<&RightsEngine>,
    subject: &Subject,
    scope: Scope,
    args: &str,
) -> String {
    let Some(rag) = rag else {
        return "Org knowledge graph is not ready.".into();
    };
    rag.kg
        .handle_diary(args, Some(&subject.uid), can_write_org(rights, subject, scope))
}

fn cmd_ops(
    radio: Option<&RadioRuntime>,
    rag: Option<&mp_rag::RagRuntime>,
    station: Option<&mp_music::MusicStation>,
    args: &str,
) -> String {
    let sub = args
        .trim()
        .split_whitespace()
        .next()
        .unwrap_or("status")
        .to_ascii_lowercase();
    if !matches!(sub.as_str(), "status" | "brief" | "" ) {
        return "Usage: !ops [status] — org brief (SC plugins not ported).".into();
    }
    let radio_on = radio.is_some_and(|r| r.enabled());
    let profile = radio
        .map(|r| r.config().active_profile)
        .unwrap_or_else(|| "—".into());
    let now = station.and_then(|s| {
        s.queue
            .lock()
            .ok()
            .and_then(|q| q.current().map(|c| format!("{} — {}", c.name, c.artist)))
    });
    let kg_n = rag.map(|r| r.kg.count()).unwrap_or(0);
    let docs = rag.map(|r| r.doctrine.list().len()).unwrap_or(0);
    format!(
        "📋 Ops status\nRadio: {} (profile {profile})\nNow playing: {}\nOrg KG: {kg_n} fact(s)\nDoctrine: {docs} doc(s)",
        if radio_on { "ON" } else { "OFF" },
        now.as_deref().unwrap_or("(nothing)"),
    )
}

fn cmd_remember(db: &Database, rag: Option<&mp_rag::RagRuntime>, args: &str, uid: &str) -> String {
    let fact = args.trim();
    if fact.is_empty() {
        return "Usage: !remember <something about you>".into();
    }
    if let Err(e) = db.memory().add(uid, fact) {
        return format!("Couldn't save that: {e}");
    }
    if let Some(r) = rag {
        if r.mempalace_enabled() {
            if let Some(c) = r.mempalace.clone() {
                let uid = uid.to_string();
                let fact = fact.to_string();
                tokio::spawn(async move {
                    let _ = c.remember(&uid, &fact).await;
                });
            }
        }
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

async fn cmd_roast(roast: Option<&RoastRuntime>) -> String {
    let Some(roast) = roast else {
        return "The roast is switched off. An admin can enable it in Settings.".into();
    };
    roast.handle_command().await
}

fn cmd_roastout(roast: Option<&RoastRuntime>, uid: &str) -> String {
    let Some(roast) = roast else {
        return "The roast is switched off.".into();
    };
    roast.handle_opt_out(uid)
}

fn cmd_roastin(roast: Option<&RoastRuntime>, uid: &str) -> String {
    let Some(roast) = roast else {
        return "The roast is switched off.".into();
    };
    roast.handle_opt_in(uid)
}

fn cmd_workorder(
    db: &Database,
    rights: Option<&RightsEngine>,
    subject: &Subject,
    scope: Scope,
    prefix: &str,
    args: &str,
) -> String {
    let parsed = parse_workorder_args(args);
    match parsed.sub {
        WorkOrderSub::Help => [
            format!("{prefix}workorder <item> xN — save a seed-ore shopping line (e.g. {prefix}workorder quantainium x32)"),
            format!("{prefix}work-items — org totals from open work orders"),
            format!("{prefix}workorder list · {prefix}workorder done <id>"),
            format!("{prefix}workorder clear — wipe board (admin / workorder.clear)"),
            "Craft blueprint BOMs need sc-craft (not ported).".to_string(),
        ]
        .join("\n"),
        WorkOrderSub::List => {
            let orders = db.work_orders().list().unwrap_or_default();
            if orders.is_empty() {
                return "No open work orders.".into();
            }
            let mut lines: Vec<String> = vec!["Open work orders:".into()];
            for o in &orders {
                lines.push(format!(
                    "#{} {}× {} — {}",
                    o.id,
                    o.qty,
                    o.item_name,
                    format_lines(&o.lines)
                ));
            }
            lines.push(String::new());
            lines.push(format!("Totals: {prefix}work-items"));
            lines.join("\n")
        }
        WorkOrderSub::Clear => {
            let allowed = rights.is_none_or(|e| e.can(subject, "workorder.clear", scope));
            if !allowed {
                return "Clear all work orders requires admin (rights: workorder.clear). Use done <id> for one.".into();
            }
            let n = db.work_orders().clear().unwrap_or(0);
            if n == 0 {
                "No work orders to clear.".into()
            } else {
                format!("Cleared {n} work order(s).")
            }
        }
        WorkOrderSub::Done { id } => {
            if db.work_orders().delete(id).unwrap_or(false) {
                format!("Removed work order #{id}.")
            } else {
                format!("No work order #{id}.")
            }
        }
        WorkOrderSub::Add { item, qty } => {
            let open = db.work_orders().count().unwrap_or(0);
            if open >= MAX_OPEN_WORK_ORDERS {
                return format!(
                    "Too many open work orders (max {MAX_OPEN_WORK_ORDERS}). Mark some done first."
                );
            }
            let Some(ore) = find_ore(&item) else {
                return format!(
                    "No seed-ore match for \"{item}\" (craft blueprints need sc-craft, not ported). Try {prefix}econ ores."
                );
            };
            let lines = vec![WorkOrderLine {
                material: ore.name.to_string(),
                amount: qty as f64,
                unit: "SCU".into(),
            }];
            match db
                .work_orders()
                .add(ore.name, qty, &lines, Some(subject.uid.as_str()))
            {
                Ok(id) => format!(
                    "Okay — {qty}× {} takes {}. Saved as work order #{id}.\nOrg totals: {prefix}work-items",
                    ore.name,
                    format_lines(&lines)
                ),
                Err(e) => format!("Couldn't save work order: {e}"),
            }
        }
    }
}

fn cmd_work_items(db: &Database, prefix: &str) -> String {
    let orders = db.work_orders().list().unwrap_or_default();
    if orders.is_empty() {
        return format!("Nothing on the board. Add with {prefix}workorder <item> xN.");
    }
    let needs = mp_db::aggregate(&orders);
    let n = orders.len();
    format!(
        "The org needs {}.\n({n} open work order{} — {prefix}workorder list)",
        format_lines(&needs),
        if n == 1 { "" } else { "s" }
    )
}

fn format_lines(lines: &[WorkOrderLine]) -> String {
    if lines.is_empty() {
        return "nothing".into();
    }
    let parts: Vec<String> = lines
        .iter()
        .map(|l| {
            let boxes = mp_economy::calculate_boxes(l.amount);
            let name = &l.material;
            let unit = if l.unit.is_empty() { "SCU" } else { l.unit.as_str() };
            if unit.eq_ignore_ascii_case("scu") && !boxes.label.is_empty() {
                format!("{} SCU ({}) of {name}", l.amount, boxes.label)
            } else {
                format!("{} {unit} of {name}", l.amount)
            }
        })
        .collect();
    if parts.len() == 1 {
        parts[0].clone()
    } else if parts.len() == 2 {
        format!("{} and {}", parts[0], parts[1])
    } else {
        format!(
            "{}, and {}",
            parts[..parts.len() - 1].join(", "),
            parts[parts.len() - 1]
        )
    }
}
