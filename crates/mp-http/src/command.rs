// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Shared chat/voice dispose. Rights live here, never in the model.

use mp_brain::{TurnChannel, TurnMode, TurnOptions, TurnRequest, TurnSubject};
use mp_control::{CommandExecutor, ParsedCommand};
use mp_db::{Database, WorkOrderLine, parse_tag_select};
use mp_economy::{
    MAX_OPEN_WORK_ORDERS, WorkOrderSub, craft_bom_lines, find_ore, handle_craft, handle_econ_live,
    handle_mine, handle_refine, handle_trade, parse_workorder_args,
};
use mp_music::VoteAudience;
use mp_radio::{Boundary, CueResult, RadioRuntime};
use mp_rag::allowed_classifications_for;
use mp_rights::{RightsEngine, Scope, Subject};
use mp_voice::VoiceRuntime;

use crate::roast::RoastRuntime;
use crate::sc_org::ScOrgRuntime;

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
    voice: Option<&VoiceRuntime>,
    sc_org: Option<&ScOrgRuntime>,
    listeners: VoteAudience,
    session: Option<&crate::session_roles::SessionHandle>,
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
        "ops" => Some(
            cmd_ops(
                radio,
                rag,
                Some(executor.station.as_ref()),
                sc_org,
                &parsed.args,
            )
            .await,
        ),
        "karaoke" => Some(cmd_karaoke(voice, &executor.prefix, &parsed.args)),
        "ask" => Some(
            cmd_ask(
                brain,
                rights,
                subject,
                scope,
                &parsed.args,
                TurnMode::Ask,
                "ask",
            )
            .await,
        ),
        "analyst" | "agent" => Some(
            cmd_ask(
                brain,
                rights,
                subject,
                scope,
                &parsed.args,
                TurnMode::Delegate,
                parsed.name.as_str(),
            )
            .await,
        ),
        "rate" => Some(cmd_rate(db, executor, subject, parsed).await),
        "unrate" => Some(cmd_unrate(db, executor, subject)),
        "vote" => Some(executor.station.cast_vote(&subject.uid, listeners).await),
        "selecttracks" => Some(cmd_selecttracks(db, executor, &parsed.args).await),
        "ships" | "hangar" => Some(cmd_ships(db, rights, subject, scope, &parsed.args)),
        "session" => Some(cmd_session(&parsed.args, session).await),
        "ingeststatus" => Some(cmd_ingest(db)),
        "intsum" | "aar" => {
            Some(cmd_workflow(brain, rag, parsed.name.as_str(), &parsed.args, parsed.flags.contains(&'s'), subject).await)
        }
        "generate" => Some("ACE-Step music generation is not ported on the Rust bot.".into()),
        "reindex" => Some(cmd_reindex(rag, &parsed.args).await),
        "radio" => Some(cmd_radio(radio, &executor.prefix, parsed).await),
        "roast" => Some(cmd_roast(roast).await),
        "roastout" => Some(cmd_roastout(roast, &subject.uid)),
        "roastin" => Some(cmd_roastin(roast, &subject.uid)),
        "mine" => Some(handle_mine(&parsed.args, &executor.prefix)),
        "refine" => Some(handle_refine(&parsed.args, &executor.prefix)),
        "econ" => Some(handle_econ_live(&parsed.args, &executor.prefix).await),
        "craft" => Some(handle_craft(&parsed.args, &executor.prefix).await),
        "trade" => Some(handle_trade(&parsed.args, &executor.prefix).await),
        "workorder" => {
            Some(cmd_workorder(db, rights, subject, scope, &executor.prefix, &parsed.args).await)
        }
        "work-items" | "workitems" => Some(cmd_work_items(db, &executor.prefix)),
        "skip" | "next" => {
            if let Some(r) = radio {
                if r.enabled() {
                    executor.station.clear_user_pause();
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
            let topic = parsed
                .raw_args
                .get(1..)
                .map(|p| p.join(" "))
                .filter(|s| !s.trim().is_empty());
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
            let text = parsed
                .raw_args
                .get(1..)
                .map(|p| p.join(" "))
                .unwrap_or_default();
            let text = text.trim();
            if text.is_empty() {
                return format!("Usage: {prefix}radio say <text>");
            }
            match radio.cue_say(text).await {
                CueResult::Played => "📻 On air.".into(),
                CueResult::Cued => {
                    "📻 Liner cued — plays on next skip, track end, or dead air.".into()
                }
                CueResult::Unavailable => {
                    "Can't speak right now (radio off or TTS unavailable).".into()
                }
            }
        }
        "skipbumper" | "skip-bumper" | "skip" => {
            let msg = if radio.skip_bumper() == "cue" {
                "Cued bumper cancelled."
            } else {
                "Next scheduled bumper will be skipped."
            };
            if sub == "skip" {
                format!(
                    "{msg} (Tip: prefer {prefix}radio skipbumper — bare {prefix}skip is for the track.)"
                )
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
                Some(n) => format!(
                    " Next bumper in {n} track{}.",
                    if n == 1 { "" } else { "s" }
                ),
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
    rag.kg.handle_kg(
        args,
        Some(&subject.uid),
        can_write_org(rights, subject, scope),
    )
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
    rag.kg.handle_diary(
        args,
        Some(&subject.uid),
        can_write_org(rights, subject, scope),
    )
}

fn cmd_karaoke(voice: Option<&VoiceRuntime>, prefix: &str, args: &str) -> String {
    let sub = args
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let current = voice.map(|v| v.karaoke_mode()).unwrap_or(false);
    if sub.is_empty() || sub == "status" {
        return if current {
            "Karaoke ON — music stays loud while listening (duck 80).".into()
        } else {
            "Karaoke OFF — normal voice duck.".into()
        };
    }
    if sub != "on" && sub != "off" {
        return format!("Usage: {prefix}karaoke [on|off]");
    }
    let on = sub == "on";
    if let Some(v) = voice {
        v.set_karaoke_mode(on);
    }
    if on {
        "Karaoke ON — music stays loud while listening.".into()
    } else {
        "Karaoke OFF — back to normal duck.".into()
    }
}

fn ops_local_brief(
    radio: Option<&RadioRuntime>,
    rag: Option<&mp_rag::RagRuntime>,
    station: Option<&mp_music::MusicStation>,
) -> String {
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

async fn cmd_ops(
    radio: Option<&RadioRuntime>,
    rag: Option<&mp_rag::RagRuntime>,
    station: Option<&mp_music::MusicStation>,
    sc_org: Option<&ScOrgRuntime>,
    args: &str,
) -> String {
    let sub = args
        .trim()
        .split_whitespace()
        .next()
        .unwrap_or("status")
        .to_ascii_lowercase();
    let Some(org) = sc_org else {
        if matches!(sub.as_str(), "status" | "brief" | "") {
            return ops_local_brief(radio, rag, station);
        }
        return "Usage: !ops [status|brief|sc|host|members|fleet|list] — org brief + external status (fail-open).".into();
    };
    match sub.as_str() {
        "list" => "Status sources: sc-org (Star Citizen org status), host (Host health)".into(),
        "sc" | "star-citizen" => {
            let r = org.get_plugin("sc-org").await;
            format!("{} {}: {}", if r.ok { "✓" } else { "○" }, r.label, r.text)
        }
        "host" => {
            let r = org.get_plugin("host").await;
            format!("{} {}: {}", if r.ok { "✓" } else { "○" }, r.label, r.text)
        }
        "members" => org.members_text().await,
        "fleet" => org.fleet_text().await,
        "brief" => {
            let mut parts = Vec::new();
            if let Some(rag) = rag {
                let facts = rag.kg.list_facts(3);
                if facts.is_empty() {
                    parts.push("Org KG: (empty — !kg remember <fact>)".into());
                } else {
                    parts.push(format!(
                        "Org KG: {}",
                        facts
                            .iter()
                            .map(|f| f.fact.as_str())
                            .collect::<Vec<_>>()
                            .join("; ")
                    ));
                }
            }
            let sc = org.get_plugin("sc-org").await;
            parts.push(format!(
                "{} {}: {}",
                if sc.ok { "✓" } else { "○" },
                sc.label,
                sc.text
            ));
            if parts.is_empty() {
                "No brief available.".into()
            } else {
                parts.join("\n")
            }
        }
        "status" | "" => {
            let mut lines = vec![ops_local_brief(radio, rag, station)];
            for r in org.get_all().await {
                lines.push(format!(
                    "{} {}: {}",
                    if r.ok { "✓" } else { "○" },
                    r.label,
                    r.text
                ));
            }
            lines.join("\n")
        }
        other => {
            let r = org.get_plugin(other).await;
            if r.ok || r.id == other {
                format!("{} {}: {}", if r.ok { "✓" } else { "○" }, r.label, r.text)
            } else {
                "Usage: !ops [status|brief|sc|host|members|fleet|list] — org brief + external status (fail-open).".into()
            }
        }
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

async fn cmd_rate(
    db: &Database,
    executor: &CommandExecutor,
    subject: &Subject,
    parsed: &ParsedCommand,
) -> String {
    let p = &executor.prefix;
    let stars = parsed
        .raw_args
        .first()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    if !(1..=5).contains(&stars) {
        return format!("Usage: {p}rate <1-5> [song]");
    }
    let query = parsed.raw_args.get(1..).unwrap_or(&[]).join(" ");
    let target = if query.trim().is_empty() {
        executor
            .station
            .queue
            .lock()
            .expect("queue")
            .current()
            .map(|s| (s.id, s.name))
    } else {
        executor
            .station
            .search_first_flags_async(&query, &parsed.flags)
            .await
            .map(|t| (t.id, t.title))
    };
    let Some((id, name)) = target else {
        return if query.trim().is_empty() {
            "Nothing is playing to rate.".into()
        } else {
            format!("No results for: {query}")
        };
    };
    let rater = format!("ts:{}", subject.uid);
    if let Err(e) = db.tags().rate(&id, &rater, stars) {
        return format!("Could not rate: {e}");
    }
    format!("⭐ Rated \"{name}\" {stars}/5.")
}

async fn cmd_selecttracks(db: &Database, executor: &CommandExecutor, args: &str) -> String {
    let raw = if args.trim().is_empty() {
        "{}"
    } else {
        args.trim()
    };
    let Some(filter) = parse_tag_select(raw) else {
        return "Usage: selecttracks {\"genreAny\":[\"ambient\"],\"bpmMax\":110}".into();
    };
    let keys = match db.tags().select_tracks(&filter) {
        Ok(keys) => keys,
        Err(e) => return format!("Tag selection failed: {e}"),
    };
    let ordered = rotate_tag_keys(executor, &keys);
    let queued = executor.station.enqueue_local_ids(&ordered).await;
    match queued {
        0 => "No tracks match those tags.".into(),
        1 => "Queued 1 track by tags.".into(),
        n => format!("Queued {n} tracks by tags."),
    }
}

fn rotate_tag_keys(executor: &CommandExecutor, keys: &[String]) -> Vec<String> {
    if keys.len() <= 1 {
        return keys.to_vec();
    }
    mp_radio::order_keys_with_separation(
        keys,
        |key| {
            let song = executor.station.local.song_by_id(key)?;
            let artist = if song.artist != "Unknown Artist" && song.artist != "Unknown" && !song.artist.is_empty() {
                song.artist
            } else {
                song.title
                    .split_once(" - ")
                    .map(|(a, _)| a.to_string())
                    .unwrap_or(song.artist)
            };
            Some(mp_radio::RotationMeta {
                artist,
                album: song.album,
            })
        },
        mp_radio::SeparationPolicy::default(),
    )
}

fn cmd_ships(
    db: &Database,
    rights: Option<&RightsEngine>,
    subject: &Subject,
    scope: Scope,
    args: &str,
) -> String {
    let org_ok = rights.is_none_or(|e| e.can(subject, "ships.org", scope));
    match db.hangar().handle(args, &subject.uid, org_ok) {
        Ok(msg) => msg,
        Err(e) => format!("Hangar failed: {e}"),
    }
}

async fn cmd_session(args: &str, session: Option<&crate::session_roles::SessionHandle>) -> String {
    let Some(session) = session else {
        return crate::session_roles::handle_session(
            args,
            &crate::session_roles::SessionRolesConfig::default(),
            &[],
            None,
        )
        .await;
    };
    crate::session_roles::handle_session(
        args,
        &session.config,
        &session.permanent,
        session.query.as_deref(),
    )
    .await
}

fn cmd_ingest(db: &Database) -> String {
    let rows = db.file_drop().recent(10).unwrap_or_default();
    let enabled = std::env::var("FILE_DROP_ENABLED")
        .ok()
        .is_some_and(|v| matches!(v.as_str(), "1" | "true" | "yes"));
    mp_db::format_ingest_status(enabled, &rows)
}

async fn cmd_workflow(
    brain: &mp_brain::BrainRuntime,
    rag: Option<&mp_rag::RagRuntime>,
    name: &str,
    args: &str,
    save: bool,
    subject: &Subject,
) -> String {
    let (enabled, _, _) = brain.llm_snapshot().await;
    if !enabled {
        return crate::workflow::DELEGATE_UNCONFIGURED.into();
    }
    let kind = if name == "aar" {
        crate::workflow::WorkflowKind::Aar
    } else {
        crate::workflow::WorkflowKind::Intsum
    };
    let req = match crate::workflow::parse_workflow(kind, args, save) {
        Ok(req) => req,
        Err(e) => return e,
    };
    let today = utc_date();
    let task = crate::workflow::build_workflow_task(&req, &today);
    let system = crate::workflow::workflow_system(kind);
    match brain.complete_plain(system, &task).await {
        Some(doc) => {
            let body = if req.save {
                let path = crate::workflow::workflow_save_path(kind, &today);
                let saved = match rag.and_then(|r| r.doctrine.save_file(&path, &doc).ok().flatten()) {
                    Some(source) => Ok(source),
                    None => Err("knowledge base is not configured".to_string()),
                };
                crate::workflow::append_save_notice(&doc, saved.as_deref().map_err(|e| e.as_str()))
            } else {
                doc
            };
            crate::workflow::format_workflow_follow_up(kind, &body, subject.nickname.as_deref())
        }
        None => "Draft failed — the delegate model did not answer.".into(),
    }
}

fn utc_date() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

fn cmd_unrate(db: &Database, executor: &CommandExecutor, subject: &Subject) -> String {
    let Some(cur) = executor.station.queue.lock().expect("queue").current() else {
        return "Nothing is playing to unrate.".into();
    };
    let rater = format!("ts:{}", subject.uid);
    match db.tags().unrate(&cur.id, &rater) {
        Ok(true) => format!("Removed your rating for \"{}\".", cur.name),
        Ok(false) => format!("You hadn't rated \"{}\".", cur.name),
        Err(e) => format!("Could not unrate: {e}"),
    }
}

async fn cmd_ask(
    brain: &mp_brain::BrainRuntime,
    rights: Option<&RightsEngine>,
    subject: &Subject,
    scope: Scope,
    args: &str,
    mode: TurnMode,
    verb: &str,
) -> String {
    let q = args.trim();
    if q.is_empty() {
        return format!("Usage: !{verb} <question>");
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
        mode: Some(mode),
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
        mp_rag::reindex_sources(&rag.retrieval, &rag.doctrine, [arg.to_string()], true).await
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

async fn cmd_workorder(
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
            format!("Craft blueprint BOMs: {prefix}craft <name> (sc-craft.tools, fail-soft)."),
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
            let qty = qty.clamp(1, 999);
            let (label, lines) = if let Some(ore) = find_ore(&item) {
                (
                    ore.name.to_string(),
                    vec![WorkOrderLine {
                        material: ore.name.to_string(),
                        amount: qty as f64,
                        unit: "SCU".into(),
                    }],
                )
            } else if let Some(bom) = craft_bom_lines(&item, qty as u32).await {
                (
                    item.clone(),
                    bom.into_iter()
                        .map(|(material, amount, unit)| WorkOrderLine {
                            material,
                            amount,
                            unit,
                        })
                        .collect(),
                )
            } else {
                return format!(
                    "No seed-ore or sc-craft match for \"{item}\". Try {prefix}econ ores or {prefix}econ blueprints <name>."
                );
            };
            match db
                .work_orders()
                .add(&label, qty, &lines, Some(subject.uid.as_str()))
            {
                Ok(id) => format!(
                    "Okay — {qty}× {label} takes {}. Saved as work order #{id}.\nOrg totals: {prefix}work-items",
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
            let unit = if l.unit.is_empty() {
                "SCU"
            } else {
                l.unit.as_str()
            };
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

#[cfg(test)]
mod dispatch_tests {
    use super::*;
    use mp_control::{legacy_rights_config, parse_command, CommandExecutor};
    use mp_music::VoteAudience;
    use std::sync::Arc;

    fn world() -> (
        Database,
        CommandExecutor,
        RightsEngine,
        Arc<mp_brain::BrainRuntime>,
    ) {
        let db = Database::open_in_memory().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "mp-cmd-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("lib")).unwrap();
        std::fs::write(dir.join("lib/Alpha - calm1.mp3"), b"a").unwrap();
        std::fs::write(dir.join("lib/Alpha - calm2.mp3"), b"b").unwrap();
        std::fs::write(dir.join("lib/Beta - calm3.mp3"), b"c").unwrap();
        let station = Arc::new(mp_music::MusicStation::new(&dir, None));
        station.set_dry_run(true);
        let ex = CommandExecutor::new(station, "!");
        let rights = RightsEngine::new(legacy_rights_config(&[9]));
        let brain = mp_brain::BrainRuntime::disabled();
        (db, ex, rights, brain)
    }

    fn member() -> Subject {
        Subject {
            uid: "uid-1".into(),
            nickname: None,
            server_groups: vec![],
        }
    }

    async fn run(line: &str, subject: &Subject) -> String {
        let (db, ex, rights, brain) = world();
        let parsed = parse_command(line, "!", &mp_control::default_aliases()).unwrap();
        dispatch_command(
            &parsed,
            subject,
            Scope::Chat,
            &ex,
            Some(&rights),
            &db,
            brain.as_ref(),
            None,
            None,
            None,
            None,
            None,
            VoteAudience::NotOnTeamspeak,
            None,
        )
        .await
        .unwrap_or_default()
    }

    #[tokio::test]
    async fn ships_add_and_session_denied_and_workflow_unconfigured() {
        let added = run("!ships add Prospector x2", &member()).await;
        assert!(added.contains("Prospector"), "{added}");
        assert!(!added.to_lowercase().contains("not ported"), "{added}");
        let denied = run("!session status", &member()).await;
        assert!(denied.contains("permission"), "{denied}");
        let ingest = run("!ingeststatus", &member()).await;
        assert!(ingest.contains("permission"), "{ingest}");
        let intsum = run("!intsum alpha secure; comms ok", &member()).await;
        assert!(intsum.contains("not configured"), "{intsum}");
        let aar = run("!aar objective met", &member()).await;
        assert!(aar.contains("not configured"), "{aar}");
        let skip = run("!skip", &member()).await;
        assert!(!skip.to_lowercase().contains("model"), "{skip}");
    }

    #[tokio::test]
    async fn selecttracks_separates_artists_and_starts_when_idle() {
        let (db, ex, rights, brain) = world();
        for (id_name, genre) in [("calm1", "ambient"), ("calm2", "ambient"), ("calm3", "ambient")] {
            let song = ex
                .station
                .local
                .search(id_name, 1)
                .into_iter()
                .next()
                .unwrap();
            let mut tags = mp_db::TrackTags::default();
            tags.genre = Some(genre.into());
            db.tags()
                .upsert(&song.id, &tags, mp_db::TagSource::Analyzer)
                .unwrap();
        }
        let parsed = parse_command(
            "!selecttracks {\"genreAny\":[\"ambient\"]}",
            "!",
            &mp_control::default_aliases(),
        )
        .unwrap();
        let out = dispatch_command(
            &parsed,
            &member(),
            Scope::Chat,
            &ex,
            Some(&rights),
            &db,
            brain.as_ref(),
            None,
            None,
            None,
            None,
            None,
            VoteAudience::NotOnTeamspeak,
            None,
        )
        .await
        .unwrap();
        assert!(out.contains("Queued 3"), "{out}");
        let names: Vec<String> = ex
            .station
            .queue
            .lock()
            .unwrap()
            .list()
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(
            names,
            vec![
                "Alpha - calm1".to_string(),
                "Beta - calm3".to_string(),
                "Alpha - calm2".to_string()
            ]
        );
    }

    fn colonel() -> Subject {
        Subject {
            uid: "uid-9".into(),
            nickname: Some("Lane".into()),
            server_groups: vec!["9".into()],
        }
    }

    #[tokio::test]
    async fn admin_session_and_ingest_report_the_live_state() {
        let (db, ex, rights, brain) = world();
        db.file_drop()
            .record("k1", "intsum.md", "doctrine", "indexed")
            .unwrap();
        let who = colonel();
        let session = dispatch_command(
            &parse_command("!session status", "!", &mp_control::default_aliases()).unwrap(),
            &who,
            Scope::Chat,
            &ex,
            Some(&rights),
            &db,
            brain.as_ref(),
            None,
            None,
            None,
            None,
            None,
            VoteAudience::NotOnTeamspeak,
            None,
        )
        .await
        .unwrap();
        assert!(session.contains("Session roles"), "{session}");
        assert!(session.contains("HTTP Query"), "{session}");
        assert!(!session.to_lowercase().contains("not ported"), "{session}");
        let ingest = dispatch_command(
            &parse_command("!ingeststatus", "!", &mp_control::default_aliases()).unwrap(),
            &who,
            Scope::Chat,
            &ex,
            Some(&rights),
            &db,
            brain.as_ref(),
            None,
            None,
            None,
            None,
            None,
            VoteAudience::NotOnTeamspeak,
            None,
        )
        .await
        .unwrap();
        assert!(ingest.contains("intsum.md"), "{ingest}");
        assert!(ingest.contains("📎"), "{ingest}");
        let denied = dispatch_command(
            &parse_command("!ships org", "!", &mp_control::default_aliases()).unwrap(),
            &member(),
            Scope::Chat,
            &ex,
            Some(&rights),
            &db,
            brain.as_ref(),
            None,
            None,
            None,
            None,
            None,
            VoteAudience::NotOnTeamspeak,
            None,
        )
        .await
        .unwrap();
        assert!(denied.contains("ships.org"), "{denied}");
    }

    struct MemQuery {
        members: std::sync::Mutex<std::collections::HashMap<i64, Vec<i64>>>,
    }

    impl crate::session_roles::SessionQuery for MemQuery {
        fn list_members<'a>(
            &'a self,
            sgid: i64,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Vec<i64>, String>> + Send + 'a>,
        > {
            Box::pin(async move {
                Ok(self
                    .members
                    .lock()
                    .expect("members")
                    .get(&sgid)
                    .cloned()
                    .unwrap_or_default())
            })
        }

        fn remove_member<'a>(
            &'a self,
            sgid: i64,
            cldbid: i64,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>
        {
            Box::pin(async move {
                if let Some(ids) = self.members.lock().expect("members").get_mut(&sgid) {
                    ids.retain(|id| *id != cldbid);
                }
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn session_dispatch_clears_configured_groups() {
        let (db, ex, rights, brain) = world();
        let query = std::sync::Arc::new(MemQuery {
            members: std::sync::Mutex::new(std::collections::HashMap::from([(201, vec![10, 11])])),
        });
        let handle = crate::session_roles::SessionHandle::new(
            crate::session_roles::SessionRolesConfig {
                group_ids: vec![201],
                ..crate::session_roles::SessionRolesConfig::default()
            },
            vec![9],
            Some(query.clone()),
        );
        let dry = dispatch_command(
            &parse_command("!session clear dry", "!", &mp_control::default_aliases()).unwrap(),
            &colonel(),
            Scope::Chat,
            &ex,
            Some(&rights),
            &db,
            brain.as_ref(),
            None,
            None,
            None,
            None,
            None,
            VoteAudience::NotOnTeamspeak,
            Some(&handle),
        )
        .await
        .unwrap();
        assert!(dry.contains("Would remove 2 memberships"), "{dry}");
        assert!(dry.contains("Dry run"), "{dry}");
        assert_eq!(query.members.lock().unwrap().get(&201).unwrap(), &vec![10, 11]);
        let parsed = parse_command("!session clear", "!", &mp_control::default_aliases()).unwrap();
        let out = dispatch_command(
            &parsed,
            &colonel(),
            Scope::Chat,
            &ex,
            Some(&rights),
            &db,
            brain.as_ref(),
            None,
            None,
            None,
            None,
            None,
            VoteAudience::NotOnTeamspeak,
            Some(&handle),
        )
        .await
        .unwrap();
        assert!(out.contains("201") || out.contains("Removed 2"), "{out}");
        assert!(out.contains("Removed 2 memberships"), "{out}");
        assert!(out.contains("2 listed"), "{out}");
        assert!(query.members.lock().unwrap().get(&201).unwrap().is_empty());
        let status = dispatch_command(
            &parse_command("!session status", "!", &mp_control::default_aliases()).unwrap(),
            &colonel(),
            Scope::Chat,
            &ex,
            Some(&rights),
            &db,
            brain.as_ref(),
            None,
            None,
            None,
            None,
            None,
            VoteAudience::NotOnTeamspeak,
            Some(&handle),
        )
        .await
        .unwrap();
        assert!(status.contains("201"), "{status}");
        assert!(status.contains("available"), "{status}");
    }

    #[tokio::test]
    async fn session_clear_refuses_rights_rule_groups() {
        let (db, ex, rights, brain) = world();
        let query = std::sync::Arc::new(MemQuery {
            members: std::sync::Mutex::new(std::collections::HashMap::from([
                (100, vec![1]),
                (201, vec![2]),
            ])),
        });
        let mut cfg = mp_config::BotConfig::default();
        cfg.admin_groups = vec![9];
        cfg.rights = Some(serde_json::json!({
            "rules": [
                {"match": {"serverGroups": [100, "101"]}, "scope": "not-a-scope"},
                {"match": {"serverGroups": ["106"]}}
            ]
        }));
        cfg.session_roles.group_ids = vec![100, 201];
        let handle = crate::session_roles::SessionHandle::from_bot_config(
            &cfg,
            Some(query.clone() as std::sync::Arc<dyn crate::session_roles::SessionQuery>),
        );
        assert_eq!(handle.permanent, vec![9, 100, 101, 106]);
        let out = dispatch_command(
            &parse_command("!session clear", "!", &mp_control::default_aliases()).unwrap(),
            &colonel(),
            Scope::Chat,
            &ex,
            Some(&rights),
            &db,
            brain.as_ref(),
            None,
            None,
            None,
            None,
            None,
            VoteAudience::NotOnTeamspeak,
            Some(&handle),
        )
        .await
        .unwrap();
        assert!(out.contains("Removed 1 membership"), "{out}");
        assert!(out.contains("Skipped"), "{out}");
        assert!(out.contains("100"), "{out}");
        assert_eq!(query.members.lock().unwrap().get(&100).unwrap(), &vec![1]);
        assert!(query.members.lock().unwrap().get(&201).unwrap().is_empty());
    }

    #[tokio::test]
    async fn manifest_commands_other_than_generate_are_not_unported() {
        let (db, ex, rights, brain) = world();
        ex.station.set_connected(false);
        let who = member();
        for spec in mp_control::COMMAND_MANIFEST {
            if spec.name == "generate" {
                continue;
            }
            let parsed =
                parse_command(&format!("!{}", spec.name), "!", &mp_control::default_aliases())
                    .unwrap();
            let out = dispatch_command(
                &parsed,
                &who,
                Scope::Chat,
                &ex,
                Some(&rights),
                &db,
                brain.as_ref(),
                None,
                None,
                None,
                None,
                None,
                VoteAudience::NotOnTeamspeak,
                None,
            )
            .await
            .unwrap_or_default();
            assert!(
                !out.to_lowercase().contains("not ported"),
                "{}: {out}",
                spec.name
            );
        }
        let generated = run("!generate", &member()).await;
        assert!(generated.contains("ACE-Step"), "{generated}");
    }

    #[tokio::test]
    async fn intsum_sends_the_skeleton_and_saves_when_flagged() {
        let (db, ex, rights, _brain) = world();
        let mut settings = mp_brain::LlmSettings::default();
        settings.enabled = true;
        settings.url = "http://127.0.0.1:9".into();
        settings.model = "test".into();
        let brain = mp_brain::BrainRuntime::from_settings(settings);
        let seen = std::sync::Arc::new(std::sync::Mutex::new((String::new(), String::new())));
        let seen_hook = std::sync::Arc::clone(&seen);
        brain
            .set_plain_hook(Some(std::sync::Arc::new(move |system, user| {
                *seen_hook.lock().expect("seen") = (system.to_string(), user.to_string());
                Some("# INTSUM\nbody".into())
            })))
            .await;
        let dir = std::env::temp_dir().join(format!(
            "mp-wf-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let retrieval = std::sync::Arc::new(mp_rag::RetrievalStore::new(
            mp_rag::Embedder::Hash { dim: 8 },
            mp_rag::VectorStore::Memory(mp_rag::MemoryVectorStore::new()),
            "t".into(),
            4,
        ));
        let doctrine = std::sync::Arc::new(
            mp_rag::DoctrineStore::new(std::sync::Arc::new(Database::open_in_memory().unwrap()), &dir)
                .unwrap(),
        );
        let rag = mp_rag::RagRuntime::new(retrieval, doctrine, false, false, 4);
        let parsed = parse_command(
            "!intsum -s class:secret alpha secure; comms ok",
            "!",
            &mp_control::default_aliases(),
        )
        .unwrap();
        let out = dispatch_command(
            &parsed,
            &colonel(),
            Scope::Chat,
            &ex,
            Some(&rights),
            &db,
            brain.as_ref(),
            Some(rag.as_ref()),
            None,
            None,
            None,
            None,
            VoteAudience::NotOnTeamspeak,
            None,
        )
        .await
        .unwrap();
        let (system, user) = seen.lock().expect("seen").clone();
        assert!(system.contains("INTSUM"), "{system}");
        assert!(user.contains("classification: secret"), "{user}");
        assert!(user.contains("## Executive Summary"), "{user}");
        assert!(user.contains("1. alpha secure"), "{user}");
        assert!(user.contains("2. comms ok"), "{user}");
        assert!(!user.contains("alpha secure; comms ok"), "{user}");
        assert!(out.contains("Saved to knowledge base"), "{out}");
        assert!(out.contains("intel/intsum-"), "{out}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
