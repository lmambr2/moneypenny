// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! One-shot channel chat sender for live tests.
//!
//!   TS6_HOST=127.0.0.1 TS6_NICK=PennyTester \
//!     cargo run -p mp-ts --example chat --features tsclient-rs -- '!play sine'

#[cfg(not(feature = "tsclient-rs"))]
fn main() {
    eprintln!("chat example needs --features tsclient-rs");
    std::process::exit(2);
}

#[cfg(feature = "tsclient-rs")]
#[tokio::main]
async fn main() {
    let msg = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "!queue".into());
    if let Err(e) = send(&msg).await {
        eprintln!("chat send failed: {e}");
        std::process::exit(1);
    }
}

#[cfg(feature = "tsclient-rs")]
async fn send(msg: &str) -> Result<(), Box<dyn std::error::Error>> {
    use std::time::Duration;
    use tsclient_rs::{Client, ClientOptions};

    let host = std::env::var("TS6_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port: u16 = std::env::var("TS6_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(9987);
    let nick = std::env::var("TS6_NICK").unwrap_or_else(|_| "PennyTester".into());
    let addr = format!("{host}:{port}");
    println!("chat → {addr} nick={nick} msg={msg}");
    let identity = tsclient_rs::generateIdentity(8);
    let mut opts = ClientOptions::default();
    opts.server_password = std::env::var("TS6_SERVER_PASSWORD")
        .ok()
        .filter(|s| !s.is_empty());
    let mut client = Client::new(identity, addr, nick, opts);
    tokio::time::timeout(Duration::from_secs(20), client.connect()).await??;
    let _ = tokio::time::timeout(Duration::from_secs(10), client.wait_connected(None)).await;
    let cid = {
        let reported = client.channel_id();
        if reported == 0 { 1 } else { reported }
    };
    tsclient_rs::sendTextMessage(&client, 2, cid, msg).await?;
    println!("sent (clid={} cid={cid})", client.client_id());
    tokio::time::sleep(Duration::from_secs(2)).await;
    let _ = client.disconnect().await;
    Ok(())
}
