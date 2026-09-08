// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Bumper sources: prerecorded pool, station ID, time check, now playing,
//! doctrine (RAG clip-and-speak), memory (org KG only). TTS optional.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use mp_brain::BrainRuntime;
use mp_config::{BumperSource, RadioConfig, WheelSlot};
use mp_music::MusicStation;
use mp_rag::{KgService, MemPalaceClient, RetrievalStore};
use mp_voice::HttpTtsClient;

use crate::director::{BuiltBumper, BumperFactory};
use crate::prerecorded::PrerecordedPool;

const META_PHRASES: &[&str] = &[
    "do not invent",
    "invent nothing",
    "only rephrase",
    "rephrase the",
    "rephrase what",
    "rephrase this",
    "rephrase provided",
    "rewrite the",
    "rewrite a",
    "rewrite this",
    "rewrite provided",
    "provided text",
    "no markdown",
    "no lists",
    "plain speech only",
    "output only",
    "spoken line",
    "spoken sentence",
    "spoken radio bumper",
    "you are a radio",
    "tool_choice",
    "system prompt",
    "agents.md",
    "playbook",
    "the prompt asks",
    "prompt asks",
    "as a radio",
    "as the radio",
    "short radio bumper",
    "from source only",
    "do not speak this",
];

const TOOLING_PHRASES: &[&str] = &[
    "docker compose",
    "qdrant",
    "mempalace",
    "ragenabled",
    "server-group",
    "server groups",
    "!reindex",
    "!remember",
    "!analyst",
];

pub struct LiveBumperFactory {
    pub station_name: String,
    station: Mutex<Option<Arc<MusicStation>>>,
    tts_url: Mutex<String>,
    tts_voice: Mutex<String>,
    pub tmp_dir: PathBuf,
    pub prerecorded: PrerecordedPool,
    retrieval: Mutex<Option<Arc<RetrievalStore>>>,
    mempalace: Mutex<Option<MemPalaceClient>>,
    kg: Mutex<Option<Arc<KgService>>>,
    llm: Mutex<Option<Arc<BrainRuntime>>>,
}

