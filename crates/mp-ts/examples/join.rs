// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! TS6 / TS3 go/no-go spike.
//!
//! Mock (always):
//!   cargo run -p mp-ts --example join
//!
//! Live Option A (`tsclient-rs`):
//!   set -a && source /path/to/.env && set +a
//!   cargo run -p mp-ts --example join --features tsclient-rs
//!
//! Env: TS6_HOST, TS6_PORT (9987), TS6_NICK / BOT_NICKNAME, TS6_SERVER_PASSWORD,
//!      DEFAULT_CHANNEL, TS6_QUERY_HOST, TS6_QUERY_PORT (10080), TS6_API_KEY.

use mp_ts::{MockSession, OpusPacket, Target, TsEvent, TsSession, CODEC_OPUS_MUSIC};

#[tokio::main]
async fn main() {
    #[cfg(feature = "tsclient-rs")]
    {
        if std::env::var("TS6_HOST")
            .ok()
            .filter(|s| !s.is_empty())
            .is_some()
        {
            if let Err(e) = live::run().await {
                eprintln!("LIVE SPIKE FAILED: {e}");
                eprintln!("If connect/voice/Opus send failed on TS6 → Option B (Node sidecar).");
                std::process::exit(1);
            }
            return;
        }
        println!("feature tsclient-rs is on but TS6_HOST is empty — mock path.");
    }

    mock_only().await;
}

async fn mock_only() {
    println!("mp-ts join spike: mock only (no live TS6_HOST / no --features tsclient-rs).");
    let session = MockSession::new();
    session
        .send_text(Target::Channel, "mock hello")
        .await
        .expect("mock chat");
    session
        .send_opus(OpusPacket {
            codec: CODEC_OPUS_MUSIC,
            data: vec![0u8; 20],
        })
        .await
        .expect("mock opus");
    session.inject(TsEvent::Connected);
    println!("mock: send_text + send_opus + inject(Connected) ok");
    println!("Live: cargo run -p mp-ts --example join --features tsclient-rs");
}

#[cfg(feature = "tsclient-rs")]
mod live {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use mp_audio::NativeOpus;
    use mp_ts::CODEC_OPUS_MUSIC;
    use tsclient_rs::{self, Client, ClientOptions, EventMap};

    pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
        let host = std::env::var("TS6_HOST")?;
        let port: u16 = std::env::var("TS6_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(9987);
        let nick = std::env::var("TS6_NICK")
            .or_else(|_| std::env::var("BOT_NICKNAME"))
            .unwrap_or_else(|_| "Moneypenny".into());
        let addr = format!("{host}:{port}");
        println!("spike Option A tsclient-rs → {addr} nick={nick}");

        println!("generating identity (level 8)…");
        let identity = tsclient_rs::generateIdentity(8);
        let mut opts = ClientOptions::default();
        opts.server_password = std::env::var("TS6_SERVER_PASSWORD")
            .ok()
            .filter(|s| !s.is_empty());
        opts.default_channel = std::env::var("DEFAULT_CHANNEL")
            .ok()
            .filter(|s| !s.is_empty());

        let mut client = Client::new(identity, addr, nick, opts);

        let connected = Arc::new(AtomicBool::new(false));
        let voice_n = Arc::new(AtomicU32::new(0));
        let chat_n = Arc::new(AtomicU32::new(0));
        let last_voice: Arc<std::sync::Mutex<Option<(i32, i32, Vec<u8>)>>> =
            Arc::new(std::sync::Mutex::new(None));
        {
            let c = connected.clone();
            client.on_connected(Arc::new(move || {
                c.store(true, Ordering::SeqCst);
                println!("[1] connected");
            }));
        }
        {
            let n = chat_n.clone();
            client.on_text_message(Arc::new(move |ev| {
                if let EventMap::TextMessage(m) = ev {
                    n.fetch_add(1, Ordering::SeqCst);
                    println!(
                        "[2] text from {} (clid={}): {}",
                        m.invoker_name, m.invoker_id, m.message
                    );
                }
            }));
        }
        client.on_poked(Arc::new(|ev| {
            if let EventMap::Poked(p) = ev {
                println!("[2] poke: {p:?}");
            }
        }));
        {
            let n = voice_n.clone();
            let last = last_voice.clone();
            client.on_voice_data(Arc::new(move |ev| {
                if let EventMap::VoiceData(v) = ev {
                    let i = n.fetch_add(1, Ordering::SeqCst) + 1;
                    if i <= 8 || i % 50 == 0 {
                        println!(
                            "[4] voiceData #{i} clid={} codec={} bytes={}",
                            v.client_id,
                            v.codec,
                            v.data.len()
                        );
                    }
                    if let Ok(mut g) = last.lock() {
                        *g = Some((v.client_id, v.codec, v.data.to_vec()));
                    }
                }
            }));
        }
        client.on_disconnected(Arc::new(|ev| {
            println!("disconnected: {ev:?}");
        }));

        println!("connecting (25s timeout)…");
        match tokio::time::timeout(Duration::from_secs(25), client.connect()).await {
            Ok(Ok(())) => println!("connect() returned Ok"),
            Ok(Err(e)) => return Err(format!("connect() error: {e}").into()),
            Err(_) => return Err("connect() timed out after 25s".into()),
        }
        match tokio::time::timeout(Duration::from_secs(15), client.wait_connected(None)).await {
            Ok(Ok(())) => println!("wait_connected Ok"),
            Ok(Err(e)) => println!("wait_connected error: {e}"),
            Err(_) => println!("wait_connected timed out"),
        }
        println!(
            "status flag={} client_id={} channel_id={}",
            connected.load(Ordering::SeqCst),
            client.client_id(),
            client.channel_id()
        );
        if !connected.load(Ordering::SeqCst) && client.client_id() == 0 {
            return Err("connect did not reach connected state (server down, wrong password, or tsclient-rs handshake failed)".into());
        }
        println!(
            "[1] client_id={} channel_id={}",
            client.client_id(),
            client.channel_id()
        );

        // Channel chat (target_mode=2).
        let cid = client.channel_id();
        match tsclient_rs::sendTextMessage(&client, 2, cid, "mp-ts spike: hello from rust").await {
            Ok(()) => println!("[2] sent channel text"),
            Err(e) => println!("[2] send text FAILED: {e}"),
        }

        // Listen FIRST so a human already in the channel can talk.
        println!("[4] SPEAK NOW — listening 20s for inbound voiceData");
        let mut decoder = NativeOpus::new(48_000, 1).ok();
        let listen_until = tokio::time::Instant::now() + Duration::from_secs(20);
        let mut last = 0u32;
        while tokio::time::Instant::now() < listen_until {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let now = voice_n.load(Ordering::SeqCst);
            if now != last {
                last = now;
            }
        }
        let inbound = voice_n.load(Ordering::SeqCst);
        println!("[4] inbound voice frames={inbound}");
        if let Some((clid, codec, data)) = last_voice.lock().ok().and_then(|g| g.clone()) {
            if let Some(ref mut dec) = decoder {
                match dec.decode_voice(&data) {
                    Ok(r) => println!(
                        "[4] decode last packet clid={clid} codec={codec} ok={} reason={} pcm={} frames={}",
                        r.ok, r.reason, r.pcm.len(), r.frames
                    ),
                    Err(e) => println!("[4] decode last packet FAILED: {e}"),
                }
            }
        }

        // Short Opus music send (2s) after listen so it does not eat the talk window.
        println!("[3] encoding 2s Opus music (CODEC_OPUS_MUSIC={CODEC_OPUS_MUSIC})…");
        let mut opus = NativeOpus::new(48_000, 2)?;
        opus.set_bitrate_bps(64_000)?;
        let pcm = vec![0u8; 1920 * 2];
        let pkt = opus.encode(&pcm)?;
        let mut sent = 0u32;
        let mut tick = tokio::time::interval(Duration::from_millis(20));
        for _ in 0..100 {
            tick.tick().await;
            client.send_voice(pkt.clone(), i32::from(CODEC_OPUS_MUSIC));
            sent += 1;
        }
        println!("[3] sent {sent} Opus frames ({} bytes each)", pkt.len());

        // HTTP Query (not the UDP client).
        query_spike().await;

        println!("--- scorecard ---");
        println!("  1 connect/nick/channel : {}", connected.load(Ordering::SeqCst) || client.client_id() != 0);
        println!("  2 chat send            : attempted (recv count={})", chat_n.load(Ordering::SeqCst));
        println!("  3 10s Opus music send  : {sent} frames");
        println!("  4 inbound voiceData    : {inbound}");
        println!("  5 HTTP Query           : see above");
        println!("  6 reconnect            : not in this spike (reconnect-scheduler is Phase 2)");
        if inbound == 0 {
            println!("NOTE: 0 inbound frames may mean empty channel, not a codec bug.");
        }
        let _ = client.disconnect().await;
        Ok(())
    }

    async fn query_spike() {
        let qhost = std::env::var("TS6_QUERY_HOST")
            .or_else(|_| std::env::var("TS6_HOST"))
            .unwrap_or_default();
        let qport: u16 = std::env::var("TS6_QUERY_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(10080);
        let key = std::env::var("TS6_API_KEY").unwrap_or_default();
        if qhost.is_empty() {
            println!("[5] HTTP Query skipped (no TS6_QUERY_HOST)");
            return;
        }
        let url = format!("http://{qhost}:{qport}/1/clientlist");
        println!("[5] HTTP Query GET {url}");
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build();
        let client = match client {
            Ok(c) => c,
            Err(e) => {
                println!("[5] reqwest build failed: {e}");
                return;
            }
        };
        let mut req = client.get(&url).header("Accept", "application/json");
        if !key.is_empty() {
            req = req.header("x-api-key", key);
        }
        match req.send().await {
            Ok(res) => {
                let status = res.status();
                let body = res.text().await.unwrap_or_default();
                let snippet: String = body.chars().take(180).collect();
                println!("[5] HTTP Query status={status} body={snippet}");
            }
            Err(e) => println!("[5] HTTP Query FAILED: {e}"),
        }
    }
}
