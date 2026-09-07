// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Moneypenny bot process (Rust). Replaces `bot/src/index.ts` at cutover.
//! Phase 4: TS live session, local !play/!skip/!queue, Vue HTTP parity,
//! POST /v1/turn (LLM proposes, executor disposes).

mod bot;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use clap::Parser;
use mp_ts::TsSession;
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

    let config = Arc::new(config);
    let music_dir = std::env::var("MUSIC_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default().join("music"));
    let protected = config.playback_ban_protected_artists.clone();
    let blacklist = Arc::new(mp_music::PlaybackBlacklist::new(Arc::clone(&db), move || {
        protected.clone()
    }));
    let station = Arc::new(mp_music::MusicStation::new(&music_dir, Some(blacklist)));
    station
        .player
        .set_bitrate_kbps(config.music_opus_bitrate_kbps as i32);
    info!(dir = %music_dir.display(), tracks = station.local.track_count(), "music library");

    let rights = if !config.rights_enabled {
        None
    } else if let Some(v) = &config.rights {
        mp_rights::parse_rights_config(v).map(|c| {
            Arc::new(mp_rights::RightsEngine::new(c))
        })
    } else {
        Some(Arc::new(mp_rights::RightsEngine::new(
            mp_control::legacy_rights_config(&config.admin_groups),
        )))
    };

    let addr: SocketAddr = match config.bind_addr().parse() {
        Ok(a) => a,
        Err(_) => {
            error!(addr = %config.bind_addr(), "invalid bind address");
            std::process::exit(1);
        }
    };

    let executor = Arc::new(mp_control::CommandExecutor::new(
        Arc::clone(&station),
        config.command_prefix.clone(),
    ));

    let embed_url = if config.embedding_url.trim().is_empty() {
        std::env::var("EMBEDDING_URL").unwrap_or_default()
    } else {
        config.embedding_url.clone()
    };
    let vector_url = if config.vector_db_url.trim().is_empty() {
        std::env::var("VECTOR_DB_URL").unwrap_or_default()
    } else {
        config.vector_db_url.clone()
    };
    let retrieval = Arc::new(mp_rag::RetrievalStore::new(
        mp_rag::build_embedder(&embed_url, &config.embedding_model),
        mp_rag::build_vector_store(&vector_url),
        if config.rag_collection.is_empty() {
            "moneypenny_docs".into()
        } else {
            config.rag_collection.clone()
        },
        config.rag_top_k as usize,
    ));
    let doctrine = Arc::new(
        mp_rag::DoctrineStore::new(Arc::clone(&db), &paths.data_dir).unwrap_or_else(|e| {
            error!(error = %e, "doctrine store");
            std::process::exit(1);
        }),
    );
    let rag = mp_rag::RagRuntime::new(
        retrieval,
        doctrine,
        config.rag_enabled,
        config.memory_enabled,
        config.rag_top_k as usize,
    );
    info!(
        rag = config.rag_enabled,
        memory = config.memory_enabled,
        embed = %if embed_url.is_empty() { "hash-dev" } else { embed_url.as_str() },
        vectors = %if vector_url.is_empty() { "memory" } else { vector_url.as_str() },
        "rag runtime"
    );

    let state = mp_http::AppState::new(Arc::clone(&db), Arc::clone(&config), paths.static_dir.clone())
        .with_music(Arc::clone(&station), Arc::clone(&executor), rights.clone())
        .with_rag(Arc::clone(&rag));
    let voice = Arc::clone(&state.voice);
    {
        let rag_c = Arc::clone(&rag);
        let db_c = Arc::clone(&db);
        let retrieve: mp_brain::RetrieveFn = Arc::new(move |q, ctx| {
            let rag = Arc::clone(&rag_c);
            let db = Arc::clone(&db_c);
            Box::pin(async move {
                let mut sources = Vec::new();
                if rag.rag_enabled() {
                    let allowed = ctx.allowed_classifications.clone();
                    let chunks = rag
                        .retrieval
                        .query(&q, Some(rag.top_k()), allowed.as_deref())
                        .await;
                    for c in chunks {
                        sources.push(mp_brain::TurnSource {
                            source: c.source,
                            text: Some(c.text),
                            classification: Some(c.classification),
                            score: Some(c.score),
                        });
                    }
                }
                if rag.memory_enabled() {
                    if let Some(uid) = ctx.user_uid.as_deref() {
                        if let Ok(facts) = db.memory().recall(uid, 10) {
                            for f in facts {
                                sources.push(mp_brain::TurnSource {
                                    source: "your memory".into(),
                                    text: Some(f.fact),
                                    classification: Some("unclassified".into()),
                                    score: Some(1.0),
                                });
                            }
                        }
                    }
                }
                Ok(sources)
            })
        });
        state.brain.set_retrieve(retrieve).await;
    }
    let brain = Arc::clone(&state.brain);
    start_watchdog();

    let http = tokio::spawn(async move {
        if let Err(e) = mp_http::serve(state, addr).await {
            error!(error = %e, "http server");
        }
    });

    start_teamspeak(
        Arc::clone(&station),
        rights,
        config.command_prefix.clone(),
        config.command_aliases.clone(),
        &paths.data_dir,
        bot::BotServices {
            db: Arc::clone(&db),
            brain,
            rag: Some(rag),
        },
        voice,
    )
    .await;

    let _ = http.await;
}