impl LiveBumperFactory {
    pub fn new(station_name: String) -> Self {
        let tmp_dir = std::env::temp_dir().join("moneypenny-radio");
        let _ = std::fs::create_dir_all(&tmp_dir);
        let bumper_dir = std::env::var("RADIO_BUMPER_DIR")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("moneypenny-bumpers"));
        Self {
            station_name,
            station: Mutex::new(None),
            tts_url: Mutex::new(String::new()),
            tts_voice: Mutex::new("en_GB-cori-high".into()),
            tmp_dir,
            prerecorded: PrerecordedPool::new(bumper_dir),
            retrieval: Mutex::new(None),
            mempalace: Mutex::new(None),
            kg: Mutex::new(None),
            llm: Mutex::new(None),
        }
    }

    pub fn set_station(&self, station: Arc<MusicStation>) {
        *self.station.lock().expect("st") = Some(station);
    }

    pub fn set_tts(&self, url: String, voice: String) {
        *self.tts_url.lock().expect("tts") = url;
        if !voice.is_empty() {
            *self.tts_voice.lock().expect("tts") = voice;
        }
    }

    pub fn set_bumper_dir(&self, dir: PathBuf) {
        self.prerecorded.set_dir(dir);
    }

    pub fn set_retrieval(&self, retrieval: Arc<RetrievalStore>) {
        *self.retrieval.lock().expect("retrieval") = Some(retrieval);
    }

    pub fn set_mempalace(&self, client: MemPalaceClient) {
        *self.mempalace.lock().expect("mempalace") = Some(client);
    }

    pub fn set_kg(&self, kg: Arc<KgService>) {
        *self.kg.lock().expect("kg") = Some(kg);
    }

    pub fn set_llm(&self, llm: Arc<BrainRuntime>) {
        *self.llm.lock().expect("llm") = Some(llm);
    }

    async fn rewrite_script(&self, material: &str, cap: usize, tone: &str) -> Option<String> {
        let clip = clip_words(material, 120);
        let llm = self.llm.lock().ok().and_then(|g| g.clone());
        let llm_out = if let Some(brain) = llm {
            brain
                .complete_plain(&bumper_rewrite_system(cap, tone), &clip)
                .await
                .unwrap_or_default()
        } else {
            String::new()
        };
        finalize_bumper_script(&llm_out, material, cap).map(|f| f.script)
    }

    fn expand(&self, line: &str) -> String {
        line.replace("{name}", &self.station_name)
            .replace("{station}", &self.station_name)
    }

    pub fn station_id_text(&self, cfg: &RadioConfig) -> String {
        let lines: Vec<String> = if cfg.station_id_lines.is_empty() {
            vec![
                format!("This is {}.", self.station_name),
                format!("You're listening to {}.", self.station_name),
                format!("Stay tuned on {}.", self.station_name),
            ]
        } else {
            cfg.station_id_lines.iter().map(|l| self.expand(l)).collect()
        };
        lines.join(" ")
    }

    pub fn time_check_text(&self) -> String {
        let hhmm = std::process::Command::new("date")
            .arg("+%H:%M")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "now".into());
        format!("The time is {hhmm}.")
    }

    pub fn now_playing_text(&self) -> Option<String> {
        let guard = self.station.lock().ok()?;
        let station = guard.as_ref()?;
        let cur = station.queue.lock().ok()?.current()?;
        Some(format!("Now playing: {} by {}.", cur.name, cur.artist))
    }

    async fn speak(&self, text: &str, label: &str) -> Option<BuiltBumper> {
        let url = self.tts_url.lock().expect("tts").clone();
        if url.trim().is_empty() {
            tracing::debug!(label, "radio: bumper skipped — no TTS URL");
            return None;
        }
        let voice = self.tts_voice.lock().expect("tts").clone();
        let client = HttpTtsClient::new(&url, &voice);
        let (audio, format) = client.synthesize(text).await.ok()?;
        if audio.is_empty() {
            return None;
        }
        let name = format!(
            "bumper-{}-{}.{}",
            label,
            uuid::Uuid::new_v4().simple(),
            if format.is_empty() { "wav" } else { format.as_str() }
        );
        let path = self.tmp_dir.join(name);
        std::fs::write(&path, audio).ok()?;
        Some(BuiltBumper {
            path: path.to_string_lossy().into_owned(),
            label: label.into(),
        })
    }

    async fn doctrine_bumper(&self, cfg: &RadioConfig, topic_override: Option<&str>) -> Option<BuiltBumper> {
        let retrieval = self.retrieval.lock().ok()?.clone()?;
        let profile = cfg.profiles.get(&cfg.active_profile);
        let topics: Vec<String> = if let Some(t) = topic_override.map(str::trim).filter(|s| !s.is_empty()) {
            vec![t.to_string()]
        } else {
            profile
                .map(|p| {
                    p.bumper
                        .topics
                        .iter()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default()
        };
        if topics.is_empty() {
            tracing::info!(
                profile = %cfg.active_profile,
                "radio: doctrine skip — no bumper topics on active profile"
            );
            return None;
        }
        let order = if topic_override.is_some() {
            topics
        } else {
            shuffle_topics(topics)
        };
        let floor = vec!["unclassified".to_string()];
        let mut material: Option<String> = None;
        let mut topic_used = order.first().cloned().unwrap_or_default();
        let mut source_hit = String::new();
        let mut skipped_meta = 0u32;
        for topic in &order {
            let chunks = retrieval.query(topic, Some(6), Some(&floor)).await;
            for chunk in chunks {
                let hit = chunk.text.trim();
                if hit.is_empty() {
                    continue;
                }
                if !is_bumper_eligible_source(&chunk.source) || !is_bumper_eligible_material(hit) {
                    skipped_meta += 1;
                    continue;
                }
                material = Some(hit.to_string());
                topic_used = topic.clone();
                source_hit = chunk.source;
                break;
            }
            if material.is_some() {
                break;
            }
        }
        let Some(material) = material else {
            tracing::info!(
                topics = ?order,
                skipped_meta,
                "radio: doctrine skip — no air-eligible RAG hits"
            );
            return None;
        };
        let cap = word_cap(cfg.max_bumper_seconds);
        let tone = profile.map(|p| p.bumper.tone.as_str()).unwrap_or("");
        let script = self.rewrite_script(&material, cap, tone).await?;
        let built = self.speak(&script, "doctrine").await;
        if built.is_some() {
            tracing::info!(
                topic = %topic_used,
                source = %source_hit,
                script = %script,
                "radio: doctrine bumper built"
            );
        }
        built
    }

    async fn memory_bumper(&self, cfg: &RadioConfig, topic_override: Option<&str>) -> Option<BuiltBumper> {
        if !cfg.memory_broadcast_opt_in {
            return None;
        }
        let kg = self.kg.lock().ok().and_then(|g| g.clone());
        let mempalace = self.mempalace.lock().ok().and_then(|g| g.clone());
        if kg.is_none() && mempalace.is_none() {
            return None;
        }
        let profile = cfg.profiles.get(&cfg.active_profile);
        let topics: Vec<String> = if let Some(t) = topic_override.map(str::trim).filter(|s| !s.is_empty()) {
            vec![t.to_string()]
        } else if let Some(p) = profile {
            let t: Vec<String> = p
                .bumper
                .topics
                .iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if t.is_empty() {
                vec!["organization roles operations".into()]
            } else {
                t
            }
        } else {
            vec!["organization roles operations".into()]
        };
        let topic = topics
            .get(nanos() as usize % topics.len().max(1))
            .cloned()
            .unwrap_or_else(|| "organization roles operations".into());
        let hits = if let Some(kg) = kg {
            kg.search_org(&topic, 5).await
        } else if let Some(mp) = mempalace {
            mp.kg_search(&topic, 5).await
        } else {
            Vec::new()
        };
        let material = hits
            .into_iter()
            .map(|f| f.trim().to_string())
            .find(|f| !f.is_empty() && is_bumper_eligible_material(f));
        let Some(material) = material else {
            tracing::info!(topic = %topic, "radio: memory skip — no org KG hits");
            return None;
        };
        let cap = word_cap(cfg.max_bumper_seconds);
        let tone = profile.map(|p| p.bumper.tone.as_str()).unwrap_or("");
        let script = self.rewrite_script(&material, cap, tone).await?;
        let built = self.speak(&script, "memory").await;
        if built.is_some() {
            tracing::info!(topic = %topic, script = %script, "radio: memory bumper built");
        }
        built
    }
}

impl BumperFactory for LiveBumperFactory {
    async fn build(&self, slot: WheelSlot) -> Option<BuiltBumper> {
        build_from_sources(self, &RadioConfig::default(), slot).await
    }

    async fn say(&self, text: &str) -> Option<BuiltBumper> {
        self.speak(text, "say").await
    }
}

/// Build with live config lines (station ID from settings).
pub async fn build_from_sources(
    factory: &LiveBumperFactory,
    cfg: &RadioConfig,
    slot: WheelSlot,
) -> Option<BuiltBumper> {
    let sources = if slot.sources.is_empty() {
        cfg.sources.clone()
    } else {
        slot.sources.clone()
    };
    let topic = slot.topic.clone();
    for src in sources {
        let built = match src {
            BumperSource::Prerecorded => factory.prerecorded.pick().map(|path| BuiltBumper {
                path,
                label: "prerecorded".into(),
            }),
            BumperSource::StationId => {
                factory
                    .speak(&factory.station_id_text(cfg), src.as_str())
                    .await
            }
            BumperSource::TimeCheck => factory.speak(&factory.time_check_text(), src.as_str()).await,
            BumperSource::NowPlaying => {
                if let Some(text) = factory.now_playing_text() {
                    factory.speak(&text, src.as_str()).await
                } else {
                    None
                }
            }
            BumperSource::Doctrine => factory.doctrine_bumper(cfg, topic.as_deref()).await,
            BumperSource::Memory => factory.memory_bumper(cfg, topic.as_deref()).await,
        };
        if built.is_some() {
            return built;
        }
    }
    None
}

fn word_cap(seconds: u32) -> usize {
    20.max(((seconds as f64) * 2.5).round() as usize)
}

fn clip_words(text: &str, n: usize) -> String {
    text.split_whitespace().take(n).collect::<Vec<_>>().join(" ")
}

pub fn is_bumper_eligible_source(source: &str) -> bool {
    let s = source.replace('\\', "/").to_ascii_lowercase();
    if s.is_empty() {
        return true;
    }
    let skip = s.contains("/ops/")
        || s.starts_with("ops/")
        || s.contains("rag-ingestion")
        || s.contains("cheatsheet")
        || s.contains("rank-gating")
        || s.ends_with("agents.md")
        || s.ends_with("/readme.md")
        || s == "readme.md"
        || s.contains("roadmap")
        || s.contains("changelog");
    !skip
}

pub fn is_meta_bumper_script(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return true;
    }
    let low = t.to_ascii_lowercase();
    if META_PHRASES.iter().any(|p| low.contains(p)) {
        return true;
    }
    if low.contains("the prompt")
        || low.contains("this prompt")
        || low.contains("your prompt")
        || low.contains("the instruction")
        || low.contains("as instructed")
    {
        return true;
    }
    let first = low.split([':', '=']).next().unwrap_or("").trim();
    if matches!(
        first,
        "role" | "constraint" | "tone" | "thinking" | "note" | "step" | "rule" | "system" | "user"
    ) {
        return true;
    }
    let words = t.split_whitespace().count();
    if words <= 12 && (low.contains("radio bumper") || low.contains("spoken line") || low.contains("announcement"))
    {
        return true;
    }
    false
}

