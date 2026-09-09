//! SRV / TSDNS address resolver — mirrors `teamspeak-js/src/discovery/resolver.ts`

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use hickory_resolver::config::{ResolverConfig, ResolverOpts};
use hickory_resolver::TokioAsyncResolver;

use crate::types::*;
use crate::Error;

const TS_DEFAULT_PORT: u16 = 9987;
const TS_DNS_DEFAULT_PORT: u16 = 41144;
const NICKNAME_LOOKUP_URL: &str = "https://named.myteamspeak.com/lookup";
const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(10 * 60);

fn is_ip_address(host: &str) -> bool {
    if host.starts_with('[') {
        return true;
    }
    // Match JS `/^\d{1,3}(\.\d{1,3}){3}$/` — does NOT validate octet ranges.
    let octets: Vec<&str> = host.split('.').collect();
    octets.len() == 4
        && octets.iter().all(|o| {
            !o.is_empty() && o.len() <= 3 && o.bytes().all(|b| b.is_ascii_digit())
        })
}

fn split_host_port(addr: &str) -> (&str, u16) {
    if let Some(last_colon) = addr.rfind(':') {
        let after = &addr[last_colon + 1..];
        if let Ok(port) = after.parse::<u16>() {
            return (&addr[..last_colon], port);
        }
    }
    (addr, TS_DEFAULT_PORT)
}

fn join_host_port(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn get_domain_list(host: &str) -> Vec<String> {
    let parts: Vec<&str> = host.split('.').collect();
    let mut list = Vec::new();
    for i in 0..parts.len().saturating_sub(1) {
        list.push(parts[i..].join("."));
    }
    list.truncate(3);
    list
}

struct CachedResult {
    addrs: Vec<ResolvedAddr>,
    expires_at: Instant,
}

async fn resolve_nickname(nickname: &str, signal: Option<&AbortSignal>) -> Option<String> {
    let fetch = async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .ok()?;

        let response = client
            .get(NICKNAME_LOOKUP_URL)
            .query(&[("name", nickname)])
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let text = response.text().await.ok()?;
        let line = text.lines().next()?.trim().to_string();
        if line.is_empty() { None } else { Some(line) }
    };

    match signal {
        Some(sig) => tokio::select! {
            r = fetch => r,
            _ = sig.wait_for_abort() => None,
        },
        None => fetch.await,
    }
}

pub struct Resolver {
    cache: Mutex<HashMap<String, CachedResult>>,
    dns: TokioAsyncResolver,
}

