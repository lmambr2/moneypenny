// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Star Citizen / org status HTTP client + fail-open plugin registry.
//! Port of `bot/src/tools/sc-org-client.ts` + `external-status.ts`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

#[derive(Debug, Clone)]
pub struct ScOrgStatus {
    pub status: String,
    pub members_online: Option<u64>,
    pub summary: Option<String>,
    pub org: String,
}

#[derive(Debug, Clone)]
pub struct ScOrgMember {
    pub name: String,
    pub rank: Option<String>,
    pub online: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct ScOrgFleet {
    pub vessels: Vec<(String, Option<String>)>,
    pub summary: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ExternalStatusResult {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub text: String,
}

pub struct ScOrgRuntime {
    url: Mutex<String>,
    name: Mutex<String>,
    started: Instant,
    cache: Mutex<HashMap<String, (Instant, ExternalStatusResult)>>,
}

impl ScOrgRuntime {
    pub fn from_config(url: &str, name: &str) -> Self {
        let env_url = std::env::var("SC_ORG_STATUS_URL").unwrap_or_default();
        let env_name = std::env::var("SC_ORG_NAME").unwrap_or_default();
        let url = if url.trim().is_empty() {
            env_url
        } else {
            url.to_string()
        };
        let name = if name.trim().is_empty() {
            if env_name.trim().is_empty() {
                "org".into()
            } else {
                env_name
            }
        } else {
            name.to_string()
        };
        Self {
            url: Mutex::new(url),
            name: Mutex::new(name),
            started: Instant::now(),
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn url(&self) -> String {
        self.url.lock().expect("sc-org url").clone()
    }

    pub fn name(&self) -> String {
        self.name.lock().expect("sc-org name").clone()
    }

    pub fn set_url(&self, url: String) {
        *self.url.lock().expect("sc-org url") = url;
        self.cache.lock().expect("sc-org cache").clear();
    }

    pub fn set_name(&self, name: String) {
        let n = if name.trim().is_empty() {
            "org".into()
        } else {
            name
        };
        *self.name.lock().expect("sc-org name") = n;
        self.cache.lock().expect("sc-org cache").clear();
    }

    pub fn host_summary(&self) -> String {
        format!(
            "Host ok · uptime {}s",
            self.started.elapsed().as_secs()
        )
    }

    pub async fn get_plugin(&self, id: &str) -> ExternalStatusResult {
        match id {
            "host" => ExternalStatusResult {
                id: "host".into(),
                label: "Host health".into(),
                ok: true,
                text: self.host_summary(),
            },
            "sc-org" => self.fetch_sc_org().await,
            other => ExternalStatusResult {
                id: other.into(),
                label: other.into(),
                ok: false,
                text: format!("Unknown status source \"{other}\". Try: sc-org, host"),
            },
        }
    }

    pub async fn get_all(&self) -> Vec<ExternalStatusResult> {
        vec![self.get_plugin("host").await, self.get_plugin("sc-org").await]
    }

    async fn fetch_sc_org(&self) -> ExternalStatusResult {
        const ID: &str = "sc-org";
        const LABEL: &str = "Star Citizen org status";
        let cached = {
            let cache = self.cache.lock().expect("sc-org cache");
            cache.get(ID).and_then(|(at, r)| {
                if at.elapsed() < Duration::from_secs(60) {
                    Some(r.clone())
                } else {
                    None
                }
            })
        };
        if let Some(r) = cached {
            return r;
        }
        let result = match tokio::time::timeout(Duration::from_millis(4000), self.format_brief()).await {
            Ok(Ok(text)) => ExternalStatusResult {
                id: ID.into(),
                label: LABEL.into(),
                ok: true,
                text: if text.trim().is_empty() {
                    "(empty status)".into()
                } else {
                    text.trim().to_string()
                },
            },
            Ok(Err(msg)) => ExternalStatusResult {
                id: ID.into(),
                label: LABEL.into(),
                ok: false,
                text: format!("{LABEL} unavailable ({msg}). Music and transport are unaffected."),
            },
            Err(_) => ExternalStatusResult {
                id: ID.into(),
                label: LABEL.into(),
                ok: false,
                text: format!("{LABEL} unavailable (timeout after 4000ms). Music and transport are unaffected."),
            },
        };
        if result.ok {
            self.cache
                .lock()
                .expect("sc-org cache")
                .insert(ID.to_string(), (Instant::now(), result.clone()));
        }
        result
    }

    fn client(&self) -> Result<ScOrgClient, String> {
        let raw = self.url();
        let base = normalize_sc_org_base_url(&raw)?;
        if base.is_empty() {
            return Err("SC org status URL not configured (set SC_ORG_STATUS_URL or Settings)".into());
        }
        Ok(ScOrgClient {
            base,
            org_name: self.name(),
        })
    }

    pub async fn format_brief(&self) -> Result<String, String> {
        self.client()?.format_brief().await
    }

    pub async fn members_text(&self) -> String {
        let Ok(c) = self.client() else {
            return "○ SC members: not configured (set SC org status URL).".into();
        };
        match c.get_members().await {
            Ok(members) => {
                if members.is_empty() {
                    return "○ SC members: (empty list from bridge).".into();
                }
                let online = members.iter().filter(|m| m.online == Some(true)).count();
                let lines: Vec<String> = members
                    .iter()
                    .take(12)
                    .map(|m| {
                        let mark = if m.online == Some(true) { "●" } else { "○" };
                        match &m.rank {
                            Some(r) if !r.is_empty() => format!("{mark} {} ({r})", m.name),
                            _ => format!("{mark} {}", m.name),
                        }
                    })
                    .collect();
                format!(
                    "SC members ({online} online / {}):\n{}",
                    members.len(),
                    lines.join("\n")
                )
            }
            Err(e) => format!("○ SC members unavailable ({e}). Music unaffected."),
        }
    }

    pub async fn fleet_text(&self) -> String {
        let Ok(c) = self.client() else {
            return "○ SC fleet: not configured (set SC org status URL).".into();
        };
        match c.get_fleet().await {
            Ok(fleet) => {
                if fleet.vessels.is_empty() {
                    return if let Some(s) = fleet.summary {
                        format!("SC fleet: {s}")
                    } else {
                        "○ SC fleet: (empty from bridge).".into()
                    };
                }
                let mut lines = vec![format!(
                    "SC fleet{}",
                    fleet
                        .summary
                        .as_deref()
                        .map(|s| format!(": {s}"))
                        .unwrap_or_default()
                )];
                for (name, role) in fleet.vessels.iter().take(12) {
                    lines.push(match role {
                        Some(r) if !r.is_empty() => format!("· {name} — {r}"),
                        _ => format!("· {name}"),
                    });
                }
                lines.join("\n")
            }
            Err(e) => format!("○ SC fleet unavailable ({e}). Music unaffected."),
        }
    }
}

struct ScOrgClient {
    base: String,
    org_name: String,
}

impl ScOrgClient {
    async fn get_json(&self, path: &str) -> Result<Value, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(3500))
            .build()
            .map_err(|e| e.to_string())?;
        let res = client
            .get(format!("{}{path}", self.base))
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("HTTP {}", res.status().as_u16()));
        }
        res.json::<Value>().await.map_err(|e| e.to_string())
    }

