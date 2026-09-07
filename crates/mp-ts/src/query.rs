// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! TS6 HTTP Query (`:10080` + `x-api-key`). Not blocked on the UDP client.

use std::time::Duration;

use serde_json::Value;

#[derive(Clone)]
pub struct QueryClient {
    host: String,
    port: u16,
    api_key: String,
    http: reqwest::Client,
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
        })
    }

    async fn get(&self, path: &str) -> Result<(u16, String), String> {
        let url = format!("http://{}:{}{path}", self.host, self.port);
        let mut req = self.http.get(&url).header("Accept", "application/json");
        if !self.api_key.is_empty() {
            req = req.header("x-api-key", &self.api_key);
        }
        let res = req.send().await.map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        Ok((status, body))
    }

    async fn post_json(&self, path: &str, body: &serde_json::Value) -> Result<(u16, String), String> {
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
        let res = req.send().await.map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        Ok((status, text))
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
}