pub fn is_bumper_eligible_material(text: &str) -> bool {
    let t = text.trim();
    if t.len() < 12 {
        return false;
    }
    if t.starts_with("---") && t[..t.len().min(400)].to_ascii_lowercase().contains("classification") {
        return false;
    }
    if is_meta_bumper_script(t) {
        return false;
    }
    let lines: Vec<&str> = t.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.len() >= 3 {
        let pipe = lines
            .iter()
            .filter(|l| l.chars().filter(|c| *c == '|').count() >= 2)
            .count();
        if pipe as f64 / lines.len() as f64 > 0.4 {
            return false;
        }
    }
    let low = t.to_ascii_lowercase();
    if TOOLING_PHRASES.iter().any(|p| low.contains(p)) {
        return false;
    }
    true
}

fn clip_material_for_speech(material: &str, cap: usize) -> Option<String> {
    if !is_bumper_eligible_material(material) {
        return None;
    }
    let limit = cap.min(45);
    let sentences = sentence_matches(material.trim());
    if sentences.is_empty() {
        return None;
    }
    let mut out: Vec<String> = Vec::new();
    let mut words = 0usize;
    for sentence in sentences {
        let sentence = sentence.trim();
        let Some(first) = sentence.chars().next() else {
            continue;
        };
        if !(first.is_ascii_uppercase() || first.is_ascii_digit()) || sentence.len() < 16 {
            continue;
        }
        let n = sentence.split_whitespace().count();
        if words + n > limit {
            break;
        }
        out.push(sentence.to_string());
        words += n;
        if out.len() >= 2 {
            break;
        }
    }
    let clip = out.join(" ").trim().to_string();
    if clip.is_empty() || is_meta_bumper_script(&clip) {
        None
    } else {
        Some(clip)
    }
}

