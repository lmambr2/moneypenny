use crate::parse::PriceRow;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub source: String,
    pub game_version: String,
    pub environment: String,
    pub id_terminal: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_name: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    pub prices: Vec<PriceRow>,
    pub captured_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot_sha256: Option<String>,
}

pub fn sha256_file(path: &Path) -> anyhow::Result<String> {
    let bytes = fs::read(path)?;
    let mut h = Sha256::new();
    h.update(&bytes);
    Ok(hex::encode(h.finalize()))
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn build_snapshot(
    prices: Vec<PriceRow>,
    id_terminal: i64,
    terminal_name: &str,
    snapshot_type: &str,
    game_version: &str,
    environment: &str,
    screenshot: Option<&Path>,
) -> anyhow::Result<Snapshot> {
    let sha = match screenshot {
        Some(p) if p.is_file() => Some(sha256_file(p)?),
        _ => None,
    };
    Ok(Snapshot {
        source: "datarunner".into(),
        game_version: game_version.into(),
        environment: environment.into(),
        id_terminal,
        terminal_name: if terminal_name.is_empty() {
            None
        } else {
            Some(terminal_name.into())
        },
        kind: snapshot_type.into(),
        prices,
        captured_at: now_ms(),
        screenshot_sha256: sha,
    })
}
