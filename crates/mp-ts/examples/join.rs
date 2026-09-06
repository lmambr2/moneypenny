// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! TS6 / TS3 go/no-go spike.
//!
//! Live UDP voice is **not** wired in Phase 0. This example:
//! 1. Documents the Option A (`tsclient-rs`) vs Option B (Node sidecar) gate.
//! 2. Exercises the `TsSession` mock so CI can run without a server.
//! 3. If `TS6_HOST` is set, prints the remaining live checklist (connect,
//!    nickname, chat, 10s Opus music, inbound voice, HTTP Query clientMove,
//!    reconnect after server restart).
//!
//!   cargo run -p mp-ts --example join
//!   TS6_HOST=192.168.1.10 TS6_NICK=moneypenny cargo run -p mp-ts --example join

use mp_ts::{MockSession, OpusPacket, Target, TsEvent, TsSession, CODEC_OPUS_MUSIC};

#[tokio::main]
async fn main() {
    let host = std::env::var("TS6_HOST").ok().filter(|s| !s.is_empty());
    match host {
        None => {
            println!("mp-ts join spike: no TS6_HOST — running mock only.");
            println!("Decision (Phase 0): Option A (tsclient-rs) is NOT compiled in.");
            println!("  Spike it on a live TS3 + TS6 6.0 beta before music/LLM work.");
            println!("  If inbound voiceData or Opus music send fails on TS6, take Option B");
            println!("  (keep @honeybbq/teamspeak-client as a Node sidecar). Do not start Option C.");
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
        }
        Some(host) => {
            let nick = std::env::var("TS6_NICK").unwrap_or_else(|_| "moneypenny".into());
            println!("TS6_HOST={host} nick={nick}");
            println!("Live Option A is not linked in this build (see docs/rust-rewrite.md).");
            println!("Checklist still required on a real server:");
            println!("  1. Connect, set nickname, join a channel");
            println!("  2. Receive textMessage / poke → reply");
            println!("  3. Play 10s of Opus music (CODEC_OPUS_MUSIC={CODEC_OPUS_MUSIC})");
            println!("  4. Capture inbound voiceData PCM");
            println!("  5. clientMove via HTTP Query + enrich serverGroups");
            println!("  6. Survive a server restart (reconnect scheduler)");
            println!("If 3 or 4 fail on TS6 with tsclient-rs → Option B. Do not stall.");
            std::process::exit(2);
        }
    }
}