fn sentence_matches(material: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in material.chars() {
        if c == '\n' {
            if !cur.trim().is_empty() {
                // newline without terminator — drop fragment
                cur.clear();
            }
            continue;
        }
        cur.push(c);
        if matches!(c, '.' | '!' | '?') {
            let t = cur.trim().to_string();
            if !t.is_empty() {
                out.push(t);
            }
            cur.clear();
        }
    }
    out
}

fn speakable_clip(material: &str, cap: usize) -> Option<String> {
    let clipped = clip_words(material, 120);
    if let Some(s) = clip_material_for_speech(&clipped, cap) {
        return Some(s);
    }
    let fallback = clip_words(&clipped, cap.min(45));
    if fallback.len() >= 12 && is_bumper_eligible_material(&fallback) && !is_meta_bumper_script(&fallback) {
        Some(fallback)
    } else {
        None
    }
}

const GROUND_STOP: &[&str] = &[
    "a", "an", "the", "and", "or", "of", "to", "in", "for", "on", "with", "is", "are", "was",
    "were", "be", "as", "at", "by", "from", "that", "this", "it", "its", "our", "we", "you",
    "your", "will", "can", "may", "not", "only", "one", "short", "radio", "bumper", "spoken",
    "line", "announcement", "note", "please", "here", "do", "does", "did", "should", "would",
    "could", "must",
];

