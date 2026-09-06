// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Moneypenny bot process (Rust). Replaces `bot/src/index.ts` at cutover.
//! Phase 0/1: config + sqlite + axum health/session/SPA. TeamSpeak is mocked.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use clap::Parser;
use tracing::{error, info, warn};

#[derive(Parser, Debug)]
#[command(name = "moneypenny", about = "Moneypenny bot (Rust rewrite, WIP)")]
struct Args {
    /// Override data directory (config.json + moneypenny.db).
    #[arg(long, env = "MONEYPENNY_DATA_DIR")]
    data_dir: Option<std::path::PathBuf>,
    /// Open the DB read-only and assert table names, then exit.
    #[arg(long)]
    check_schema: bool,
    /// Do not apply CREATE TABLE (dual-run reader).
    #[arg(long)]
    read_only: bool,
}

#[tokio::main]
async fn main() {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .json()
        .init();

    let args = Args::parse();
    let mut paths = mp_config::Paths::resolve();
    if let Some(dir) = args.data_dir {
        paths.data_dir = dir.clone();
        paths.config_path = dir.join("config.json");
        paths.db_path = dir.join("moneypenny.db");
    }

    let config = match mp_config::load_config(&paths.config_path) {
        Ok(c) => c,
        Err(e) => {
            error!(error = %e, "config");
            std::process::exit(1);
        }
    };
    info!(
        bind = %config.bind_addr(),
        config = %paths.config_path.display(),
        db = %paths.db_path.display(),
        "starting moneypenny (rust)"
    );

    if args.check_schema || args.read_only {
        if !paths.db_path.exists() {
            error!(path = %paths.db_path.display(), "moneypenny.db not found");
            std::process::exit(2);
        }
        match mp_db::Database::open_read_only(&paths.db_path) {
            Ok(db) => match db.assert_expected_tables() {
                Ok(()) => {
                    let names = db.table_names().unwrap_or_default();
                    info!(tables = names.len(), "schema ok (read-only)");
                    if args.check_schema {
                        return;
                    }
                }
                Err(e) => {
                    error!(error = %e, "schema mismatch");
                    std::process::exit(3);
                }
            },
            Err(e) => {
                error!(error = %e, "open db");
                std::process::exit(2);
            }
        }
    }

    let db = if args.read_only {
        mp_db::Database::open_read_only(&paths.db_path)
    } else {
        mp_db::Database::open(&paths.db_path)
    };
    let db = match db {
        Ok(d) => Arc::new(d),
        Err(e) => {
            error!(error = %e, "sqlite");
            std::process::exit(1);
        }
    };
    if let Err(e) = db.assert_expected_tables() {
        warn!(error = %e, "schema assertion (continuing; Node may still own extra tables)");
    }
    info!(
        users = db.user_count().unwrap_or(0),
        opus = mp_audio::native_audio_backend(),
        "database ready"
    );

    let _ts = mp_ts::MockSession::new();
    info!("ts session: mock (Option A/B not chosen — see docs/rust-rewrite.md)");

    let addr: SocketAddr = match config.bind_addr().parse() {
        Ok(a) => a,
        Err(_) => {
            error!(addr = %config.bind_addr(), "invalid bind address");
            std::process::exit(1);
        }
    };

    let state = mp_http::AppState::new(db, Arc::new(config), paths.static_dir.clone());
    start_watchdog();
    if let Err(e) = mp_http::serve(state, addr).await {
        error!(error = %e, "http server");
        std::process::exit(1);
    }
}

fn start_watchdog() {
    let limit_mb: u64 = std::env::var("WATCHDOG_MEMORY_MB")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        let started = Instant::now();
        loop {
            interval.tick().await;
            if limit_mb > 0 {
                // RSS via /proc; 0 on non-linux.
                if let Some(rss) = rss_mb() {
                    if rss > limit_mb {
                        error!(rss_mb = rss, limit_mb, "memory ceiling exceeded");
                        std::process::exit(2);
                    }
                }
            }
            tracing::debug!(uptime_s = started.elapsed().as_secs(), "watchdog tick");
        }
    });
}

fn rss_mb() -> Option<u64> {
    let stat = std::fs::read_to_string("/proc/self/statm").ok()?;
    let pages: u64 = stat.split_whitespace().next()?.parse().ok()?;
    let page = 4096u64;
    Some(pages * page / (1024 * 1024))
}