async fn start_teamspeak(
    station: Arc<mp_music::MusicStation>,
    rights: Option<Arc<mp_rights::RightsEngine>>,
    prefix: String,
    aliases: std::collections::HashMap<String, String>,
    data_dir: &std::path::Path,
    services: bot::BotServices,
    voice: Arc<mp_voice::VoiceRuntime>,
) {
    #[cfg(feature = "ts6")]
    {
        if let Some(cfg) = mp_ts::TsConnectConfig::from_env(data_dir) {
            let session = Arc::new(mp_ts::LiveSession::new(cfg));
            let (sched, mut driver) = mp_ts::ReconnectScheduler::pair(2_000, 60_000);
            {
                let s = Arc::clone(&session);
                let sched = sched.clone();
                let st = Arc::clone(&station);
                tokio::spawn(async move {
                    let mut rx = s.subscribe();
                    loop {
                        match rx.recv().await {
                            Ok(mp_ts::TsEvent::Disconnected { .. }) if !s.is_closing() => {
                                st.set_connected(false);
                                sched.schedule("bot", "disconnected");
                            }
                            Ok(mp_ts::TsEvent::Connected) => {
                                st.set_connected(true);
                                sched.reset("bot");
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                            _ => {}
                        }
                    }
                });
            }
            let loop_ = bot::BotLoop::new(
                Arc::clone(&session),
                Arc::clone(&station),
                rights,
                prefix,
                aliases,
                services,
                voice,
            );
            let session_c = Arc::clone(&session);
            let station_c = Arc::clone(&station);
            let session_r = Arc::clone(&session);
            let station_r = Arc::clone(&station);
            tokio::select! {
                _ = async {
                    match session_c.connect().await {
                        Ok(()) => {
                            info!("ts session: live (tsclient-rs)");
                            station_c.set_connected(true);
                        }
                        Err(e) => {
                            error!(error = %e, "ts connect failed — HTTP still up, will reconnect");
                            station_c.set_connected(false);
                            sched.schedule("bot", "initial-connect");
                        }
                    }
                    std::future::pending::<()>().await;
                } => {}
                _ = loop_.run() => {}
                _ = driver.run(move |_id| {
                    let s = Arc::clone(&session_r);
                    let st = Arc::clone(&station_r);
                    async move {
                        match s.reconnect().await {
                            Ok(()) => {
                                st.set_connected(true);
                                Ok(())
                            }
                            Err(e) => Err(e.to_string()),
                        }
                    }
                }) => {}
            }
            return;
        }
        let _ = voice;
        info!("TS6_HOST empty — HTTP only (no TeamSpeak)");
    }
    #[cfg(not(feature = "ts6"))]
    {
        let _ = (station, rights, prefix, aliases, data_dir, services, voice);
        info!("ts session: mock (built without ts6 feature)");
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