fn content_tokens(text: &str) -> Vec<String> {
    text.to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '\'' || c == '-' {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .map(|w| w.trim_matches('\'').to_string())
        .filter(|w| w.len() > 2 && !GROUND_STOP.contains(&w.as_str()))
        .collect()
}

pub fn is_grounded_in_material(script: &str, material: &str) -> bool {
    let src: std::collections::HashSet<String> = content_tokens(material).into_iter().collect();
    let words = content_tokens(script);
    if src.is_empty() || words.is_empty() {
        return false;
    }
    let hits = words.iter().filter(|w| src.contains(*w)).count();
    if hits >= 2 && (hits as f64) / (words.len() as f64) >= 0.2 {
        return true;
    }
    words.len() <= 14 && hits >= 2 && (hits as f64) / (words.len() as f64) >= 0.35
}

pub fn clean_bumper_script(raw: &str) -> Option<String> {
    let mut t = raw.trim().to_string();
    if t.is_empty() {
        return None;
    }
    if t.starts_with("```") {
        t = t.trim_start_matches('`').trim().to_string();
        if let Some(pos) = t.find("```") {
            t = t[..pos].trim().to_string();
        }
    }
    for prefix in [
        "spoken line:",
        "bumper:",
        "announcement:",
        "here's a line:",
        "here is a line:",
        "here's the bumper:",
        "here is the bumper:",
    ] {
        if t.to_ascii_lowercase().starts_with(prefix) {
            t = t[prefix.len()..].trim().to_string();
        }
    }
    t = t
        .trim_matches(|c: char| matches!(c, '"' | '\'' | '«' | '»'))
        .trim()
        .to_string();
    if t.to_ascii_lowercase().starts_with("rewrite") {
        if let Some(i) = t.find(['.', '!', '?']) {
            t = t[i + 1..].trim().to_string();
        }
    }
    if t.is_empty() || is_meta_bumper_script(&t) {
        None
    } else {
        Some(t)
    }
}

pub struct FinalizedBumper {
    pub script: String,
    #[allow(dead_code)]
    pub from: &'static str,
}

pub fn finalize_bumper_script(llm_out: &str, material: &str, cap: usize) -> Option<FinalizedBumper> {
    if let Some(cleaned) = clean_bumper_script(llm_out) {
        let capped = clip_words(&cleaned, cap);
        if is_grounded_in_material(&capped, material) {
            return Some(FinalizedBumper {
                script: capped,
                from: "llm",
            });
        }
    }
    speakable_clip(material, cap).map(|script| FinalizedBumper {
        script,
        from: "material",
    })
}

pub fn bumper_rewrite_system(cap: usize, tone_hint: &str) -> String {
    let style = if tone_hint.trim().is_empty() {
        String::new()
    } else {
        format!(" Voice style (never say this aloud): {}.", tone_hint.trim())
    };
    format!(
        "You are on live radio. The user message is a doctrine note. \
Reply with only the spoken words (one or two short sentences, under {cap} words). \
Use only facts from the user message. No labels, quotes, markdown, or talk about prompts.{style}\n\n\
Example user: The Office of Organizational Analysis provides independent analysis for the Talon Group.\n\
Example reply: The Office of Organizational Analysis keeps Talon operations sharp with independent analysis.\n\n\
Example user: Heavies establish the perimeter before the larger ships jump in.\n\
Example reply: Heavies set the perimeter before the larger ships jump."
    )
}

fn nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(1)
}