    async fn get_status(&self) -> Result<ScOrgStatus, String> {
        let data = self.get_json("/status").await?;
        Ok(parse_status_payload(&data, &self.org_name))
    }

    async fn get_members(&self) -> Result<Vec<ScOrgMember>, String> {
        let data = self.get_json("/members").await?;
        let list = data
            .get("members")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(list
            .into_iter()
            .filter_map(|m| {
                let name = m
                    .get("name")
                    .or_else(|| m.get("handle"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if name.is_empty() {
                    return None;
                }
                Some(ScOrgMember {
                    name,
                    rank: m.get("rank").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    online: m.get("online").and_then(|v| v.as_bool()),
                })
            })
            .collect())
    }

    async fn get_fleet(&self) -> Result<ScOrgFleet, String> {
        let data = self.get_json("/fleet").await?;
        let vessels = data
            .get("vessels")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| {
                let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("").trim();
                if name.is_empty() {
                    return None;
                }
                Some((
                    name.to_string(),
                    v.get("role").and_then(|x| x.as_str()).map(|s| s.to_string()),
                ))
            })
            .collect();
        Ok(ScOrgFleet {
            vessels,
            summary: data.get("summary").and_then(|v| v.as_str()).map(|s| s.to_string()),
        })
    }

    async fn format_brief(&self) -> Result<String, String> {
        let st = self.get_status().await?;
        let mut parts = vec![format!("{}: {}", st.org, st.status)];
        if let Some(n) = st.members_online {
            parts.push(format!("{n} online"));
        }
        if let Some(s) = st.summary {
            parts.push(s);
        }
        if let Ok(members) = self.get_members().await {
            let online: Vec<&str> = members
                .iter()
                .filter(|m| m.online == Some(true))
                .take(5)
                .map(|m| m.name.as_str())
                .collect();
            if !online.is_empty() {
                parts.push(format!("Online: {}", online.join(", ")));
            }
        }
        Ok(parts.join(" · "))
    }
}

pub fn parse_status_payload(data: &Value, default_org: &str) -> ScOrgStatus {
    let members_online = data
        .get("membersOnline")
        .and_then(|v| v.as_u64())
        .or_else(|| data.get("online").and_then(|v| v.as_u64()));
    ScOrgStatus {
        status: data
            .get("status")
            .or_else(|| data.get("state"))
            .and_then(|v| v.as_str())
            .unwrap_or("ok")
            .to_string(),
        members_online,
        summary: data.get("summary").and_then(|v| v.as_str()).map(|s| s.to_string()),
        org: data
            .get("org")
            .and_then(|v| v.as_str())
            .unwrap_or(default_org)
            .to_string(),
    }
}

pub fn normalize_sc_org_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let u = reqwest::Url::parse(trimmed).map_err(|_| "SC org status URL is not a valid absolute URL".to_string())?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err("SC org status URL must be http or https".into());
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err("SC org status URL must not embed credentials".into());
    }
    let path = u.path();
    let path = if path == "/" { "" } else { path.trim_end_matches('/') };
    Ok(format!("{}://{}{}{path}", u.scheme(), u.host_str().unwrap_or(""), if let Some(p) = u.port() { format!(":{p}") } else { String::new() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_bad_schemes_and_creds() {
        assert!(normalize_sc_org_base_url("file:///etc/passwd").is_err());
        assert!(normalize_sc_org_base_url("http://user:pass@x/").is_err());
        assert_eq!(
            normalize_sc_org_base_url("http://192.168.1.89:9100/").unwrap(),
            "http://192.168.1.89:9100"
        );
        assert_eq!(normalize_sc_org_base_url("").unwrap(), "");
    }

    #[test]
    fn status_aliases() {
        let st = parse_status_payload(&json!({"state": "green", "online": 4}), "Org");
        assert_eq!(st.status, "green");
        assert_eq!(st.members_online, Some(4));
        assert_eq!(st.org, "Org");
    }
}
