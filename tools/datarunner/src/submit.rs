//! Destination routing: uex | moneypenny | both. Moneypenny never depends on UEX.

use crate::config::{Destination, RunnerConfig};
use crate::snapshot::Snapshot;
use anyhow::{Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

pub const USER_AGENT: &str = "Moneypenny-DataRunner/0.1 (+https://github.com/lmambr2/moneypenny)";

#[derive(Debug)]
pub struct SubmitError {
    pub dest: &'static str,
    pub message: String,
    pub status: Option<u16>,
}

impl std::fmt::Display for SubmitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for SubmitError {}

pub fn http_json(url: &str, headers: &HashMap<String, String>, body: &Value) -> Result<Value> {
    let mut req = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(60))
        .build()?
        .post(url)
        .json(body);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let resp = req.send().with_context(|| format!("POST {url}"))?;
    let status = resp.status();
    let text = resp.text().unwrap_or_default();
    if !status.is_success() {
        return Err(SubmitError {
            dest: "http",
            message: format!("{status} {}", text.chars().take(500).collect::<String>()),
            status: Some(status.as_u16()),
        }
        .into());
    }
    let parsed = if text.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(&text).unwrap_or_else(|_| json!({"raw": text}))
    };
    Ok(json!({
        "ok": true,
        "status": status.as_u16(),
        "body": parsed,
    }))
}

fn submit_moneypenny<F>(cfg: &RunnerConfig, snap: &Snapshot, http: &F) -> Result<Value>
where
    F: Fn(&str, &HashMap<String, String>, &Value) -> Result<Value>,
{
    if cfg.moneypenny_token.is_empty() {
        return Err(SubmitError {
            dest: "moneypenny",
            message: "MONEYPENNY_INGEST_TOKEN (or ECONOMY_INGEST_TOKEN) is empty".into(),
            status: None,
        }
        .into());
    }
    let url = format!(
        "{}/api/economy/ingest/terminal-snapshot",
        cfg.moneypenny_url
    );
    let mut headers = HashMap::new();
    headers.insert(
        "Authorization".into(),
        format!("Bearer {}", cfg.moneypenny_token),
    );
    let body = serde_json::to_value(snap)?;
    http(&url, &headers, &body)
}

fn submit_uex<F>(
    cfg: &RunnerConfig,
    snap: &Snapshot,
    screenshot: Option<&Path>,
    http: &F,
) -> Result<Value>
where
    F: Fn(&str, &HashMap<String, String>, &Value) -> Result<Value>,
{
    if snap.kind == "fuel" {
        return Err(SubmitError {
            dest: "uex",
            message: "UEX data_submit has no fuel type — skip UEX (Moneypenny-local only)".into(),
            status: None,
        }
        .into());
    }
    if cfg.uex_secret_key.is_empty() {
        return Err(SubmitError {
            dest: "uex",
            message: "UEX_SECRET_KEY is empty".into(),
            status: None,
        }
        .into());
    }
    if cfg.uex_api_token.is_empty() {
        return Err(SubmitError {
            dest: "uex",
            message: "UEX_API_TOKEN / UEX_API_KEY is empty".into(),
            status: None,
        }
        .into());
    }
    let mut payload = json!({
        "id_terminal": snap.id_terminal,
        "type": snap.kind,
        "is_production": if cfg.uex_is_production { 1 } else { 0 },
        "prices": snap.prices,
        "game_version": snap.game_version,
    });
    if let Some(name) = &snap.terminal_name {
        payload["details"] = json!(name);
    }
    if let Some(path) = screenshot.filter(|p| p.is_file()) {
        let raw = fs::read(path)?;
        if raw.len() > 10 * 1024 * 1024 {
            return Err(SubmitError {
                dest: "uex",
                message: "screenshot exceeds UEX 10 MB limit".into(),
                status: None,
            }
            .into());
        }
        payload["screenshot"] = json!(base64::engine::general_purpose::STANDARD.encode(raw));
    }
    let url = format!("{}/2.0/data_submit", cfg.uex_api_base);
    let mut headers = HashMap::new();
    headers.insert(
        "Authorization".into(),
        format!("Bearer {}", cfg.uex_api_token),
    );
    headers.insert("secret-key".into(), cfg.uex_secret_key.clone());
    http(&url, &headers, &payload)
}