fn shuffle_topics(mut topics: Vec<String>) -> Vec<String> {
    let mut seed = nanos() as u64;
    for i in (1..topics.len()).rev() {
        seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        let j = (seed as usize) % (i + 1);
        topics.swap(i, j);
    }
    topics
}

#[cfg(test)]
mod tests {
    use super::*;
    use mp_config::SlotKind;

    #[test]
    fn default_station_id_mentions_name() {
        let f = LiveBumperFactory::new("Moneypenny".into());
        let t = f.station_id_text(&RadioConfig::default());
        assert!(t.contains("Moneypenny"));
        assert!(t.contains("This is"));
    }

    #[test]
    fn skips_ops_and_cheatsheets() {
        assert!(!is_bumper_eligible_source("ops/rag-ingestion-cheatsheet.md"));
        assert!(!is_bumper_eligible_source("docs/changelog.md"));
        assert!(is_bumper_eligible_source("combat.md"));
    }

    #[test]
    fn skips_tooling_material() {
        assert!(!is_bumper_eligible_material("run docker compose up"));
        assert!(!is_bumper_eligible_material("short"));
        assert!(is_bumper_eligible_material(
            "Heavies establish the perimeter before jump. Stay tight on the lead."
        ));
    }

    #[test]
    fn sentence_clip_stops_at_period() {
        let s = clip_material_for_speech(
            "Heavies establish the perimeter before jump. Then the rest follow in.",
            40,
        )
        .unwrap();
        assert!(s.starts_with("Heavies establish"));
        assert!(s.contains('.'));
    }

    #[tokio::test]
    async fn prerecorded_source_returns_file_path() {
        let dir = std::env::temp_dir().join(format!("mp-radio-pr-{}", nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("id.wav"), b"RIFF").unwrap();
        let f = LiveBumperFactory::new("Moneypenny".into());
        f.set_bumper_dir(dir.clone());
        let slot = WheelSlot {
            slot: SlotKind::Bumper,
            sources: vec![BumperSource::Prerecorded],
            topic: None,
        };
        let b = build_from_sources(&f, &RadioConfig::default(), slot)
            .await
            .unwrap();
        assert_eq!(b.label, "prerecorded");
        assert!(b.path.ends_with("id.wav"), "{}", b.path);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn doctrine_without_retrieval_is_none() {
        let f = LiveBumperFactory::new("Moneypenny".into());
        let slot = WheelSlot {
            slot: SlotKind::Bumper,
            sources: vec![BumperSource::Doctrine],
            topic: Some("welcome".into()),
        };
        assert!(build_from_sources(&f, &RadioConfig::default(), slot)
            .await
            .is_none());
    }

    #[test]
    fn grounded_rewrite_accepted() {
        let material = "Heavies establish the perimeter before jump.";
        let out = finalize_bumper_script(
            "Heavies set the perimeter before jump.",
            material,
            40,
        )
        .unwrap();
        assert_eq!(out.from, "llm");
        assert!(out.script.to_ascii_lowercase().contains("heavies"));
    }

    #[test]
    fn ungrounded_llm_falls_back_to_material() {
        let material = "Heavies establish the perimeter before jump. Stay tight on the lead.";
        let out = finalize_bumper_script(
            "The prompt asks to speak ONE short radio bumper about snacks.",
            material,
            40,
        )
        .unwrap();
        assert_eq!(out.from, "material");
        assert!(out.script.contains("Heavies"));
    }

    #[tokio::test]
    async fn memory_without_opt_in_is_none() {
        let f = LiveBumperFactory::new("Moneypenny".into());
        let slot = WheelSlot {
            slot: SlotKind::Bumper,
            sources: vec![BumperSource::Memory],
            topic: None,
        };
        assert!(build_from_sources(&f, &RadioConfig::default(), slot)
            .await
            .is_none());
    }
}
