// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Non-LLM bumper sources: station ID, time check, now playing. TTS optional.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use mp_config::{BumperSource, RadioConfig, WheelSlot};
use mp_music::MusicStation;
use mp_voice::HttpTtsClient;

use crate::director::{BuiltBumper, BumperFactory};

pub struct LiveBumperFactory {
    pub station_name: String,
    station: Mutex<Option<Arc<MusicStation>>>,
    tts_url: Mutex<String>,
    tts_voice: Mutex<String>,
    pub tmp_dir: PathBuf,
}

impl LiveBumperFactory {
    pub fn new(station_name: String) -> Self {
        let tmp_dir = std::env::temp_dir().join("moneypenny-radio");
        let _ = std::fs::create_dir_all(&tmp_dir);
        Self {
            station_name,
            station: Mutex::new(None),
            tts_url: Mutex::new(String::new()),
            tts_voice: Mutex::new("en_GB-cori-high".into()),
            tmp_dir,
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
}

impl BumperFactory for LiveBumperFactory {
    async fn build(&self, slot: WheelSlot) -> Option<BuiltBumper> {
        let cfg = RadioConfig::default();
        let _ = cfg;
        for src in &slot.sources {
            let text = match src {
                BumperSource::StationId => Some(self.station_id_text(&RadioConfig {
                    station_id_lines: Vec::new(),
                    ..RadioConfig::default()
                })),
                BumperSource::TimeCheck => Some(self.time_check_text()),
                BumperSource::NowPlaying => self.now_playing_text(),
                BumperSource::Prerecorded | BumperSource::Doctrine | BumperSource::Memory => None,
            };
            if let Some(text) = text {
                if let Some(b) = self.speak(&text, src.as_str()).await {
                    return Some(b);
                }
            }
        }
        None
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
    for src in sources {
        let text = match src {
            BumperSource::StationId => Some(factory.station_id_text(cfg)),
            BumperSource::TimeCheck => Some(factory.time_check_text()),
            BumperSource::NowPlaying => factory.now_playing_text(),
            BumperSource::Prerecorded | BumperSource::Doctrine | BumperSource::Memory => None,
        };
        if let Some(text) = text {
            if let Some(b) = factory.speak(&text, src.as_str()).await {
                return Some(b);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_station_id_mentions_name() {
        let f = LiveBumperFactory::new("Moneypenny".into());
        let t = f.station_id_text(&RadioConfig::default());
        assert!(t.contains("Moneypenny"));
        assert!(t.contains("This is"));
    }
}
