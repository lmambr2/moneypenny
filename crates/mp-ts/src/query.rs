// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! TS6 HTTP Query (`:10080` + `x-api-key`). Not blocked on the UDP client.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;

const QUERY_COOLDOWN_MS: i64 = 5 * 60_000;

/// Skip TS6 HTTP Query after auth/timeout failures so polls do not wait 5s each.
#[derive(Clone)]
pub struct QueryCooldown {
    until_ms: std::sync::Arc<Mutex<i64>>,
    ttl_ms: i64,
}

impl QueryCooldown {
    pub fn new(ttl_ms: i64) -> Self {
        Self {
            until_ms: std::sync::Arc::new(Mutex::new(0)),
            ttl_ms,
        }
    }

    pub fn note_failure(&self, message: &str, now_ms: i64) {
        let m = message.to_ascii_lowercase();
        let transient = m.contains("401")
            || m.contains("403")
            || m.contains("timeout")
            || m.contains("invalid api")
            || m.contains("connection refused")
            || m.contains("econnrefused")
            || m.contains("enotfound")
            || m.contains("ehostunreach")
            || m.contains("socket hang up");
        if transient {
            *self.until_ms.lock().expect("cooldown") = now_ms + self.ttl_ms;
        }
    }

    pub fn reject_reason(&self, now_ms: i64) -> Option<String> {
        let until = *self.until_ms.lock().expect("cooldown");
        if until > now_ms {
            Some("TS6 HTTP Query cooldown".into())
        } else {
            None
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Clone)]
pub struct QueryClient {
    host: String,
    port: u16,
    api_key: String,
    http: reqwest::Client,
    cooldown: QueryCooldown,
}

impl QueryClient {
    pub fn new(host: impl Into<String>, port: u16, api_key: impl Into<String>) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            host: host.into(),
            port,
            api_key: api_key.into(),
            http,
            cooldown: QueryCooldown::new(QUERY_COOLDOWN_MS),
        })
    }

    async fn get(&self, path: &str) -> Result<(u16, String), String> {
        if let Some(reason) = self.cooldown.reject_reason(now_ms()) {
            return Err(reason);
        }
        let url = format!("http://{}:{}{path}", self.host, self.port);
        let mut req = self.http.get(&url).header("Accept", "application/json");
        if !self.api_key.is_empty() {
            req = req.header("x-api-key", &self.api_key);
        }
        let res = match req.send().await {
            Ok(res) => res,
            Err(e) => {
                let msg = e.to_string();
                self.cooldown.note_failure(&msg, now_ms());
                return Err(msg);
            }
        };
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        if status == 401 || status == 403 {
            self.cooldown.note_failure(&format!("{status} unauthorized"), now_ms());
        }
        Ok((status, body))
    }

    async fn post_json(&self, path: &str, body: &serde_json::Value) -> Result<(u16, String), String> {
        if let Some(reason) = self.cooldown.reject_reason(now_ms()) {
            return Err(reason);
        }
        let url = format!("http://{}:{}{path}", self.host, self.port);
        let mut req = self
            .http
            .post(&url)
            .header("Accept", "application/json")
            .header("content-type", "application/json")
            .json(body);
        if !self.api_key.is_empty() {
            req = req.header("x-api-key", &self.api_key);
        }
        let res = match req.send().await {
            Ok(res) => res,
            Err(e) => {
                let msg = e.to_string();
                self.cooldown.note_failure(&msg, now_ms());
                return Err(msg);
            }
        };
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        if status == 401 || status == 403 {
            self.cooldown.note_failure(&format!("{status} unauthorized"), now_ms());
        }
        Ok((status, text))
    }

    pub fn from_env() -> Option<Self> {
        let host = std::env::var("TS6_QUERY_HOST")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                std::env::var("TS6_HOST")
                    .ok()
                    .filter(|s| !s.trim().is_empty())
            })?;
        let key = std::env::var("TS6_API_KEY")
            .ok()
            .filter(|s| !s.trim().is_empty())?;
        let port = std::env::var("TS6_QUERY_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(10080);
        Self::new(host, port, key).ok()
    }

    pub async fn server_group_client_ids(&self, sgid: i64) -> Result<Vec<i64>, String> {
        let (status, body) = self
            .get(&format!("/1/servergroupclientlist?sid=1&sgid={sgid}"))
            .await?;
        if !(200..300).contains(&status) {
            return Err(format!("sgid {sgid} list HTTP {status}"));
        }
        Ok(parse_member_db_ids(&body))
    }

    pub async fn server_group_del_client(&self, sgid: i64, cldbid: i64) -> Result<(), String> {
        let (status, body) = self
            .post_json(
                "/1/servergroupdelclient?sid=1",
                &serde_json::json!({ "sgid": sgid, "cldbid": cldbid }),
            )
            .await?;
        if !(200..300).contains(&status) {
            return Err(format!(
                "sgid {sgid} cldbid {cldbid}: HTTP {status} {}",
                body.chars().take(80).collect::<String>()
            ));
        }
        Ok(())
    }

    pub async fn channel_list(&self) -> Result<Vec<QueryChannel>, String> {
        let (status, body) = self.get("/1/channellist").await?;
        if status != 200 {
            return Err(format!("channellist status={status}"));
        }
        Ok(parse_channel_list(&body))
    }

    pub async fn resolve_channel(&self, query: &str) -> Result<QueryChannel, String> {
        let q = query.trim();
        if q.is_empty() {
            return Err("channel required".into());
        }
        let list = self.channel_list().await?;
        if let Ok(id) = q.parse::<u64>() {
            if let Some(ch) = list.iter().find(|c| c.cid == id) {
                return Ok(ch.clone());
            }
        }
        let lower = q.to_ascii_lowercase();
        let exact = list.iter().find(|c| c.name.eq_ignore_ascii_case(q));
        if let Some(ch) = exact {
            return Ok(ch.clone());
        }
        let starts = list
            .iter()
            .find(|c| c.name.to_ascii_lowercase().starts_with(&lower));
        if let Some(ch) = starts {
            return Ok(ch.clone());
        }
        let contains = list
            .iter()
            .find(|c| c.name.to_ascii_lowercase().contains(&lower));
        contains.cloned().ok_or_else(|| format!("No channel matching '{q}'."))
    }

    pub async fn client_move(&self, clid: i32, cid: u64) -> Result<(), String> {
        let (status, body) = self
            .post_json(
                "/1/clientmove?sid=1",
                &serde_json::json!({ "clid": clid, "cid": cid }),
            )
            .await?;
        if status < 200 || status >= 300 {
            return Err(format!("clientmove failed ({status}): {}", body.chars().take(80).collect::<String>()));
        }
        Ok(())
    }

    /// GET /1/clientlist?-groups — nickname + client_servergroups.
    pub async fn client_list_groups(&self) -> Result<Vec<QueryClientRow>, String> {
        let (status, body) = self.get("/1/clientlist?-groups").await?;
        if status != 200 {
            return Err(format!("clientlist status={status} body={}", body.chars().take(120).collect::<String>()));
        }
        Ok(parse_client_list(&body))
    }

    pub async fn groups_for_clid(&self, clid: i32) -> Vec<String> {
        match self.client_list_groups().await {
            Ok(rows) => rows
                .into_iter()
                .find(|r| r.clid == clid)
                .map(|r| r.server_groups)
                .unwrap_or_default(),
            Err(e) => {
                tracing::warn!(error = %e, clid, "HTTP Query groups failed");
                Vec::new()
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct QueryClientRow {
    pub clid: i32,
    pub nickname: String,
    pub uid: String,
    pub cid: u64,
    pub server_groups: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct QueryChannel {
    pub cid: u64,
    pub name: String,
}

/// Client database ids from a servergroupclientlist body.
pub fn parse_member_db_ids(body: &str) -> Vec<i64> {
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    let rows = if let Some(arr) = v.as_array() {
        arr.clone()
    } else {
        for key in ["body", "data", "clients", "rows"] {
            if let Some(arr) = v.get(key).and_then(|x| x.as_array()) {
                return ids_from_rows(arr);
            }
        }
        return ids_from_rows(std::slice::from_ref(&v));
    };
    ids_from_rows(&rows)
}

fn ids_from_rows(rows: &[Value]) -> Vec<i64> {
    let mut out = Vec::new();
    for row in rows {
        let raw = row
            .get("cldbid")
            .or_else(|| row.get("client_database_id"))
            .or_else(|| row.get("cdb_id"));
        let n = raw
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
            .unwrap_or(0);
        if n > 0 && !out.contains(&n) {
            out.push(n);
        }
    }
    out
}

pub fn parse_client_list(body: &str) -> Vec<QueryClientRow> {
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return parse_pipe_list(body);
    };
    let arr = if v.is_array() {
        v.as_array().cloned().unwrap_or_default()
    } else if let Some(a) = v.get("body").and_then(|b| b.as_array()) {
        a.clone()
    } else if let Some(a) = v.get("data").and_then(|b| b.as_array()) {
        a.clone()
    } else if v.is_object() {
        vec![v]
    } else {
        return parse_pipe_list(body);
    };
    arr.into_iter().filter_map(row_from_json).collect()
}

fn row_from_json(v: Value) -> Option<QueryClientRow> {
    let clid = v
        .get("clid")
        .or_else(|| v.get("client_id"))
        .and_then(json_i32)?;
    let nickname = v
        .get("client_nickname")
        .or_else(|| v.get("nickname"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let uid = v
        .get("client_unique_identifier")
        .or_else(|| v.get("uid"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let cid = v
        .get("cid")
        .or_else(|| v.get("client_channel_id"))
        .and_then(json_u64)
        .unwrap_or(0);
    let groups = v
        .get("client_servergroups")
        .or_else(|| v.get("serverGroups"))
        .map(parse_groups)
        .unwrap_or_default();
    Some(QueryClientRow {
        clid,
        nickname,
        uid,
        cid,
        server_groups: groups,
    })
}

fn parse_groups(v: &Value) -> Vec<String> {
    if let Some(s) = v.as_str() {
        return s
            .split(',')
            .map(str::trim)
            .filter(|x| !x.is_empty())
            .map(str::to_string)
            .collect();
    }
    if let Some(a) = v.as_array() {
        return a
            .iter()
            .filter_map(|x| x.as_str().map(str::to_string).or_else(|| x.as_i64().map(|n| n.to_string())))
            .collect();
    }
    Vec::new()
}

fn json_i32(v: &Value) -> Option<i32> {
    v.as_i64()
        .map(|n| n as i32)
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

fn json_u64(v: &Value) -> Option<u64> {
    v.as_u64()
        .or_else(|| v.as_i64().map(|n| n as u64))
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

pub fn parse_channel_list(body: &str) -> Vec<QueryChannel> {
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return parse_pipe_channels(body);
    };
    let arr = if v.is_array() {
        v.as_array().cloned().unwrap_or_default()
    } else if let Some(a) = v.get("body").and_then(|b| b.as_array()) {
        a.clone()
    } else if let Some(a) = v.get("data").and_then(|b| b.as_array()) {
        a.clone()
    } else {
        return parse_pipe_channels(body);
    };
    arr.into_iter()
        .filter_map(|row| {
            let cid = row
                .get("cid")
                .or_else(|| row.get("channel_id"))
                .and_then(json_u64)?;
            let name = row
                .get("channel_name")
                .or_else(|| row.get("name"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            Some(QueryChannel { cid, name })
        })
        .collect()
}

fn parse_pipe_channels(body: &str) -> Vec<QueryChannel> {
    body.split('|')
        .filter_map(|chunk| {
            let mut cid = 0u64;
            let mut name = String::new();
            for part in chunk.split_whitespace() {
                if let Some((k, v)) = part.split_once('=') {
                    match k {
                        "cid" => cid = v.parse().unwrap_or(0),
                        "channel_name" => name = v.replace("\\s", " "),
                        _ => {}
                    }
                }
            }
            if cid == 0 {
                None
            } else {
                Some(QueryChannel { cid, name })
            }
        })
        .collect()
}

fn parse_pipe_list(body: &str) -> Vec<QueryClientRow> {
    body.split('|')
        .filter_map(|chunk| {
            let mut clid = 0i32;
            let mut nickname = String::new();
            let mut uid = String::new();
            let mut cid = 0u64;
            let mut groups = Vec::new();
            for part in chunk.split_whitespace() {
                if let Some((k, v)) = part.split_once('=') {
                    match k {
                        "clid" => clid = v.parse().unwrap_or(0),
                        "client_nickname" => nickname = v.replace("\\s", " "),
                        "client_unique_identifier" => uid = v.to_string(),
                        "cid" => cid = v.parse().unwrap_or(0),
                        "client_servergroups" => {
                            groups = v.split(',').map(str::to_string).filter(|s| !s.is_empty()).collect();
                        }
                        _ => {}
                    }
                }
            }
            if clid == 0 && nickname.is_empty() {
                None
            } else {
                Some(QueryClientRow {
                    clid,
                    nickname,
                    uid,
                    cid,
                    server_groups: groups,
                })
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_json_array() {
        let body = r#"[{"clid":"3","client_nickname":"grafcv","client_servergroups":"6,7","cid":"1"}]"#;
        let rows = parse_client_list(body);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].clid, 3);
        assert_eq!(rows[0].nickname, "grafcv");
        assert_eq!(rows[0].server_groups, ["6", "7"]);
        assert_eq!(rows[0].cid, 1);
    }

    #[test]
    fn cooldown_blocks_the_next_query_after_auth_failure() {
        let cd = QueryCooldown::new(60_000);
        assert!(cd.reject_reason(1_000).is_none());
        cd.note_failure("401 unauthorized", 1_000);
        assert_eq!(
            cd.reject_reason(1_500).as_deref(),
            Some("TS6 HTTP Query cooldown")
        );
        assert!(cd.reject_reason(70_000).is_none());
        cd.note_failure("not a transient problem", 80_000);
        assert!(cd.reject_reason(80_100).is_none());
    }

    #[tokio::test]
    async fn post_auth_failure_arms_cooldown_for_the_next_get() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let gets = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let gets_bg = std::sync::Arc::clone(&gets);
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let gets_bg = std::sync::Arc::clone(&gets_bg);
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 2048];
                    let _ = sock.read(&mut buf).await;
                    let head = String::from_utf8_lossy(&buf);
                    let body = if head.starts_with("POST") {
                        "{\"error\":\"unauthorized\"}"
                    } else {
                        gets_bg.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        "[]"
                    };
                    let status = if head.starts_with("POST") { 401 } else { 200 };
                    let resp = format!(
                        "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        let client = QueryClient::new(addr.ip().to_string(), addr.port(), "k").unwrap();
        let posted = client
            .post_json("/1/servergroupdelclient?sid=1", &serde_json::json!({"sgid": 1}))
            .await
            .unwrap();
        assert_eq!(posted.0, 401);
        let next = client.get("/1/servergroupclientlist?sid=1&sgid=1").await;
        assert!(
            next.as_ref().unwrap_err().contains("cooldown"),
            "{next:?}"
        );
        assert_eq!(gets.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
}