pub fn submit_snapshot<F>(
    cfg: &RunnerConfig,
    snap: &Snapshot,
    screenshot: Option<&Path>,
    http: F,
) -> Result<Value>
where
    F: Fn(&str, &HashMap<String, String>, &Value) -> Result<Value>,
{
    let mut out = json!({
        "destination": cfg.destination.as_str(),
        "moneypenny": null,
        "uex": null,
    });
    if matches!(cfg.destination, Destination::Moneypenny | Destination::Both) {
        out["moneypenny"] = submit_moneypenny(cfg, snap, &http)?;
    }
    if matches!(cfg.destination, Destination::Uex | Destination::Both) {
        match submit_uex(cfg, snap, screenshot, &http) {
            Ok(v) => out["uex"] = v,
            Err(err) => {
                let msg = err.to_string();
                let status = err.downcast_ref::<SubmitError>().and_then(|s| s.status);
                out["uex"] = json!({"ok": false, "error": msg, "status": status});
                if cfg.destination == Destination::Uex {
                    return Err(err);
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Destination, OcrDevice, RunnerConfig};
    use crate::parse::PriceRow;
    use std::sync::Mutex;

    fn cfg(dest: Destination) -> RunnerConfig {
        RunnerConfig {
            destination: dest,
            screenshot_dir: None,
            moneypenny_url: "http://127.0.0.1:3000".into(),
            moneypenny_token: "tok".into(),
            uex_api_base: "https://api.uexcorp.uk".into(),
            uex_api_token: "bearer".into(),
            uex_secret_key: "secret".into(),
            uex_is_production: false,
            game_version: "4.10.0".into(),
            environment: "LIVE".into(),
            ocr_device: OcrDevice::Cpu,
            terminal_id: Some(89),
            terminal_name: String::new(),
            snapshot_type: "commodity".into(),
            yes: true,
        }
    }

    fn snap() -> Snapshot {
        Snapshot {
            source: "datarunner".into(),
            game_version: "4.10.0".into(),
            environment: "LIVE".into(),
            id_terminal: 89,
            terminal_name: None,
            kind: "commodity".into(),
            prices: vec![PriceRow {
                name: "Agricium".into(),
                price_sell: Some(12000.0),
                ..PriceRow::default()
            }],
            captured_at: 1,
            screenshot_sha256: None,
        }
    }

    #[test]
    fn moneypenny_dest_never_calls_uex() {
        let calls = Mutex::new(Vec::<String>::new());
        let http = |url: &str, _h: &HashMap<String, String>, _b: &Value| {
            calls.lock().unwrap().push(url.to_string());
            Ok(json!({"ok": true, "status": 201}))
        };
        let out = submit_snapshot(&cfg(Destination::Moneypenny), &snap(), None, http).unwrap();
        let calls = calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        assert!(!calls[0].contains("uexcorp"));
        assert!(calls[0].ends_with("/api/economy/ingest/terminal-snapshot"));
        assert!(out["uex"].is_null());
        assert_eq!(out["destination"], "moneypenny");
    }

    #[test]
    fn both_keeps_moneypenny_when_uex_fails() {
        let http = |url: &str, _h: &HashMap<String, String>, _b: &Value| {
            if url.contains("uexcorp") {
                return Err(SubmitError {
                    dest: "uex",
                    message: "nope".into(),
                    status: Some(401),
                }
                .into());
            }
            Ok(json!({"ok": true, "status": 201}))
        };
        let out = submit_snapshot(&cfg(Destination::Both), &snap(), None, http).unwrap();
        assert_eq!(out["moneypenny"]["ok"], true);
        assert_eq!(out["uex"]["ok"], false);
        assert_eq!(out["destination"], "both");
    }

    #[test]
    fn uex_only_raises() {
        let http = |_url: &str, _h: &HashMap<String, String>, _b: &Value| {
            Err(SubmitError {
                dest: "uex",
                message: "nope".into(),
                status: Some(401),
            }
            .into())
        };
        let err = submit_snapshot(&cfg(Destination::Uex), &snap(), None, http).unwrap_err();
        let se = err.downcast_ref::<SubmitError>().expect("SubmitError");
        assert_eq!(se.dest, "uex");
        assert_eq!(se.status, Some(401));
    }
}