impl Resolver {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
            dns: TokioAsyncResolver::tokio(ResolverConfig::default(), ResolverOpts::default()),
        }
    }

    fn get_valid_cache(&self, key: &str) -> Option<Vec<ResolvedAddr>> {
        let guard = self.cache.lock().ok()?;
        let entry = guard.get(key)?;
        if Instant::now() > entry.expires_at {
            return None;
        }
        Some(entry.addrs.clone())
    }

    fn set_cache(&self, key: String, addrs: Vec<ResolvedAddr>) -> Vec<ResolvedAddr> {
        let expires_at = Instant::now() + CACHE_TTL;
        let result: Vec<ResolvedAddr> = addrs
            .into_iter()
            .map(|r| ResolvedAddr {
                addr: r.addr,
                source: r.source,
                expiry: expires_at,
            })
            .collect();
        if let Ok(mut guard) = self.cache.lock() {
            guard.insert(
                key,
                CachedResult {
                    addrs: result.clone(),
                    expires_at,
                },
            );
        }
        result
    }

    async fn resolve_srv(&self, host: &str) -> Option<Vec<ResolvedAddr>> {
        let lookup_name = format!("_ts3._udp.{host}");
        let response = self.dns.srv_lookup(lookup_name).await.ok()?;
        let addrs: Vec<ResolvedAddr> = response
            .iter()
            .map(|srv| {
                let target = srv.target().to_string().trim_end_matches('.').to_string();
                ResolvedAddr {
                    addr: join_host_port(&target, srv.port()),
                    source: "SRV".into(),
                    expiry: Instant::now() + CACHE_TTL,
                }
            })
            .collect();
        if addrs.is_empty() {
            None
        } else {
            Some(addrs)
        }
    }

    async fn query_tsdns(tsdns_addr: &str, query_host: &str, signal: Option<&AbortSignal>) -> Option<String> {
        let (host, port) = split_host_port(tsdns_addr);
        // Resolve TSDNS hostname via DNS first (TcpStream may fail on SRV-style names)
        let addr = if is_ip_address(host) {
            join_host_port(host, port)
        } else {
            let dns = TokioAsyncResolver::tokio(ResolverConfig::default(), ResolverOpts::default());
            let lookup = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                dns.ipv4_lookup(host),
            ).await.ok()?.ok()?;
            let ip = lookup.iter().next()?.to_string();
            join_host_port(&ip, port)
        };
        let connect = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            tokio::net::TcpStream::connect(&addr),
        );

        let mut stream = match signal {
            Some(sig) => tokio::select! {
                r = connect => r.ok()?,
                _ = sig.wait_for_abort() => return None,
            },
            None => connect.await.ok()?,
        }
        .ok()?;

        use tokio::io::AsyncWriteExt;
        let query = format!("{query_host}\n");
        if stream.write_all(query.as_bytes()).await.is_err() {
            return None;
        }

        let mut buf = String::new();
        use tokio::io::AsyncReadExt;
        let mut read_buf = [0u8; 1024];
        loop {
            let read = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                stream.read(&mut read_buf),
            );

            let n = match signal {
                Some(sig) => tokio::select! {
                    r = read => r.ok()?,
                    _ = sig.wait_for_abort() => return None,
                },
                None => read.await.ok()?,
            }
            .ok()?;
            if n == 0 {
                if !buf.is_empty() {
                    return Some(buf.trim().to_string());
                }
                break;
            }
            buf.push_str(&String::from_utf8_lossy(&read_buf[..n]));
            if let Some(idx) = buf.find('\n') {
                let line = buf[..idx].trim();
                if line.is_empty() || line == "404" || line == "errors" {
                    return None;
                } else {
                    return Some(line.to_string());
                }
            }
        }
        None
    }

    async fn resolve_tsdns_srv(&self, domains: &[String], query_host: &str, signal: Option<&AbortSignal>) -> Option<String> {
        for domain in domains {
            let lookup_name = format!("_tsdns._tcp.{domain}");
            let response = self.dns.srv_lookup(lookup_name).await.ok();
            let srvs = match response {
                Some(s) => s,
                None => continue,
            };
            for srv in srvs.iter() {
                let target = srv.target().to_string().trim_end_matches('.').to_string();
                let tsdns_addr = join_host_port(&target, srv.port());
                if let Some(result) = Self::query_tsdns(&tsdns_addr, query_host, signal).await {
                    return Some(result);
                }
            }
        }
        None
    }

    async fn resolve_tsdns_direct(domains: &[String], query_host: &str, signal: Option<&AbortSignal>) -> Option<String> {
        for domain in domains {
            let tsdns_addr = join_host_port(domain, TS_DNS_DEFAULT_PORT);
            if let Some(result) = Self::query_tsdns(&tsdns_addr, query_host, signal).await {
                return Some(result);
            }
        }
        None
    }
}

#[async_trait::async_trait]
impl AddrResolver for Resolver {
    async fn resolve(
        &self,
        addr: &str,
        signal: Option<&AbortSignal>,
    ) -> Result<Vec<ResolvedAddr>, Error> {
        if addr.is_empty() {
            return Err(Error::Teamspeak("empty address".into()));
        }

        if let Some(cached) = self.get_valid_cache(addr) {
            return Ok(cached);
        }

        let (host, port) = split_host_port(addr);

        if is_ip_address(host) {
            return Ok(vec![ResolvedAddr {
                addr: join_host_port(host, port),
                source: "Direct".into(),
                expiry: Instant::now(),
            }]);
        }

        if !host.contains('.') && host != "localhost" {
            if let Some(nick_addr) = resolve_nickname(host, signal).await {
                return self.resolve(&nick_addr, signal).await;
            }
        }

        if let Some(srv_results) = self.resolve_srv(host).await {
            return Ok(self.set_cache(addr.to_string(), srv_results));
        }

        let domain_list = get_domain_list(host);

        if let Some(tsdns) = self.resolve_tsdns_srv(&domain_list, host, signal).await {
            return Ok(self.set_cache(
                addr.to_string(),
                vec![ResolvedAddr {
                    addr: tsdns,
                    source: "TSDNS-SRV".into(),
                    expiry: Instant::now(),
                }],
            ));
        }

        if let Some(tsdns) = Self::resolve_tsdns_direct(&domain_list, host, signal).await {
            return Ok(self.set_cache(
                addr.to_string(),
                vec![ResolvedAddr {
                    addr: tsdns,
                    source: "TSDNS-Direct".into(),
                    expiry: Instant::now(),
                }],
            ));
        }

        let fallback = vec![ResolvedAddr {
            addr: join_host_port(host, port),
            source: "Direct".into(),
            expiry: Instant::now(),
        }];
        Ok(self.set_cache(addr.to_string(), fallback))
    }
}
