// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT
#![recursion_limit = "256"]

//! Axum HTTP surface. Domain bundle order matches `domain-bundles.ts`:
//! SYSTEM → MCP (stub) → SESSION → BRAIN (`POST /v1/turn`) → STATION API → SPA → WS.
//!
//! Live through rewrite Phase 9 extras: health, session/CSRF, Vue SPA, `/api/bot` +
//! local/YouTube/stream music/player, live-status WS, `POST /v1/turn`, doctrine
//! RAG + memory + multipart/export/reformat, inbound voice (STT/TTS HTTP),
//! radio bumpers, roast, seed economy, MCP REST, audit log.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderName, HeaderValue, header};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Serialize;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
pub use tokio_util::sync::CancellationToken;
use tower_http::set_header::SetResponseHeaderLayer;
use tracing::{info, warn};

mod authz;
mod bot_api;
mod brain;
mod command;
mod csrf;
mod economy_api;
mod follow;
mod handset_auth;
mod handset_pair;
mod handset_turn;
mod handset_utterance;
mod handset_verb;
mod harness;
mod intent_round;
mod json_song;
mod llm_catalog;
mod mcp_api;
mod music_api;
mod openapi;
mod player_api;
mod radio_api;
mod radio_seed;
mod rag_api;
mod rate_limit;
mod recordings;
mod roast;
mod sc_org;
mod session;
mod session_roles;
mod skills;
mod spa;
mod status_api;
mod stubs;
mod users_api;
mod voice_api;
mod workflow;
mod ws;

pub use command::dispatch_command;
pub use csrf::csrf_origin_check;
pub use follow::FollowRuntime;
pub use roast::RoastRuntime;
pub use sc_org::ScOrgRuntime;
pub use session::SESSION_COOKIE_NAME;
pub use session_roles::{SessionHandle, SessionQuery};

use mp_config::BotConfig;
use mp_db::Database;
use rate_limit::RateLimiter;

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Database>,
    /// Live settings snapshot. Boot clones the loaded file into this lock so
    /// a Settings save is visible to the next GET without a restart.
    pub config: Arc<std::sync::RwLock<BotConfig>>,
    pub started: Instant,
    pub static_dir: Option<PathBuf>,
    pub station: Option<Arc<mp_music::MusicStation>>,
    pub executor: Option<Arc<mp_control::CommandExecutor>>,
    pub rights: Option<Arc<mp_rights::RightsEngine>>,
    pub bot_id: String,
    pub bot_name: String,
    pub ws_tx: broadcast::Sender<serde_json::Value>,
    pub brain: Arc<mp_brain::BrainRuntime>,
    pub rag: Option<Arc<mp_rag::RagRuntime>>,
    pub voice: Arc<mp_voice::VoiceRuntime>,
    pub radio: Arc<mp_radio::RadioRuntime>,
    pub roast: Arc<roast::RoastRuntime>,
    pub speech: Option<Arc<mp_music::ChannelSpeech>>,
    pub mcp: mp_mcp::McpConfig,
    /// Rewrite worktree `data/config.json`. Empty path skips Settings persist.
    pub config_path: PathBuf,
    pub data_dir: PathBuf,
    pub harness: Arc<harness::HarnessStore>,
    pub recordings_enabled: Arc<AtomicBool>,
    pub harness_allow_dangerous: Arc<AtomicBool>,
    /// Set only after `HANDSET_BIND` accepts a socket. Pair codes read this.
    pub handset_bound: Arc<AtomicBool>,
    pub follow: Arc<FollowRuntime>,
    pub sc_org: Arc<ScOrgRuntime>,
    login_limit: Arc<RateLimiter>,
    setup_limit: Arc<RateLimiter>,
    pair_limit: Arc<RateLimiter>,
    /// One flight for every handset listener. The guard is held across STT
    /// and the model call, then moved into the task that disposes tools,
    /// speaks, or runs a verb.
    handset_flight: Arc<tokio::sync::Mutex<()>>,
    handset_turns: handset_turn::HandsetTurns,
    /// Bounds STT plus the model call. Dispose, speech, and verbs keep going.
    handset_deadline: Duration,
    /// Tests hold the flight guard inside the dispose or verb task. Production stays at zero.
    handset_dispose_delay: Duration,
}

impl AppState {
    pub fn read_config(&self) -> std::sync::RwLockReadGuard<'_, BotConfig> {
        self.config.read().unwrap_or_else(|e| e.into_inner())
    }

    pub fn new(db: Arc<Database>, config: Arc<BotConfig>, static_dir: Option<PathBuf>) -> Self {
        let config = (*config).clone();
        let (ws_tx, _) = broadcast::channel(64);
        let brain = mp_brain::BrainRuntime::from_settings(brain::llm_settings_from(&config));
        let voice = mp_voice::VoiceRuntime::from_config(
            config.voice.clone(),
            config.command_aliases.clone(),
        );
        let radio = mp_radio::RadioRuntime::from_config(
            config.radio.clone(),
            std::env::var("BOT_NICKNAME")
                .or_else(|_| std::env::var("BOT_NAME"))
                .unwrap_or_else(|_| "Moneypenny".into()),
        );
        radio.set_tts(config.voice.tts_url.clone(), config.voice.tts_voice.clone());
        radio.set_llm(Arc::clone(&brain));
        let voice_floor = Arc::clone(&voice);
        radio.set_on_voice_floor(Arc::new(move |floor| voice_floor.set_floor(floor)));
        let brain_resident = Arc::clone(&brain);
        voice.spawn_supervisor(Arc::new(move |on| {
            let brain = Arc::clone(&brain_resident);
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn(async move {
                    brain.set_talker_resident(on).await;
                });
            }
        }));
        let roast = roast::RoastRuntime::new(
            Arc::clone(&db),
            Arc::clone(&brain),
            roast::RoastConfig::from_bot(&config),
        );
        let recordings_enabled = Arc::new(AtomicBool::new(config.recordings_enabled));
        let harness_allow_dangerous =
            Arc::new(AtomicBool::new(config.harness_intent_allow_dangerous));
        let follow = Arc::new(FollowRuntime::from_config(
            config.auto_follow_enabled,
            config.auto_follow_cooldown_sec,
            config.auto_follow_afk_channels.clone(),
        ));
        let sc_org = Arc::new(ScOrgRuntime::from_config(
            &config.sc_org_status_url,
            &config.sc_org_name,
        ));
        let bot_id = db.profile().active_id();
        Self {
            db,
            config: Arc::new(std::sync::RwLock::new(config)),
            started: Instant::now(),
            static_dir,
            station: None,
            executor: None,
            rights: None,
            bot_id,
            bot_name: std::env::var("BOT_NICKNAME")
                .or_else(|_| std::env::var("BOT_NAME"))
                .unwrap_or_else(|_| "Moneypenny".into()),
            ws_tx,
            brain,
            rag: None,
            voice,
            radio,
            roast,
            speech: None,
            mcp: mp_mcp::McpConfig::default(),
            config_path: PathBuf::new(),
            data_dir: PathBuf::new(),
            harness: Arc::new(harness::HarnessStore::default()),
            recordings_enabled,
            harness_allow_dangerous,
            handset_bound: Arc::new(AtomicBool::new(false)),
            follow,
            sc_org,
            login_limit: Arc::new(RateLimiter::new(5, 5.0 / 60.0)),
            setup_limit: Arc::new(RateLimiter::new(3, 3.0 / 60.0)),
            pair_limit: Arc::new(RateLimiter::new(5, 5.0 / 60.0)),
            handset_flight: Arc::new(tokio::sync::Mutex::new(())),
            handset_turns: handset_turn::HandsetTurnMap::new(),
            handset_deadline: Duration::from_secs(20),
            handset_dispose_delay: Duration::ZERO,
        }
    }

    pub fn with_rag(mut self, rag: Arc<mp_rag::RagRuntime>) -> Self {
        self.radio.set_retrieval(Arc::clone(&rag.retrieval));
        self.radio.set_kg(Arc::clone(&rag.kg));
        if let Some(c) = rag.mempalace.clone() {
            self.radio.set_mempalace(c);
        }
        self.rag = Some(rag);
        self
    }

    pub fn with_brain(mut self, brain: Arc<mp_brain::BrainRuntime>) -> Self {
        self.radio.set_llm(Arc::clone(&brain));
        self.brain = brain;
        self
    }

    pub fn with_mcp(mut self, mcp: mp_mcp::McpConfig) -> Self {
        self.mcp = mcp;
        self
    }

    pub fn with_config_path(mut self, path: PathBuf) -> Self {
        if let Some(dir) = path.parent() {
            self.radio.set_bumper_dir(mp_radio::default_bumper_dir(dir));
            self.radio.set_bumper_cache_dir(dir.join("bumper-cache"));
            self.data_dir = dir.to_path_buf();
        }
        self.config_path = path;
        self
    }

    pub fn with_voice(mut self, voice: Arc<mp_voice::VoiceRuntime>) -> Self {
        self.voice = voice;
        self
    }

    pub fn with_music(
        mut self,
        station: Arc<mp_music::MusicStation>,
        executor: Arc<mp_control::CommandExecutor>,
        rights: Option<Arc<mp_rights::RightsEngine>>,
    ) -> Self {
        self.radio.bind_station(Arc::clone(&station));
        self.speech = Some(mp_music::ChannelSpeech::new(Arc::clone(&station)));
        self.station = Some(station);
        self.executor = Some(executor);
        self.rights = rights;
        radio_seed::install_local_seed(&self);
        self
    }
}

#[derive(Serialize)]
struct HealthBody {
    status: &'static str,
    version: &'static str,
    opus: OpusHealth,
    llm: LlmHealth,
}

#[derive(Serialize)]
struct OpusHealth {
    native: bool,
    active: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LlmHealth {
    route: &'static str,
    degraded: bool,
    last_age_sec: Option<u64>,
}

async fn health() -> Json<HealthBody> {
    let native = mp_audio::native_audio_backend() == "rust-libopus";
    Json(HealthBody {
        status: "ok",
        version: "0.1.0",
        opus: OpusHealth {
            native,
            active: if native { "native" } else { "unavailable" },
        },
        llm: LlmHealth {
            route: "none",
            degraded: false,
            last_age_sec: None,
        },
    })
}

async fn healthz() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn public_url(State(st): State<AppState>) -> Json<serde_json::Value> {
    let cfg = st.read_config();
    let raw = cfg.public_url.trim().trim_end_matches('/');
    Json(serde_json::json!({
        "publicUrl": if raw.is_empty() { serde_json::Value::Null } else { raw.into() }
    }))
}

fn security_headers() -> SetResponseHeaderLayer<HeaderValue> {
    SetResponseHeaderLayer::overriding(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    )
}

pub fn router(state: AppState) -> Router {
    let public = Router::new()
        .route("/api/health", get(health))
        .route("/api/healthz", get(healthz))
        .route("/api/config/public-url", get(public_url))
        .route("/api/openapi.json", get(openapi::openapi_json))
        .route("/api/docs", get(openapi::docs_html))
        .route("/api/docs/", get(openapi::docs_html))
        .route("/api/session/needs-setup", get(session::needs_setup))
        .route("/api/session/setup", post(session::setup))
        .route("/api/session/login", post(session::login))
        .route("/api/session/logout", post(session::logout))
        .route("/api/session/me", get(session::me))
        .route(
            "/api/session/change-password",
            post(session::change_password),
        )
        .route("/v1/turn", post(brain::turn));

    let protected = Router::new()
        .route(
            "/api/bot",
            get(bot_api::list_bots).post(bot_api::create_bot),
        )
        .route(
            "/api/bot/settings",
            get(bot_api::settings_get).post(bot_api::settings_post),
        )
        .route("/api/bot/live", get(bot_api::live))
        .route(
            "/api/bot/recordings",
            get(recordings::recordings_list).post(recordings::recordings_upload),
        )
        .route(
            "/api/bot/recordings/{name}",
            get(recordings::recordings_get).delete(recordings::recordings_delete),
        )
        .route("/api/bot/llm/status", get(status_api::llm_status))
        .route("/api/bot/llm/models", get(llm_catalog::llm_models))
        .route("/api/bot/voice/status", get(voice_api::voice_status))
        .route("/api/bot/voice/test", post(voice_api::voice_test))
        .route("/api/bot/radio/status", get(radio_api::radio_status))
        .route(
            "/api/bot/radio/test-bumper",
            post(radio_api::radio_test_bumper),
        )
        .route(
            "/api/bot/radio/prewarm-bumpers",
            post(radio_api::radio_prewarm),
        )
        .route(
            "/api/bot/radio/clear-bumper-cache",
            post(radio_api::radio_clear_cache),
        )
        .route("/api/bot/rag/status", get(status_api::rag_status))
        .route("/api/bot/memory/status", get(status_api::memory_status))
        .route("/api/bot/ace-step/status", get(stubs::bot_status_stub))
        .route(
            "/api/bot/stream-bridge/status",
            get(status_api::stream_bridge_status),
        )
        .route("/api/bot/ops/status", get(status_api::ops_status))
        .route("/api/bot/rights/debug", get(status_api::rights_debug))
        .route(
            "/api/bot/voice/under-music-check",
            get(voice_api::under_music_check),
        )
        .route("/api/bot/memory/scopes", get(status_api::memory_scopes))
        .route("/api/bot/memory/private", get(status_api::memory_private))
        .route(
            "/api/bot/org-kg",
            get(status_api::org_kg_get).post(status_api::org_kg_post),
        )
        .route("/api/bot/harness/turns", get(harness::harness_turns))
        .route("/api/bot/harness/ask", post(harness::harness_ask))
        .route("/api/bot/rag/eval", post(rag_api::rag_eval))
        .route("/api/bot/rag/query", post(rag_api::rag_query))
        .route("/api/bot/llm/ask", post(status_api::llm_ask))
        .route(
            "/api/bot/{id}",
            get(bot_api::get_bot).delete(bot_api::delete_bot),
        )
        .route("/api/bot/{id}/start", post(bot_api::start_bot))
        .route("/api/bot/{id}/stop", post(bot_api::stop_bot))
        .route("/api/bot/{id}/config", get(bot_api::bot_config))
        .route("/api/music/search", get(music_api::search))
        .route("/api/music/search/all", get(music_api::search_all))
        .route("/api/music/library", get(music_api::library))
        .route("/api/music/stats", get(music_api::stats))
        .route("/api/music/refresh", post(music_api::refresh))
        .route("/api/music/lyrics/{id}", get(music_api::lyrics))
        .route(
            "/api/music/blacklist",
            get(music_api::blacklist_get).post(music_api::blacklist_post),
        )
        .route(
            "/api/music/blacklist/{id}",
            delete(music_api::blacklist_delete),
        )
        .route(
            "/api/music/tracks/{id}/tags",
            get(music_api::tags_get).patch(music_api::tags_patch),
        )
        .route(
            "/api/music/tracks/{id}/tags/guess",
            post(music_api::tags_guess),
        )
        .route(
            "/api/music/tracks/tags/bulk",
            axum::routing::patch(music_api::tags_bulk),
        )
        .route(
            "/api/music/tracks/{id}/rating",
            post(music_api::rating_post).delete(music_api::rating_delete),
        )
        .route("/api/music/tracks/{id}", delete(music_api::track_delete))
        .route("/api/music/analyze/status", get(music_api::analyze_status))
        .route("/api/music/analyze", post(music_api::analyze_post))
        .route("/api/music/upload", post(music_api::music_upload))
        .route("/api/bot/ace-step/generate", post(stubs::not_ported))
        .route("/api/rag/doctrine/new", post(rag_api::doctrine_new))
        .route("/api/rag/doctrine/reindex", post(rag_api::doctrine_reindex))
        .route(
            "/api/rag/doctrine/reformat",
            post(rag_api::doctrine_reformat),
        )
        .route("/api/rag/query", post(rag_api::rag_query))
        .route("/api/rag/ingest", post(rag_api::rag_ingest))
        .route(
            "/api/economy/workorders",
            get(economy_api::workorders_get)
                .post(economy_api::workorders_post)
                .delete(economy_api::workorders_clear),
        )
        .route(
            "/api/economy/workorders/{id}",
            delete(economy_api::workorders_delete_one),
        )
        .route(
            "/api/economy/cache/refresh",
            post(economy_api::cache_refresh),
        )
        .route(
            "/api/economy/ingest/terminal-snapshot",
            post(economy_api::ingest_snapshot),
        )
        .route(
            "/api/economy/ingest/snapshots",
            get(economy_api::list_snapshots),
        )
        .route(
            "/api/economy/ingest/snapshots/{id}/accept",
            post(economy_api::snapshot_accept),
        )
        .route(
            "/api/economy/ingest/snapshots/{id}/reject",
            post(economy_api::snapshot_reject),
        )
        .route("/api/economy/trade/routes", post(economy_api::trade_routes))
        .route("/api/economy/trade/buyers", post(economy_api::trade_buyers))
        .route(
            "/api/economy/trade/itinerary",
            post(economy_api::trade_itinerary),
        )
        .route(
            "/api/economy/trade/circuit",
            post(economy_api::trade_circuit),
        )
        .route("/api/player/{botId}/play", post(player_api::play))
        .route("/api/player/{botId}/add", post(player_api::add))
        .route("/api/player/{botId}/pause", post(player_api::pause))
        .route("/api/player/{botId}/resume", post(player_api::resume))
        .route("/api/player/{botId}/next", post(player_api::next))
        .route("/api/player/{botId}/prev", post(player_api::prev))
        .route("/api/player/{botId}/stop", post(player_api::stop))
        .route("/api/player/{botId}/elapsed", get(player_api::elapsed))
        .route("/api/player/{botId}/queue", get(player_api::queue_get))
        .route(
            "/api/player/{botId}/queue/{index}",
            delete(player_api::queue_remove),
        )
        .route("/api/player/{botId}/volume", post(player_api::volume))
        .route("/api/player/{botId}/mode", post(player_api::mode))
        .route("/api/player/{botId}/play-at", post(player_api::play_at))
        .route("/api/player/{botId}/play-song", post(player_api::play_song))
        .route("/api/player/{botId}/add-song", post(player_api::add_song))
        .route(
            "/api/player/{botId}/play-by-id",
            post(player_api::play_by_id),
        )
        .route("/api/player/{botId}/add-by-id", post(player_api::add_by_id))
        .route(
            "/api/player/{botId}/play-next-song",
            post(player_api::play_next_song),
        )
        .route("/api/player/{botId}/seek", post(player_api::seek))
        .route("/api/player/{botId}/history", get(player_api::history))
        .route(
            "/api/player/{botId}/profile",
            get(player_api::profile_get).put(player_api::profile_put),
        )
        .route("/api/auth/status", get(stubs::auth_status))
        .route("/api/economy/overview", get(economy_api::overview))
        .route("/api/economy/ores", get(economy_api::ores))
        .route("/api/economy/methods", get(economy_api::methods))
        .route("/api/economy/boxes", get(economy_api::boxes))
        .route("/api/economy/cache", get(economy_api::cache))
        .route("/api/economy/commodities", get(economy_api::commodities))
        .route("/api/economy/prices", get(economy_api::prices))
        .route("/api/economy/mine", get(economy_api::mine))
        .route("/api/economy/refine", get(economy_api::refine))
        .route("/api/economy/craft", get(economy_api::craft))
        .route("/api/economy/blueprints", get(economy_api::blueprints))
        .route("/api/economy/trade/ships", get(economy_api::trade_ships))
        .route(
            "/api/rag/doctrine",
            get(rag_api::doctrine_list).post(rag_api::doctrine_upload),
        )
        .route(
            "/api/rag/doctrine/export/capabilities",
            get(rag_api::doctrine_export_caps),
        )
        .route("/api/rag/doctrine/hygiene", get(rag_api::doctrine_hygiene))
        .route(
            "/api/rag/doctrine/{source}/export",
            get(rag_api::doctrine_export),
        )
        .route(
            "/api/rag/doctrine/{source}",
            get(rag_api::doctrine_get)
                .put(rag_api::doctrine_put)
                .delete(rag_api::doctrine_delete),
        )
        .route(
            "/api/users",
            get(users_api::users_list).post(users_api::users_create),
        )
        .route("/api/audit", get(session::audit_list))
        .route("/api/users/{id}", delete(users_api::users_delete))
        .route(
            "/api/users/{id}/role",
            axum::routing::patch(users_api::users_role),
        )
        .route(
            "/api/users/{id}/reset-password",
            post(users_api::users_reset_password),
        )
        .route("/api/handset/pair-codes", post(handset_pair::issue))
        .route("/api/handset/devices", get(handset_pair::list_devices))
        .route(
            "/api/handset/devices/{id}",
            delete(handset_pair::delete_device),
        );

    let api = public
        .merge(protected)
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .layer(axum::middleware::from_fn(csrf::csrf_origin_check));

    let ws_route = Router::new().route("/ws", get(ws::upgrade));
    let mcp = mcp_api::router();

    let mut app = Router::new()
        .merge(mcp)
        .merge(api)
        .merge(ws_route)
        .layer(security_headers())
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static("frame-ancestors 'none'"),
        ));

    app = spa::with_spa(app, state.static_dir.clone());
    app.with_state(state)
}

pub async fn serve(state: AppState, addr: SocketAddr) -> Result<(), std::io::Error> {
    serve_with_handset(state, addr, None).await
}

/// Admin router on `admin`. Optional handset router on `handset`.
/// One shutdown token covers both. A handset bind failure leaves admin up
/// and leaves `handset_bound` false.
pub async fn serve_with_handset(
    state: AppState,
    admin: SocketAddr,
    handset: Option<SocketAddr>,
) -> Result<(), std::io::Error> {
    let shutdown = CancellationToken::new();
    let watcher = shutdown.clone();
    tokio::spawn(async move {
        shutdown_signal().await;
        watcher.cancel();
    });
    serve_until(state, admin, handset, shutdown).await
}

/// HTTP until `shutdown` fires. The process signal watcher lives in `main`
/// so TeamSpeak and the player see the same token.
pub async fn serve_until(
    state: AppState,
    admin: SocketAddr,
    handset: Option<SocketAddr>,
    shutdown: CancellationToken,
) -> Result<(), std::io::Error> {
    let listener = TcpListener::bind(admin).await?;
    if let Some(addr) = handset {
        let handset_state = state.clone();
        let handset_stop = shutdown.clone();
        tokio::spawn(async move {
            if let Err(e) = run_handset(handset_state, addr, handset_stop).await {
                warn!(%addr, error = %e, "handset bind failed; admin stays up");
            }
        });
    }

    info!(addr = %admin, "http listening");
    let app = router(state);
    let stop = shutdown.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move { stop.cancelled().await })
        .await
}

/// `HANDSET_BIND`. Empty is off. Unparseable, `0.0.0.0`, `::`, or the admin
/// address is skipped.
pub fn parse_handset_bind(raw: &str, admin: SocketAddr) -> Option<SocketAddr> {
    parse_labeled_addr("HANDSET_BIND", raw, admin)
}

/// `HANDSET_ADVERTISE`. Same rules as the bind: a specified host:port that is
/// not the admin listener. Pair codes read this only after the socket is up.
pub fn parse_handset_advertise(raw: &str, admin: SocketAddr) -> Option<SocketAddr> {
    parse_labeled_addr("HANDSET_ADVERTISE", raw, admin)
}

fn parse_labeled_addr(name: &str, raw: &str, admin: SocketAddr) -> Option<SocketAddr> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let addr: SocketAddr = match raw.parse() {
        Ok(addr) => addr,
        Err(_) => {
            warn!(raw, var = name, "handset address did not parse");
            return None;
        }
    };
    if addr.ip().is_unspecified() {
        warn!(%addr, var = name, "handset address is unspecified");
        return None;
    }
    if addr == admin {
        warn!(%addr, var = name, "handset address matches the admin bind");
        return None;
    }
    Some(addr)
}

fn handset_router(state: AppState) -> Router {
    let json_routes = Router::new()
        .route("/v1/handset/health", get(handset_health))
        .route("/v1/handset/me", get(handset_me))
        .route("/v1/handset/pair", post(handset_pair::redeem))
        .route("/v1/handset/revoke", post(handset_pair::revoke_self))
        .route("/v1/handset/turn", post(handset_turn::turn))
        .route("/v1/handset/verb", post(handset_verb::verb))
        .route("/v1/handset/now", get(handset_verb::now))
        .layer(DefaultBodyLimit::max(64 * 1024));
    let utterance = Router::new()
        .route("/v1/handset/utterance", post(handset_utterance::utterance))
        .layer(DefaultBodyLimit::max(960_000));
    json_routes
        .merge(utterance)
        .layer(security_headers())
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static("frame-ancestors 'none'"),
        ))
        .with_state(state)
}

async fn handset_health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

async fn handset_me(user: handset_auth::HandsetUser) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "deviceId": user.id,
        "label": user.label,
    }))
}

async fn run_handset(
    state: AppState,
    addr: SocketAddr,
    shutdown: CancellationToken,
) -> Result<(), std::io::Error> {
    let listener = TcpListener::bind(addr).await?;
    state.handset_bound.store(true, Ordering::SeqCst);
    info!(%addr, "handset listening");
    let svc = handset_router(state).into_make_service_with_connect_info::<SocketAddr>();
    axum::serve(listener, svc)
        .with_graceful_shutdown(async move { shutdown.cancelled().await })
        .await
}

pub async fn wait_for_shutdown_signal() {
    shutdown_signal().await;
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut s) = signal(SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = term => {}
    }
    info!("shutdown signal");
}

/// Cookie helper used by session handlers.
pub(crate) fn set_session_cookie(
    mut res: axum::http::Response<axum::body::Body>,
    token: &str,
    secure: bool,
) -> axum::http::Response<axum::body::Body> {
    let mut v = format!(
        "{SESSION_COOKIE_NAME}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={}",
        mp_db::SESSION_TTL_MS / 1000
    );
    if secure {
        v.push_str("; Secure");
    }
    if let Ok(hv) = HeaderValue::from_str(&v) {
        res.headers_mut().append(header::SET_COOKIE, hv);
    }
    res
}

pub(crate) fn clear_session_cookie(
    mut res: axum::http::Response<axum::body::Body>,
) -> axum::http::Response<axum::body::Body> {
    let v = format!("{SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    if let Ok(hv) = HeaderValue::from_str(&v) {
        res.headers_mut().append(header::SET_COOKIE, hv);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Request, StatusCode};
    use axum::response::IntoResponse;
    use base64::Engine;
    use tower::ServiceExt;

    fn test_app() -> Router {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let cfg = Arc::new(BotConfig::default());
        router(AppState::new(db, cfg, None))
    }

    #[test]
    fn handset_bind_skips_unset_unspecified_and_admin() {
        let admin: SocketAddr = "127.0.0.1:3000".parse().unwrap();
        assert!(parse_handset_bind("", admin).is_none());
        assert!(parse_handset_bind("   ", admin).is_none());
        assert!(parse_handset_bind("not-an-address", admin).is_none());
        assert!(parse_handset_bind("0.0.0.0:3001", admin).is_none());
        assert!(parse_handset_bind("[::]:3001", admin).is_none());
        assert!(parse_handset_bind("127.0.0.1:3000", admin).is_none());
        assert_eq!(
            parse_handset_bind("192.168.1.250:3001", admin),
            Some("192.168.1.250:3001".parse().unwrap())
        );
    }

    #[tokio::test]
    async fn handset_router_is_health_only() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let state = AppState::new(db, Arc::new(BotConfig::default()), None);
        assert!(!state.handset_bound.load(Ordering::SeqCst));
        let app = handset_router(state);
        let health = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/handset/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);
        let settings = app
            .oneshot(
                Request::builder()
                    .uri("/api/bot/settings")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(settings.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn handset_bind_failure_leaves_the_flag_clear() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let state = AppState::new(db, Arc::new(BotConfig::default()), None);
        let held = TcpListener::bind("127.0.0.1:0".parse::<SocketAddr>().unwrap())
            .await
            .unwrap();
        let occupied = held.local_addr().unwrap();
        let err = run_handset(state.clone(), occupied, CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AddrInUse);
        assert!(!state.handset_bound.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn handset_listener_serves_health_on_loopback() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let state = AppState::new(db, Arc::new(BotConfig::default()), None);
        let shutdown = CancellationToken::new();
        let listener = TcpListener::bind("127.0.0.1:0".parse::<SocketAddr>().unwrap())
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let stop = shutdown.clone();
        let serve_state = state.clone();
        let task = tokio::spawn(async move { run_handset(serve_state, addr, stop).await });
        let mut ok = false;
        for _ in 0..50 {
            if let Ok(mut sock) = tokio::net::TcpStream::connect(addr).await {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let req = "GET /v1/handset/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
                sock.write_all(req.as_bytes()).await.unwrap();
                let mut buf = Vec::new();
                sock.read_to_end(&mut buf).await.unwrap();
                let text = String::from_utf8_lossy(&buf);
                assert!(text.starts_with("HTTP/1.1 200"));
                assert!(text.contains("\"ok\":true"));
                ok = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(ok);
        assert!(state.handset_bound.load(Ordering::SeqCst));
        shutdown.cancel();
        let _ = task.await;
    }

    #[tokio::test]
    async fn handset_me_accepts_only_a_device_bearer() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let state = AppState::new(Arc::clone(&db), Arc::new(BotConfig::default()), None);
        let (token, device) = db.handsets().mint_device("pixel").unwrap();
        let handset = handset_router(state.clone());
        let (admin, cookie) = setup_cookie(router(state)).await;

        let missing = handset
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/handset/me")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);

        let cookie_only = handset
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/handset/me")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cookie_only.status(), StatusCode::UNAUTHORIZED);

        for bearer in [
            "test-ingest-token-please",
            "test-mcp-token",
            cookie.split('=').nth(1).unwrap_or(""),
            "mpd_not-a-real-device",
        ] {
            let res = handset
                .clone()
                .oneshot(
                    Request::builder()
                        .uri("/v1/handset/me")
                        .header("authorization", format!("Bearer {bearer}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "{bearer}");
        }

        let ok = handset
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/handset/me")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ok.status(), StatusCode::OK);
        let body = json_body(ok).await;
        assert_eq!(body["deviceId"], device.id);
        assert_eq!(body["label"], "pixel");

        db.handsets().revoke(&device.id).unwrap();
        let revoked = handset
            .oneshot(
                Request::builder()
                    .uri("/v1/handset/me")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);

        let turn = admin
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/turn")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::from(r#"{"text":"hello"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(turn.status(), StatusCode::UNAUTHORIZED);

        let settings = admin
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bot/settings")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(settings.status(), StatusCode::UNAUTHORIZED);
    }

    fn pair_code_rows(db: &Database) -> i64 {
        db.with_conn(|conn| {
            let n = conn.query_row("SELECT COUNT(*) FROM handset_pair_codes", [], |r| r.get(0))?;
            Ok(n)
        })
        .unwrap()
    }

    fn active_handsets(db: &Database) -> usize {
        db.handsets()
            .list()
            .unwrap()
            .into_iter()
            .filter(|d| d.revoked_at.is_none())
            .count()
    }

    async fn post_pair(app: &Router, peer: &str, body: &str) -> axum::response::Response {
        let mut req = Request::builder()
            .method("POST")
            .uri("/v1/handset/pair")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        req.extensions_mut()
            .insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
        app.clone().oneshot(req).await.unwrap()
    }

    async fn expect_handset_disabled(app: &Router, cookie: &str) {
        let res = app
            .clone()
            .oneshot(authed("POST", "/api/handset/pair-codes", cookie, None))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CONFLICT);
        let body = json_body(res).await;
        assert_eq!(body["error"], "handset listener disabled");
        assert_eq!(body["code"], "HANDSET_DISABLED");
        assert!(body.get("qrPayload").is_none());
    }

    struct AdvertiseGuard {
        prev: Option<String>,
    }

    impl AdvertiseGuard {
        fn install() -> Self {
            Self {
                prev: std::env::var("HANDSET_ADVERTISE").ok(),
            }
        }

        fn set(&self, value: Option<&str>) {
            unsafe {
                match value {
                    Some(v) => std::env::set_var("HANDSET_ADVERTISE", v),
                    None => std::env::remove_var("HANDSET_ADVERTISE"),
                }
            }
        }
    }

    impl Drop for AdvertiseGuard {
        fn drop(&mut self) {
            unsafe {
                match self.prev.as_deref() {
                    Some(v) => std::env::set_var("HANDSET_ADVERTISE", v),
                    None => std::env::remove_var("HANDSET_ADVERTISE"),
                }
            }
        }
    }

    #[tokio::test]
    async fn handset_pair_codes_reject_a_missing_origin() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let state = AppState::new(Arc::clone(&db), Arc::new(BotConfig::default()), None);
        state.handset_bound.store(true, Ordering::SeqCst);
        let (app, cookie) = setup_cookie(router(state)).await;
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/handset/pair-codes")
                    .header("host", "localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        assert_eq!(json_body(res).await["error"], "bad origin");
        assert_eq!(pair_code_rows(&db), 0);
    }

    #[tokio::test]
    async fn handset_pair_issue_redeem_revoke_and_cap() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let state = AppState::new(Arc::clone(&db), Arc::new(BotConfig::default()), None);
        let admin_addr = state.read_config().bind_addr();
        assert_ne!(admin_addr, "192.168.1.250:3001");
        let handset = handset_router(state.clone());
        let (admin, cookie) = setup_cookie(router(state.clone())).await;
        let advertise = AdvertiseGuard::install();

        let health = handset
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/handset/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);
        assert_eq!(json_body(health).await["ok"], true);

        let hidden = handset
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/handset/pair-codes")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(hidden.status(), StatusCode::NOT_FOUND);

        let anonymous = admin
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/handset/devices")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(json_body(anonymous).await["error"], "unauthenticated");

        advertise.set(Some("192.168.1.250:3001"));
        expect_handset_disabled(&admin, &cookie).await;
        assert_eq!(pair_code_rows(&db), 0);

        state.handset_bound.store(true, Ordering::SeqCst);
        for raw in [
            None,
            Some("not-an-address"),
            Some("0.0.0.0:3001"),
            Some("[::]:3001"),
            Some(admin_addr.as_str()),
        ] {
            advertise.set(raw);
            expect_handset_disabled(&admin, &cookie).await;
            assert_eq!(pair_code_rows(&db), 0);
        }

        advertise.set(Some("192.168.1.250:3001"));
        let minted = admin
            .clone()
            .oneshot(authed("POST", "/api/handset/pair-codes", &cookie, None))
            .await
            .unwrap();
        assert_eq!(minted.status(), StatusCode::CREATED);
        let minted_body = json_body(minted).await;
        let code = minted_body["code"].as_str().unwrap().to_string();
        assert!(is_display_code(&code), "{code}");
        assert_eq!(
            minted_body["qrPayload"],
            format!("moneypenny://pair?v=1&host=192.168.1.250&port=3001&code={code}")
        );
        assert_eq!(minted_body["advertise"], "192.168.1.250:3001");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let expires_at = minted_body["expiresAt"].as_i64().unwrap();
        assert!(expires_at >= now + mp_db::HANDSET_PAIR_TTL_MS - 5_000);
        assert!(expires_at <= now + mp_db::HANDSET_PAIR_TTL_MS + 5_000);
        assert_eq!(pair_code_rows(&db), 1);

        let joined = post_pair(
            &handset,
            "192.0.2.10:4000",
            &serde_json::json!({"code": code.to_ascii_lowercase(), "label": "  pixel  "})
                .to_string(),
        )
        .await;
        assert_eq!(joined.status(), StatusCode::CREATED);
        let joined_body = json_body(joined).await;
        let token = joined_body["token"].as_str().unwrap().to_string();
        let device_id = joined_body["deviceId"].as_str().unwrap().to_string();
        assert!(token.starts_with("mpd_"));
        assert_eq!(device_id.len(), 36);
        assert_eq!(joined_body["label"], "pixel");

        let again = post_pair(
            &handset,
            "192.0.2.10:4001",
            &serde_json::json!({"code": code, "label": "pixel"}).to_string(),
        )
        .await;
        assert_eq!(again.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(json_body(again).await["error"], "invalid code");

        let me = device_call(&handset, "GET", "/v1/handset/me", &token).await;
        assert_eq!(me.status(), StatusCode::OK);
        let me_body = json_body(me).await;
        assert_eq!(me_body["deviceId"], device_id);
        assert_eq!(me_body["label"], "pixel");

        let listed = admin
            .clone()
            .oneshot(authed("GET", "/api/handset/devices", &cookie, None))
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let listed_body = json_body(listed).await;
        let listed_text = listed_body.to_string();
        assert!(!listed_text.contains("mpd_"));
        assert!(!listed_text.contains(&token));
        let row = listed_body["devices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["id"] == device_id)
            .unwrap();
        assert_eq!(row["label"], "pixel");
        assert!(row["createdAt"].is_number());
        assert!(row["lastSeenAt"].is_number());
        assert!(row["revokedAt"].is_null());
        assert!(row.get("token").is_none());

        let revoked = device_call(&handset, "POST", "/v1/handset/revoke", &token).await;
        assert_eq!(revoked.status(), StatusCode::NO_CONTENT);
        let revoked_again = device_call(&handset, "POST", "/v1/handset/revoke", &token).await;
        assert_eq!(revoked_again.status(), StatusCode::UNAUTHORIZED);
        let me_gone = device_call(&handset, "GET", "/v1/handset/me", &token).await;
        assert_eq!(me_gone.status(), StatusCode::UNAUTHORIZED);

        let after = admin
            .clone()
            .oneshot(authed("GET", "/api/handset/devices", &cookie, None))
            .await
            .unwrap();
        let after_body = json_body(after).await;
        let after_row = after_body["devices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["id"] == device_id)
            .unwrap();
        assert!(after_row["revokedAt"].is_number());
        assert!(!after_body.to_string().contains(&token));

        let missing = admin
            .clone()
            .oneshot(authed(
                "DELETE",
                "/api/handset/devices/00000000-0000-0000-0000-000000000000",
                &cookie,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        let delete_uri = format!("/api/handset/devices/{device_id}");
        for _ in 0..2 {
            let gone = admin
                .clone()
                .oneshot(authed("DELETE", &delete_uri, &cookie, None))
                .await
                .unwrap();
            assert_eq!(gone.status(), StatusCode::NO_CONTENT);
        }

        let label_code = admin
            .clone()
            .oneshot(authed("POST", "/api/handset/pair-codes", &cookie, None))
            .await
            .unwrap();
        assert_eq!(label_code.status(), StatusCode::CREATED);
        let label_code = json_body(label_code).await["code"]
            .as_str()
            .unwrap()
            .to_string();
        let label40 = "abcdefghijklmnopqrstuvwxyz0123456789ABCD";
        assert_eq!(label40.chars().count(), 40);
        let rejects = [
            serde_json::json!({"code": label_code, "label": "   "}).to_string(),
            serde_json::json!({"code": label_code, "label": format!("{label40}E")}).to_string(),
            format!(r#"{{"code":"{label_code}","label":"pixel","extra":true}}"#),
            serde_json::json!({"code": "----", "label": "pixel"}).to_string(),
            "{".to_string(),
        ];
        for body in &rejects {
            let res = post_pair(&handset, "192.0.2.11:9", body).await;
            assert_eq!(res.status(), StatusCode::BAD_REQUEST, "{body}");
            assert_eq!(json_body(res).await["error"], "invalid request");
        }
        let kept = post_pair(
            &handset,
            "192.0.2.12:9",
            &serde_json::json!({"code": label_code, "label": label40}).to_string(),
        )
        .await;
        assert_eq!(kept.status(), StatusCode::CREATED);
        let kept_body = json_body(kept).await;
        assert_eq!(kept_body["label"], label40);
        let kept_id = kept_body["deviceId"].as_str().unwrap();
        let kept_uri = format!("/api/handset/devices/{kept_id}");
        let cleared = admin
            .clone()
            .oneshot(authed("DELETE", &kept_uri, &cookie, None))
            .await
            .unwrap();
        assert_eq!(cleared.status(), StatusCode::NO_CONTENT);
        assert_eq!(active_handsets(&db), 0);

        let (expired, _) = db.handsets().mint_pair_code_at(0).unwrap();
        let late = post_pair(
            &handset,
            "192.0.2.14:9",
            &serde_json::json!({"code": expired, "label": "late"}).to_string(),
        )
        .await;
        assert_eq!(late.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(json_body(late).await["error"], "invalid code");
        assert_eq!(active_handsets(&db), 0);

        let (held, _) = db.handsets().mint_pair_code().unwrap();
        let rows_at_cap = pair_code_rows(&db);
        for i in 0..mp_db::MAX_HANDSET_DEVICES {
            db.handsets().mint_device(&format!("full{i}")).unwrap();
        }
        assert_eq!(active_handsets(&db), 8);
        let capped = admin
            .clone()
            .oneshot(authed("POST", "/api/handset/pair-codes", &cookie, None))
            .await
            .unwrap();
        assert_eq!(capped.status(), StatusCode::CONFLICT);
        let capped_body = json_body(capped).await;
        assert_eq!(capped_body["error"], "too many devices");
        assert_eq!(capped_body["code"], "DEVICE_CAP");
        assert!(capped_body.get("qrPayload").is_none());
        assert_eq!(pair_code_rows(&db), rows_at_cap);

        let held_body =
            serde_json::json!({"code": held.to_ascii_lowercase(), "label": "pixel"}).to_string();
        let raced = post_pair(&handset, "192.0.2.15:1", &held_body).await;
        assert_eq!(raced.status(), StatusCode::CONFLICT);
        let raced_body = json_body(raced).await;
        assert_eq!(raced_body["error"], "too many devices");
        assert_eq!(raced_body["code"], "DEVICE_CAP");
        assert_eq!(active_handsets(&db), 8);

        let victim = db
            .handsets()
            .list()
            .unwrap()
            .into_iter()
            .find(|d| d.revoked_at.is_none())
            .unwrap();
        let opened = admin
            .clone()
            .oneshot(authed(
                "DELETE",
                &format!("/api/handset/devices/{}", victim.id),
                &cookie,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(opened.status(), StatusCode::NO_CONTENT);

        let slipped = post_pair(&handset, "192.0.2.15:2", &held_body).await;
        assert_eq!(slipped.status(), StatusCode::CREATED);
        let slipped_body = json_body(slipped).await;
        assert!(slipped_body["token"].as_str().unwrap().starts_with("mpd_"));
        assert_eq!(slipped_body["label"], "pixel");
        let spent = post_pair(&handset, "192.0.2.15:3", &held_body).await;
        assert_eq!(spent.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(json_body(spent).await["error"], "invalid code");
    }

    #[tokio::test]
    async fn handset_pair_rate_limits_by_peer_ip() {
        let state = AppState::new(
            Arc::new(Database::open_in_memory().unwrap()),
            Arc::new(BotConfig::default()),
            None,
        );
        let app = handset_router(state);
        let body = r#"{"code":"AAAAAAAA","label":"pixel"}"#;
        for n in 1..=5 {
            let res = post_pair(&app, "192.0.2.1:1", body).await;
            assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "attempt {n}");
            assert_eq!(json_body(res).await["error"], "invalid code");
        }
        for peer in ["192.0.2.1:1", "192.0.2.1:2"] {
            let res = post_pair(&app, peer, body).await;
            assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS, "{peer}");
            let retry = res
                .headers()
                .get(header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            assert!(retry.parse::<u64>().unwrap_or(0) >= 1, "{retry}");
            let limited = json_body(res).await;
            assert_eq!(limited["error"], "too many requests");
            assert_eq!(limited["code"], "RATE_LIMITED");
        }
        let other = post_pair(&app, "192.0.2.2:1", body).await;
        assert_eq!(other.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(json_body(other).await["error"], "invalid code");
    }

    fn mint_handset(state: &AppState) -> (String, String) {
        let (token, device) = state.db.handsets().mint_device("pixel").unwrap();
        (token, device.id)
    }

    async fn post_turn(app: &Router, token: &str, body: &str) -> axum::response::Response {
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/handset/turn")
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn post_verb(app: &Router, token: &str, body: &str) -> axum::response::Response {
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/handset/verb")
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn get_now(app: &Router, token: &str) -> axum::response::Response {
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/handset/now")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn post_pcm(
        app: &Router,
        token: Option<&str>,
        id: Option<&str>,
        rate: &str,
        channels: &str,
        content_type: Option<&str>,
        pcm: Vec<u8>,
    ) -> axum::response::Response {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/v1/handset/utterance");
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        if let Some(id) = id {
            builder = builder.header("x-client-turn-id", id);
        }
        if let Some(content_type) = content_type {
            builder = builder.header("content-type", content_type);
        }
        builder = builder
            .header("x-sample-rate", rate)
            .header("x-channels", channels);
        app.clone()
            .oneshot(builder.body(Body::from(pcm)).unwrap())
            .await
            .unwrap()
    }

    fn pcm_clip(n: usize) -> Vec<u8> {
        vec![0; n]
    }

    fn pcm_wav(rate: u32) -> Vec<u8> {
        let data = [0u8; 8];
        let mut out = Vec::with_capacity(44 + data.len());
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * 2).to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&data);
        out
    }

    #[derive(Clone)]
    struct VoiceStub {
        asr_status: Arc<std::sync::atomic::AtomicU16>,
        asr_text: Arc<std::sync::Mutex<String>>,
        asr_delay_ms: Arc<std::sync::atomic::AtomicU64>,
        asr_hits: Arc<std::sync::atomic::AtomicUsize>,
        saw_profile: Arc<std::sync::atomic::AtomicBool>,
        tts_status: Arc<std::sync::atomic::AtomicU16>,
        tts_hits: Arc<std::sync::atomic::AtomicUsize>,
        last_tts: Arc<std::sync::Mutex<String>>,
        last_voice: Arc<std::sync::Mutex<String>>,
        base: String,
    }

    impl VoiceStub {
        async fn start() -> Self {
            let stub = Self {
                asr_status: Arc::new(std::sync::atomic::AtomicU16::new(200)),
                asr_text: Arc::new(std::sync::Mutex::new(String::new())),
                asr_delay_ms: Arc::new(std::sync::atomic::AtomicU64::new(0)),
                asr_hits: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                saw_profile: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                tts_status: Arc::new(std::sync::atomic::AtomicU16::new(200)),
                tts_hits: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                last_tts: Arc::new(std::sync::Mutex::new(String::new())),
                last_voice: Arc::new(std::sync::Mutex::new(String::new())),
                base: String::new(),
            };
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let app = Router::new()
                .route("/asr", post(stub_asr))
                .route("/v1/audio/speech", post(stub_tts))
                .with_state(stub.clone());
            tokio::spawn(async move {
                let _ = axum::serve(listener, app).await;
            });
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            Self {
                base: format!("http://{addr}"),
                ..stub
            }
        }

        fn hits(&self) -> usize {
            self.asr_hits.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn tts_hits(&self) -> usize {
            self.tts_hits.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn spoke(&self) -> String {
            self.last_tts.lock().expect("tts").clone()
        }

        fn voice_name(&self) -> String {
            self.last_voice.lock().expect("voice").clone()
        }

        fn set_text(&self, text: &str) {
            *self.asr_text.lock().expect("asr") = text.to_string();
        }
    }

    async fn post_clip(
        app: &Router,
        token: &str,
        id: &str,
        pcm: Vec<u8>,
    ) -> axum::response::Response {
        post_pcm(
            app,
            Some(token),
            Some(id),
            "16000",
            "1",
            Some("application/octet-stream"),
            pcm,
        )
        .await
    }

    fn silence_json(id: &str) -> serde_json::Value {
        serde_json::json!({
            "transcript": "",
            "turnId": null,
            "clientTurnId": id,
            "replyText": "",
            "disposedTools": [],
            "audio": null,
            "error": null,
        })
    }

    fn assert_wav(audio: &serde_json::Value, rate: u32) {
        assert_eq!(audio["contentType"], "audio/wav");
        assert_eq!(audio["sampleRateHz"].as_u64(), Some(u64::from(rate)));
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(audio["wavBase64"].as_str().expect("wav"))
            .expect("wav base64");
        assert!(bytes.starts_with(b"RIFF"));
        assert!(bytes.len() >= 28);
        let parsed = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]);
        assert_eq!(parsed, rate);
    }

    fn attach_voice(mut state: AppState, base: &str) -> AppState {
        let mut cfg = state.read_config().clone();
        cfg.voice.stt_url = base.to_string();
        cfg.voice.tts_url = base.to_string();
        state.config = Arc::new(std::sync::RwLock::new(cfg));
        state
    }

    async fn stub_asr(
        axum::extract::State(stub): axum::extract::State<VoiceStub>,
        headers: axum::http::HeaderMap,
        _body: axum::body::Bytes,
    ) -> axum::response::Response {
        stub.asr_hits
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if headers.get("x-stt-profile").is_some() {
            stub.saw_profile
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        let delay = stub.asr_delay_ms.load(std::sync::atomic::Ordering::SeqCst);
        if delay > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }
        let status = stub.asr_status.load(std::sync::atomic::Ordering::SeqCst);
        let text = stub.asr_text.lock().expect("asr").clone();
        (
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(serde_json::json!({ "text": text })),
        )
            .into_response()
    }

    async fn stub_tts(
        axum::extract::State(stub): axum::extract::State<VoiceStub>,
        body: axum::body::Bytes,
    ) -> axum::response::Response {
        stub.tts_hits
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&body) {
            if let Some(input) = v.get("input").and_then(|s| s.as_str()) {
                *stub.last_tts.lock().expect("tts") = input.to_string();
            }
            if let Some(voice) = v.get("voice").and_then(|s| s.as_str()) {
                *stub.last_voice.lock().expect("voice") = voice.to_string();
            }
        }
        let status = stub.tts_status.load(std::sync::atomic::Ordering::SeqCst);
        if status != 200 {
            return (
                StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                "no",
            )
                .into_response();
        }
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "audio/wav")],
            pcm_wav(22050),
        )
            .into_response()
    }

    fn tool_names(tools: &[serde_json::Value]) -> Vec<String> {
        let mut names: Vec<String> = tools
            .iter()
            .filter_map(|tool| tool["function"]["name"].as_str().map(str::to_string))
            .collect();
        names.sort();
        names
    }

    fn intent_call(name: &str, arguments: serde_json::Value) -> mp_brain::IntentToolCall {
        mp_brain::IntentToolCall {
            id: "call-1".into(),
            name: name.into(),
            arguments,
        }
    }

    fn state_changes(ws: &mut tokio::sync::broadcast::Receiver<serde_json::Value>) -> usize {
        let mut n = 0;
        loop {
            match ws.try_recv() {
                Ok(msg) if msg.get("type").and_then(|t| t.as_str()) == Some("stateChange") => {
                    n += 1
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        n
    }

    async fn wait_until_busy(flight: &Arc<tokio::sync::Mutex<()>>) {
        let start = std::time::Instant::now();
        loop {
            match Arc::clone(flight).try_lock_owned() {
                Ok(guard) => drop(guard),
                Err(_) => return,
            }
            if start.elapsed() > std::time::Duration::from_secs(2) {
                panic!("flight never taken");
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    async fn wait_row(
        turns: &handset_turn::HandsetTurns,
        device: &str,
        id: &str,
    ) -> serde_json::Value {
        let start = std::time::Instant::now();
        loop {
            if let Some((_, body)) = turns.lookup(device, id) {
                return body;
            }
            if start.elapsed() > std::time::Duration::from_secs(2) {
                panic!("stored turn missing");
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    fn counting_brain(
        calls: &Arc<std::sync::atomic::AtomicUsize>,
    ) -> (mp_brain::ScriptedLlm, Arc<mp_brain::BrainRuntime>) {
        let calls = Arc::clone(calls);
        let scripted = mp_brain::ScriptedLlm::with_intent_tools(
            |_| "ask".into(),
            move |q, _tools| {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                mp_brain::IntentResult {
                    content: Some(format!("ok:{q}")),
                    tool_calls: Vec::new(),
                }
            },
        );
        let brain = mp_brain::BrainRuntime::in_process(
            mp_brain::InProcessBrain::scripted(scripted.clone())
                .with_id_factory(|| "t-handset".into()),
        );
        (scripted, brain)
    }

    #[tokio::test]
    async fn handset_turn_rejects_bad_bodies() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (_scripted, brain) = counting_brain(&calls);
        let state = AppState::new(
            Arc::new(Database::open_in_memory().unwrap()),
            Arc::new(BotConfig::default()),
            None,
        );
        let turns = Arc::clone(&state.handset_turns);
        let (token, _) = mint_handset(&state);
        let app = handset_router(state.with_brain(brain));

        let huge = "a".repeat(70 * 1024);
        let limited = post_turn(&app, &token, &huge).await;
        assert_eq!(limited.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(turns.len(), 0);

        let open = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/handset/turn")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"text":"hi","spoken":false,"clientTurnId":"a"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(open.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(json_body(open).await["error"], "unauthenticated");

        let wrong = post_turn(
            &app,
            "mp_not_a_device",
            r#"{"text":"hi","spoken":false,"clientTurnId":"a"}"#,
        )
        .await;
        assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);

        let bad = post_turn(&app, &token, "{").await;
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json_body(bad).await["error"], "invalid request");

        let unknown = post_turn(
            &app,
            &token,
            r#"{"text":"hi","spoken":false,"clientTurnId":"a","conversationId":"x"}"#,
        )
        .await;
        assert_eq!(unknown.status(), StatusCode::BAD_REQUEST);
        let unknown_body = json_body(unknown).await;
        assert_eq!(unknown_body["code"], "REJECTED_FIELD");
        assert_eq!(unknown_body["field"], "conversationId");
        assert_eq!(unknown_body["error"], "field not accepted");

        let first_unknown = post_turn(
            &app,
            &token,
            r#"{"text":"hi","spoken":false,"clientTurnId":"a","mode":"intent","channel":"voice"}"#,
        )
        .await;
        let first_body = json_body(first_unknown).await;
        assert_eq!(first_body["field"], "mode");

        let missing_spoken = post_turn(&app, &token, r#"{"text":"hi","clientTurnId":"a"}"#).await;
        let missing_spoken = json_body(missing_spoken).await;
        assert_eq!(missing_spoken["code"], "SPOKEN_REQUIRED");
        assert_eq!(missing_spoken["error"], "spoken must be false");

        let uttered = post_turn(
            &app,
            &token,
            r#"{"text":"hi","spoken":true,"clientTurnId":"a"}"#,
        )
        .await;
        let uttered = json_body(uttered).await;
        assert_eq!(uttered["code"], "USE_UTTERANCE");
        assert_eq!(
            uttered["error"],
            "push-to-talk uses POST /v1/handset/utterance"
        );

        let empty = post_turn(
            &app,
            &token,
            r#"{"text":"","spoken":false,"clientTurnId":"a"}"#,
        )
        .await;
        assert_eq!(json_body(empty).await["code"], "TEXT_REQUIRED");
        let blank = post_turn(
            &app,
            &token,
            r#"{"text":"  \n","spoken":false,"clientTurnId":"a"}"#,
        )
        .await;
        assert_eq!(json_body(blank).await["code"], "TEXT_REQUIRED");
        let missing_text = post_turn(&app, &token, r#"{"spoken":false,"clientTurnId":"a"}"#).await;
        assert_eq!(json_body(missing_text).await["code"], "TEXT_REQUIRED");

        let too_long = serde_json::json!({
            "text": "a".repeat(4001),
            "spoken": false,
            "clientTurnId": "a",
        })
        .to_string();
        let too_long = post_turn(&app, &token, &too_long).await;
        assert_eq!(json_body(too_long).await["code"], "TEXT_TOO_LONG");

        let missing_id = post_turn(&app, &token, r#"{"text":"hi","spoken":false}"#).await;
        assert_eq!(json_body(missing_id).await["code"], "CLIENT_TURN_ID");
        let blank_id = post_turn(
            &app,
            &token,
            r#"{"text":"hi","spoken":false,"clientTurnId":"   "}"#,
        )
        .await;
        assert_eq!(json_body(blank_id).await["code"], "CLIENT_TURN_ID");
        let long_id = serde_json::json!({
            "text": "hi",
            "spoken": false,
            "clientTurnId": "x".repeat(65),
        })
        .to_string();
        let long_id = post_turn(&app, &token, &long_id).await;
        assert_eq!(json_body(long_id).await["code"], "CLIENT_TURN_ID");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(turns.len(), 0);

        let wide = serde_json::json!({
            "text": "é".repeat(4000),
            "spoken": false,
            "clientTurnId": "wide-1",
        })
        .to_string();
        let wide = post_turn(&app, &token, &wide).await;
        assert_eq!(wide.status(), StatusCode::OK);
        let wide_body = json_body(wide).await;
        assert_eq!(wide_body["turnId"], "t-handset");
        assert_eq!(wide_body["clientTurnId"], "wide-1");
        assert!(wide_body["error"].is_null());
        assert!(wide_body["replyText"].as_str().unwrap().starts_with("ok:"));
        assert!(wide_body.get("sources").is_none());
        assert!(wide_body.get("skill").is_none());
        assert!(wide_body.get("toolProposals").is_none());
        assert!(wide_body["disposedTools"].as_array().unwrap().is_empty());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);

        let id64 = "y".repeat(64);
        let ok64 = serde_json::json!({
            "text": "hi",
            "spoken": false,
            "clientTurnId": id64,
        })
        .to_string();
        let ok64 = post_turn(&app, &token, &ok64).await;
        assert_eq!(ok64.status(), StatusCode::OK);
        assert_eq!(json_body(ok64).await["clientTurnId"], id64);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(turns.len(), 2);
    }

    #[tokio::test]
    async fn handset_turn_allowlist_volume_and_broadcast() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let calls2 = Arc::clone(&calls);
        let seen2 = Arc::clone(&seen);
        let scripted = mp_brain::ScriptedLlm::with_intent_tools(
            |_| "ask".into(),
            move |q, tools| {
                calls2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                *seen2.lock().expect("seen") = tool_names(tools);
                let tool_calls = if q == "mix" {
                    vec![
                        intent_call("stop", serde_json::json!({})),
                        intent_call("set_volume", serde_json::json!({ "level": 42 })),
                        intent_call("pause", serde_json::json!({})),
                    ]
                } else if q == "block" {
                    vec![
                        intent_call(
                            "move_client",
                            serde_json::json!({ "client": "a", "channel": "b" }),
                        ),
                        intent_call("select_tracks", serde_json::json!({ "mood": ["calm"] })),
                    ]
                } else {
                    vec![intent_call(
                        "set_volume",
                        serde_json::json!({ "level": 500 }),
                    )]
                };
                mp_brain::IntentResult {
                    content: Some("On it.".into()),
                    tool_calls,
                }
            },
        );
        let (dir, state) = music_state();
        let station = state.station.clone().unwrap();
        let mut ws = state.ws_tx.subscribe();
        let brain = mp_brain::BrainRuntime::in_process(
            mp_brain::InProcessBrain::scripted(scripted).with_id_factory(|| "t-handset".into()),
        );
        let (token, _) = mint_handset(&state);
        let app = handset_router(state.with_brain(brain));

        let mix = post_turn(
            &app,
            &token,
            r#"{"text":"mix","spoken":false,"clientTurnId":"mix-1"}"#,
        )
        .await;
        assert_eq!(mix.status(), StatusCode::OK);
        let mix_body = json_body(mix).await;
        assert!(mix_body["error"].is_null());
        assert_eq!(mix_body["clientTurnId"], "mix-1");
        assert_eq!(mix_body["replyText"], "On it.");
        let disposed = mix_body["disposedTools"].as_array().unwrap();
        assert_eq!(disposed.len(), 2);
        assert_eq!(disposed[0]["name"], "stop");
        assert_eq!(disposed[0]["ok"], true);
        assert_eq!(disposed[0]["result"], "Stopped and queue cleared");
        assert!(disposed[0]["error"].is_null());
        assert!(disposed[0].get("args").is_none());
        assert_eq!(disposed[1]["name"], "set_volume");
        assert_eq!(disposed[1]["result"], "Volume set to 42%");
        assert_eq!(station.player.get_volume(), 42);
        assert!(!disposed.iter().any(|tool| tool["name"] == "pause"));
        assert_eq!(
            seen.lock().expect("seen").as_slice(),
            [
                "now_playing",
                "pause",
                "play_music",
                "queue",
                "resume",
                "set_volume",
                "skip",
                "stop",
            ]
        );
        assert!(
            !seen
                .lock()
                .expect("seen")
                .iter()
                .any(|name| name == "select_tracks")
        );
        assert_eq!(state_changes(&mut ws), 1);

        let blocked = post_turn(
            &app,
            &token,
            r#"{"text":"block","spoken":false,"clientTurnId":"block-1"}"#,
        )
        .await;
        assert_eq!(blocked.status(), StatusCode::OK);
        let blocked_body = json_body(blocked).await;
        let raw = serde_json::to_string(&blocked_body).unwrap();
        assert!(!raw.contains("allowDangerous"), "{raw}");
        for tool in blocked_body["disposedTools"].as_array().unwrap() {
            assert_eq!(tool["error"], "tool not allowed");
            assert_eq!(tool["ok"], false);
            assert!(tool["result"].is_null());
            assert!(tool.get("args").is_none());
        }
        assert_eq!(station.player.get_volume(), 42);
        assert_eq!(state_changes(&mut ws), 0);

        let loud = post_turn(
            &app,
            &token,
            r#"{"text":"loud","spoken":false,"clientTurnId":"loud-1"}"#,
        )
        .await;
        assert_eq!(loud.status(), StatusCode::OK);
        let loud_body = json_body(loud).await;
        let tool = &loud_body["disposedTools"][0];
        assert_eq!(tool["ok"], false);
        assert!(tool["result"].is_null());
        assert_eq!(tool["error"], "bad tool arguments");
        assert_eq!(station.player.get_volume(), 42);
        assert_eq!(state_changes(&mut ws), 1);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 3);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn handset_turn_same_id_does_not_dispose_twice() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls2 = Arc::clone(&calls);
        let scripted = mp_brain::ScriptedLlm::with_intent_tools(
            |_| "ask".into(),
            move |_q, _tools| {
                calls2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                mp_brain::IntentResult {
                    content: Some("Stopping.".into()),
                    tool_calls: vec![intent_call("stop", serde_json::json!({}))],
                }
            },
        );
        let (dir, state) = music_state();
        let brain = mp_brain::BrainRuntime::in_process(
            mp_brain::InProcessBrain::scripted(scripted).with_id_factory(|| "t-handset".into()),
        );
        let (token, _) = mint_handset(&state);
        let app = handset_router(state.with_brain(brain));
        let body = r#"{"text":"stop","spoken":false,"clientTurnId":"once"}"#;
        let first = json_body(post_turn(&app, &token, body).await).await;
        let second = json_body(post_turn(&app, &token, body).await).await;
        assert_eq!(first, second);
        assert_eq!(
            first["disposedTools"][0]["result"],
            "Stopped and queue cleared"
        );
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn handset_turn_deadline_is_not_stored() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (scripted, brain) = counting_brain(&calls);
        scripted.set_intent_delay(1_500);
        let (dir, mut state) = music_state();
        state.handset_deadline = std::time::Duration::from_millis(80);
        let turns = Arc::clone(&state.handset_turns);
        let (token, _) = mint_handset(&state);
        let app = handset_router(state.with_brain(brain));
        let body = r#"{"text":"hi","spoken":false,"clientTurnId":"slow"}"#;
        let late = post_turn(&app, &token, body).await;
        assert_eq!(late.status(), StatusCode::GATEWAY_TIMEOUT);
        let late_body = json_body(late).await;
        assert_eq!(late_body["error"], "handset deadline");
        assert_eq!(late_body["code"], "DEADLINE");
        assert_eq!(late_body["disposed"], false);
        assert_eq!(turns.len(), 0);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        scripted.set_intent_delay(0);
        let again = post_turn(&app, &token, body).await;
        assert_eq!(again.status(), StatusCode::OK);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(turns.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn handset_turn_busy_is_not_stored() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (scripted, brain) = counting_brain(&calls);
        scripted.set_intent_delay(400);
        let (dir, state) = music_state();
        let flight = Arc::clone(&state.handset_flight);
        let turns = Arc::clone(&state.handset_turns);
        let (token, _) = mint_handset(&state);
        let app = handset_router(state.with_brain(brain));
        let app2 = app.clone();
        let token2 = token.clone();
        let first = tokio::spawn(async move {
            post_turn(
                &app2,
                &token2,
                r#"{"text":"hi","spoken":false,"clientTurnId":"a"}"#,
            )
            .await
        });
        wait_until_busy(&flight).await;
        let busy = post_turn(
            &app,
            &token,
            r#"{"text":"hi","spoken":false,"clientTurnId":"b"}"#,
        )
        .await;
        assert_eq!(busy.status(), StatusCode::CONFLICT);
        let busy_body = json_body(busy).await;
        assert_eq!(busy_body["error"], "handset busy");
        assert_eq!(busy_body["code"], "BUSY");
        assert!(busy_body.get("retryAfterMs").is_none());
        assert!(busy_body.get("disposed").is_none());
        let first = first.await.unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(turns.lookup("", "b"), None);
        assert_eq!(turns.len(), 1);
        scripted.set_intent_delay(0);
        let retry = post_turn(
            &app,
            &token,
            r#"{"text":"hi","spoken":false,"clientTurnId":"b"}"#,
        )
        .await;
        assert_eq!(retry.status(), StatusCode::OK);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(turns.len(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn handset_turn_remote_brain_does_not_run() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls2 = Arc::clone(&calls);
        let fetch: mp_brain::FetchFn = Arc::new(move |_url, _body| {
            calls2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async {
                Ok(mp_brain::RawHttp {
                    status: 200,
                    body: b"{}".to_vec(),
                })
            })
        });
        let brain = mp_brain::BrainRuntime::with_transport(mp_brain::BrainTransport::Http(
            mp_brain::HttpBrain::with_fetch("http://127.0.0.1:9", fetch),
        ));
        let state = AppState::new(
            Arc::new(Database::open_in_memory().unwrap()),
            Arc::new(BotConfig::default()),
            None,
        );
        let turns = Arc::clone(&state.handset_turns);
        let (token, _) = mint_handset(&state);
        let app = handset_router(state.with_brain(brain));
        let res = post_turn(
            &app,
            &token,
            r#"{"text":"hi","spoken":false,"clientTurnId":"remote"}"#,
        )
        .await;
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = json_body(res).await;
        assert_eq!(body["error"], "brain is remote");
        assert_eq!(body["code"], "BRAIN_REMOTE");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(turns.len(), 0);
    }

    #[tokio::test]
    async fn handset_turn_llm_disabled_is_not_stored() {
        let state = AppState::new(
            Arc::new(Database::open_in_memory().unwrap()),
            Arc::new(BotConfig::default()),
            None,
        );
        let turns = Arc::clone(&state.handset_turns);
        let (token, _) = mint_handset(&state);
        let app = handset_router(state.with_brain(mp_brain::BrainRuntime::disabled()));
        let body = r#"{"text":"hi","spoken":false,"clientTurnId":"off"}"#;
        let first = post_turn(&app, &token, body).await;
        assert_eq!(first.status(), StatusCode::CONFLICT);
        let first_body = json_body(first).await;
        assert_eq!(first_body["error"], "LLM is not enabled");
        assert_eq!(first_body["code"], "LLM_DISABLED");
        assert_eq!(turns.len(), 0);
        let second = post_turn(&app, &token, body).await;
        assert_eq!(second.status(), StatusCode::CONFLICT);
        assert_eq!(json_body(second).await["code"], "LLM_DISABLED");
        assert_eq!(turns.len(), 0);
    }

    #[tokio::test]
    async fn handset_turn_no_bot_is_not_stored() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls2 = Arc::clone(&calls);
        let scripted = mp_brain::ScriptedLlm::with_intent_tools(
            |_| "ask".into(),
            move |q, _tools| {
                calls2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let tool_calls = if q == "go" {
                    vec![intent_call("pause", serde_json::json!({}))]
                } else {
                    Vec::new()
                };
                mp_brain::IntentResult {
                    content: Some("ok".into()),
                    tool_calls,
                }
            },
        );
        let state = AppState::new(
            Arc::new(Database::open_in_memory().unwrap()),
            Arc::new(BotConfig::default()),
            None,
        );
        let turns = Arc::clone(&state.handset_turns);
        let (token, _) = mint_handset(&state);
        let brain = mp_brain::BrainRuntime::in_process(
            mp_brain::InProcessBrain::scripted(scripted).with_id_factory(|| "t-handset".into()),
        );
        let app = handset_router(state.with_brain(brain));
        let go = r#"{"text":"go","spoken":false,"clientTurnId":"a"}"#;
        let missing = post_turn(&app, &token, go).await;
        assert_eq!(missing.status(), StatusCode::CONFLICT);
        let missing_body = json_body(missing).await;
        assert_eq!(missing_body["error"], "No bot instance available");
        assert_eq!(missing_body["code"], "NO_BOT");
        assert_eq!(turns.len(), 0);
        let again = post_turn(&app, &token, go).await;
        assert_eq!(again.status(), StatusCode::CONFLICT);
        assert_eq!(turns.len(), 0);
        let hello = post_turn(
            &app,
            &token,
            r#"{"text":"hello","spoken":false,"clientTurnId":"b"}"#,
        )
        .await;
        assert_eq!(hello.status(), StatusCode::OK);
        let hello_body = json_body(hello).await;
        assert!(hello_body["disposedTools"].as_array().unwrap().is_empty());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 3);
        assert_eq!(turns.len(), 1);
    }

    #[tokio::test]
    async fn handset_turn_intent_failure_is_not_stored() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls2 = Arc::clone(&calls);
        let mut scripted = mp_brain::ScriptedLlm::ask_only(|_| "ask".into());
        scripted.chat_for_intent_with = Some(Arc::new(move |_q, _tools| {
            calls2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err("boom prompt".into())
        }));
        let state = AppState::new(
            Arc::new(Database::open_in_memory().unwrap()),
            Arc::new(BotConfig::default()),
            None,
        );
        let turns = Arc::clone(&state.handset_turns);
        let (token, _) = mint_handset(&state);
        let brain = mp_brain::BrainRuntime::in_process(
            mp_brain::InProcessBrain::scripted(scripted).with_id_factory(|| "t-handset".into()),
        );
        let app = handset_router(state.with_brain(brain));
        let body = r#"{"text":"hi","spoken":false,"clientTurnId":"bad"}"#;
        let failed = post_turn(&app, &token, body).await;
        assert_eq!(failed.status(), StatusCode::BAD_GATEWAY);
        let failed_body = json_body(failed).await;
        assert_eq!(failed_body["error"], "intent failed");
        assert_eq!(failed_body["code"], "INTENT_FAILED");
        let raw = serde_json::to_string(&failed_body).unwrap();
        assert!(!raw.contains("boom"));
        assert_eq!(turns.len(), 0);
        let again = post_turn(&app, &token, body).await;
        assert_eq!(again.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(turns.len(), 0);
    }

    #[tokio::test]
    async fn handset_turn_dropped_request_still_disposes() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls2 = Arc::clone(&calls);
        let scripted = mp_brain::ScriptedLlm::with_intent_tools(
            |_| "ask".into(),
            move |_q, _tools| {
                calls2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                mp_brain::IntentResult {
                    content: Some("Stopping.".into()),
                    tool_calls: vec![intent_call("stop", serde_json::json!({}))],
                }
            },
        );
        let (dir, mut state) = music_state();
        state.handset_dispose_delay = std::time::Duration::from_millis(300);
        let flight = Arc::clone(&state.handset_flight);
        let turns = Arc::clone(&state.handset_turns);
        let (token, device_id) = mint_handset(&state);
        let brain = mp_brain::BrainRuntime::in_process(
            mp_brain::InProcessBrain::scripted(scripted).with_id_factory(|| "t-handset".into()),
        );
        let app = handset_router(state.with_brain(brain));
        let app2 = app.clone();
        let token2 = token.clone();
        let inflight = tokio::spawn(async move {
            post_turn(
                &app2,
                &token2,
                r#"{"text":"stop","spoken":false,"clientTurnId":"abort-1"}"#,
            )
            .await
        });
        wait_until_busy(&flight).await;
        inflight.abort();
        let stored = wait_row(&turns, &device_id, "abort-1").await;
        assert_eq!(
            stored["disposedTools"][0]["result"],
            "Stopped and queue cleared"
        );
        let again = post_turn(
            &app,
            &token,
            r#"{"text":"stop","spoken":false,"clientTurnId":"abort-1"}"#,
        )
        .await;
        assert_eq!(again.status(), StatusCode::OK);
        assert_eq!(json_body(again).await, stored);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn handset_verb_disconnected_skip_is_stored_and_pause_runs() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (_scripted, brain) = counting_brain(&calls);
        let (dir, state) = music_state();
        let station = state.station.clone().unwrap();
        station.set_connected(false);
        let mut ws = state.ws_tx.subscribe();
        let turns = Arc::clone(&state.handset_turns);
        let (token, device) = mint_handset(&state);
        let app = handset_router(state.with_brain(brain));

        let skip = post_verb(&app, &token, r#"{"name":"skip","clientTurnId":"skip-1"}"#).await;
        assert_eq!(skip.status(), StatusCode::CONFLICT);
        let skip_body = json_body(skip).await;
        assert_eq!(skip_body["name"], "skip");
        assert_eq!(skip_body["clientTurnId"], "skip-1");
        assert_eq!(skip_body["error"], "Bot is not connected to TeamSpeak");
        assert_eq!(skip_body["code"], "NOT_ON_TEAMSPEAK");
        assert!(skip_body.get("ok").is_none());
        assert_eq!(turns.len(), 1);
        assert_eq!(state_changes(&mut ws), 0);

        station.set_connected(true);
        let again = post_verb(&app, &token, r#"{"name":"skip","clientTurnId":"skip-1"}"#).await;
        assert_eq!(again.status(), StatusCode::CONFLICT);
        assert_eq!(json_body(again).await, skip_body);
        assert_eq!(turns.len(), 1);
        assert_eq!(state_changes(&mut ws), 0);

        let now = get_now(&app, &token).await;
        assert_eq!(now.status(), StatusCode::OK);
        let now_body = json_body(now).await;
        assert_eq!(now_body["connected"], true);
        assert!(now_body["current"].is_null());
        assert_eq!(state_changes(&mut ws), 0);

        station.set_connected(false);
        let paused = post_verb(&app, &token, r#"{"name":"pause","clientTurnId":"pause-1"}"#).await;
        assert_eq!(paused.status(), StatusCode::OK);
        let paused_body = json_body(paused).await;
        assert_eq!(paused_body["name"], "pause");
        assert_eq!(paused_body["clientTurnId"], "pause-1");
        assert_eq!(paused_body["ok"], true);
        assert_eq!(paused_body["result"], "Nothing is playing");
        assert!(paused_body.get("error").is_none());
        assert_eq!(turns.lookup(&device, "pause-1").unwrap().0, 200);
        assert_eq!(turns.len(), 2);
        assert_eq!(state_changes(&mut ws), 1);

        let screen = get_now(&app, &token).await;
        assert_eq!(screen.status(), StatusCode::OK);
        let screen = json_body(screen).await;
        assert_eq!(screen["connected"], false);
        assert_eq!(screen["playing"], false);
        assert_eq!(screen["paused"], false);
        assert_eq!(screen["volume"], 30);
        assert_eq!(screen["queueSize"], 0);
        assert!(screen["current"].is_null());
        for banned in ["coverUrl", "id", "source", "playMode", "botId"] {
            assert!(screen.get(banned).is_none(), "{banned}");
        }
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn handset_verb_connected_volume_now_and_rejects() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (_scripted, brain) = counting_brain(&calls);
        let (dir, state) = music_state();
        let station = state.station.clone().unwrap();
        assert!(station.is_connected());
        let mut ws = state.ws_tx.subscribe();
        let turns = Arc::clone(&state.handset_turns);
        let (token, _) = mint_handset(&state);
        let app = handset_router(state.with_brain(brain));

        let health = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/handset/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);
        assert_eq!(json_body(health).await["ok"], true);

        let quiet = post_verb(
            &app,
            &token,
            r#"{"name":"set_volume","clientTurnId":"vol-0","level":0}"#,
        )
        .await;
        assert_eq!(quiet.status(), StatusCode::OK);
        let quiet_body = json_body(quiet).await;
        assert_eq!(quiet_body["ok"], true);
        assert_eq!(quiet_body["result"], "Volume set to 0%");
        assert_eq!(quiet_body["clientTurnId"], "vol-0");
        assert_eq!(station.player.get_volume(), 0);

        let full = post_verb(
            &app,
            &token,
            r#"{"name":"set_volume","clientTurnId":"vol-100","level":100}"#,
        )
        .await;
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(json_body(full).await["result"], "Volume set to 100%");
        assert_eq!(station.player.get_volume(), 100);
        assert_eq!(state_changes(&mut ws), 2);

        let replay = post_verb(
            &app,
            &token,
            r#"{"name":"set_volume","clientTurnId":"vol-0","level":90}"#,
        )
        .await;
        assert_eq!(replay.status(), StatusCode::OK);
        assert_eq!(json_body(replay).await, quiet_body);
        assert_eq!(station.player.get_volume(), 100);

        let before = turns.len();
        for (id, body) in [
            (
                "loud",
                r#"{"name":"set_volume","clientTurnId":"loud","level":500}"#,
            ),
            (
                "neg",
                r#"{"name":"set_volume","clientTurnId":"neg","level":-1}"#,
            ),
            (
                "float",
                r#"{"name":"set_volume","clientTurnId":"float","level":42.5}"#,
            ),
            (
                "word",
                r#"{"name":"set_volume","clientTurnId":"word","level":"30"}"#,
            ),
            ("miss", r#"{"name":"set_volume","clientTurnId":"miss"}"#),
        ] {
            let res = post_verb(&app, &token, body).await;
            assert_eq!(res.status(), StatusCode::BAD_REQUEST, "{id}");
            let bad = json_body(res).await;
            assert_eq!(bad["error"], "level out of range");
            assert_eq!(bad["code"], "BAD_LEVEL");
            let raw = serde_json::to_string(&bad).unwrap();
            assert!(!raw.contains("Usage:"), "{raw}");
            assert!(turns.lookup("", id).is_none());
        }
        assert_eq!(turns.len(), before);
        assert_eq!(station.player.get_volume(), 100);

        for (id, body) in [
            (
                "tracks",
                r#"{"name":"select_tracks","clientTurnId":"tracks"}"#,
            ),
            ("move", r#"{"name":"move_client","clientTurnId":"move"}"#),
            ("nope", r#"{"name":"kick","clientTurnId":"nope"}"#),
        ] {
            let res = post_verb(&app, &token, body).await;
            assert_eq!(res.status(), StatusCode::FORBIDDEN, "{id}");
            assert_eq!(
                json_body(res).await,
                serde_json::json!({"error":"tool not allowed","code":"TOOL_NOT_ALLOWED"})
            );
        }
        assert_eq!(turns.len(), before);

        let played = post_verb(
            &app,
            &token,
            r#"{"name":"play_music","clientTurnId":"play-1","query":"sine","source":"local"}"#,
        )
        .await;
        assert_eq!(played.status(), StatusCode::OK);
        let played_body = json_body(played).await;
        assert_eq!(played_body["name"], "play_music");
        assert_eq!(played_body["ok"], true);
        assert!(
            played_body["result"]
                .as_str()
                .unwrap_or("")
                .starts_with("Now playing"),
            "{}",
            played_body["result"]
        );
        let now = json_body(get_now(&app, &token).await).await;
        assert_eq!(now["connected"], true);
        assert_eq!(now["playing"], true);
        assert_eq!(now["paused"], false);
        assert_eq!(now["volume"], 100);
        assert_eq!(now["queueSize"], 1);
        let current = now["current"].as_object().unwrap();
        assert!(current.get("coverUrl").is_none());
        assert!(current.get("id").is_none());
        assert!(current.get("source").is_none());
        let mut keys: Vec<_> = current.keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["album", "artist", "duration", "name", "platform"]);
        assert_eq!(current["platform"], "local");
        assert!(!current["name"].as_str().unwrap_or("").is_empty());
        for banned in ["coverUrl", "id", "source", "playMode", "botId", "name"] {
            assert!(now.get(banned).is_none(), "{banned}");
        }
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn handset_verb_abort_play_does_not_execute_twice() {
        let (dir, mut state) = music_state();
        state.handset_dispose_delay = std::time::Duration::from_millis(300);
        let station = state.station.clone().unwrap();
        assert!(station.is_connected());
        let mut ws = state.ws_tx.subscribe();
        let flight = Arc::clone(&state.handset_flight);
        let turns = Arc::clone(&state.handset_turns);
        let (token, device) = mint_handset(&state);
        let app = handset_router(state);
        let app2 = app.clone();
        let token2 = token.clone();
        let inflight = tokio::spawn(async move {
            post_verb(
                &app2,
                &token2,
                r#"{"name":"play_music","clientTurnId":"abort-1","query":"sine"}"#,
            )
            .await
        });
        wait_until_busy(&flight).await;
        let during = get_now(&app, &token).await;
        assert_eq!(during.status(), StatusCode::OK);
        assert_eq!(json_body(during).await["connected"], true);
        let other = post_verb(&app, &token, r#"{"name":"pause","clientTurnId":"other"}"#).await;
        assert_eq!(other.status(), StatusCode::CONFLICT);
        let other_body = json_body(other).await;
        assert_eq!(other_body["code"], "BUSY");
        assert_eq!(other_body["error"], "handset busy");
        assert!(other_body.get("retryAfterMs").is_none());
        assert!(turns.lookup(&device, "other").is_none());
        inflight.abort();
        let stored = wait_row(&turns, &device, "abort-1").await;
        assert_eq!(stored["name"], "play_music");
        assert_eq!(stored["ok"], true);
        assert!(
            stored["result"]
                .as_str()
                .unwrap_or("")
                .starts_with("Now playing")
        );
        assert_eq!(station.queue.lock().unwrap().size(), 1);
        assert_eq!(state_changes(&mut ws), 1);
        let again = post_verb(
            &app,
            &token,
            r#"{"name":"play_music","clientTurnId":"abort-1","query":"other song"}"#,
        )
        .await;
        assert_eq!(again.status(), StatusCode::OK);
        assert_eq!(json_body(again).await, stored);
        assert_eq!(station.queue.lock().unwrap().size(), 1);
        assert_eq!(state_changes(&mut ws), 0);
        assert_eq!(turns.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn handset_verb_rejects_bad_bodies_and_missing_station() {
        let state = AppState::new(
            Arc::new(Database::open_in_memory().unwrap()),
            Arc::new(BotConfig::default()),
            None,
        );
        let turns = Arc::clone(&state.handset_turns);
        let (token, device) = mint_handset(&state);
        let app = handset_router(state);

        let open = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/handset/verb")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"pause","clientTurnId":"a"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(open.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(json_body(open).await["error"], "unauthenticated");

        let now_open = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/handset/now")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(now_open.status(), StatusCode::UNAUTHORIZED);

        let now_missing = get_now(&app, &token).await;
        assert_eq!(now_missing.status(), StatusCode::SERVICE_UNAVAILABLE);
        let now_missing = json_body(now_missing).await;
        assert_eq!(now_missing["error"], "No bot instance available");
        assert_eq!(now_missing["code"], "NO_BOT");

        let missing = post_verb(&app, &token, r#"{"name":"pause","clientTurnId":"gone"}"#).await;
        assert_eq!(missing.status(), StatusCode::CONFLICT);
        let missing_body = json_body(missing).await;
        assert_eq!(missing_body["error"], "No bot instance available");
        assert_eq!(missing_body["code"], "NO_BOT");
        assert_eq!(turns.len(), 0);
        let missing_again =
            post_verb(&app, &token, r#"{"name":"pause","clientTurnId":"gone"}"#).await;
        assert_eq!(missing_again.status(), StatusCode::CONFLICT);
        assert_eq!(turns.lookup(&device, "gone"), None);

        let (dir, state) = music_state();
        let turns = Arc::clone(&state.handset_turns);
        let (token, _) = mint_handset(&state);
        let app = handset_router(state);

        let huge = "a".repeat(70 * 1024);
        let limited = post_verb(&app, &token, &huge).await;
        assert_eq!(limited.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(turns.len(), 0);

        let broken = post_verb(&app, &token, "{").await;
        assert_eq!(broken.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json_body(broken).await["error"], "invalid request");

        let dry = post_verb(
            &app,
            &token,
            r#"{"name":"pause","clientTurnId":"a","dryRun":true}"#,
        )
        .await;
        assert_eq!(dry.status(), StatusCode::BAD_REQUEST);
        let dry_body = json_body(dry).await;
        assert_eq!(dry_body["code"], "REJECTED_FIELD");
        assert_eq!(dry_body["field"], "dryRun");
        assert_eq!(dry_body["error"], "field not accepted");

        let extra = post_verb(
            &app,
            &token,
            r#"{"name":"pause","clientTurnId":"a","query":"sine"}"#,
        )
        .await;
        assert_eq!(json_body(extra).await["field"], "query");

        let sourced = post_verb(
            &app,
            &token,
            r#"{"name":"queue","clientTurnId":"a","query":"sine","source":"local"}"#,
        )
        .await;
        assert_eq!(json_body(sourced).await["field"], "source");

        let blank_id = post_verb(&app, &token, r#"{"name":"pause","clientTurnId":"   "}"#).await;
        assert_eq!(json_body(blank_id).await["code"], "CLIENT_TURN_ID");
        let long_id = serde_json::json!({
            "name": "pause",
            "clientTurnId": "x".repeat(65),
        })
        .to_string();
        let long_id = post_verb(&app, &token, &long_id).await;
        assert_eq!(json_body(long_id).await["code"], "CLIENT_TURN_ID");

        let empty_q = post_verb(
            &app,
            &token,
            r#"{"name":"play_music","clientTurnId":"q","query":"  "}"#,
        )
        .await;
        assert_eq!(json_body(empty_q).await["code"], "QUERY_REQUIRED");
        let long_q = serde_json::json!({
            "name": "play_music",
            "clientTurnId": "q2",
            "query": "é".repeat(201),
        })
        .to_string();
        let long_q = post_verb(&app, &token, &long_q).await;
        assert_eq!(json_body(long_q).await["code"], "QUERY_TOO_LONG");
        let bad_source = post_verb(
            &app,
            &token,
            r#"{"name":"play_music","clientTurnId":"src","query":"sine","source":"stream"}"#,
        )
        .await;
        assert_eq!(json_body(bad_source).await["code"], "BAD_SOURCE");
        assert_eq!(turns.len(), 0);

        let queued = post_verb(
            &app,
            &token,
            r#"{"name":"queue","clientTurnId":"add-1","query":"sine"}"#,
        )
        .await;
        assert_eq!(queued.status(), StatusCode::OK);
        let queued_body = json_body(queued).await;
        assert_eq!(queued_body["name"], "queue");
        assert_eq!(queued_body["ok"], true);
        assert!(
            queued_body["result"]
                .as_str()
                .unwrap_or("")
                .starts_with("Now playing")
        );
        assert_eq!(turns.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn loads(calls: &std::sync::atomic::AtomicUsize) -> usize {
        calls.load(std::sync::atomic::Ordering::SeqCst)
    }

    #[tokio::test]
    async fn handset_utterance_headers_silence_and_stt_failure() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (_scripted, brain) = counting_brain(&calls);
        let voice = VoiceStub::start().await;
        let state = AppState::new(
            Arc::new(Database::open_in_memory().unwrap()),
            Arc::new(BotConfig::default()),
            None,
        );
        let state = attach_voice(state, &voice.base);
        let cfg = Arc::clone(&state.config);
        let turns = Arc::clone(&state.handset_turns);
        let (token, device) = mint_handset(&state);
        let app = handset_router(state.with_brain(brain));

        let health = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/handset/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);
        assert_eq!(json_body(health).await, serde_json::json!({ "ok": true }));

        let open = post_pcm(
            &app,
            None,
            Some("a"),
            "16000",
            "1",
            Some("application/octet-stream"),
            pcm_clip(3200),
        )
        .await;
        assert_eq!(open.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(json_body(open).await["error"], "unauthenticated");
        let wrong = post_pcm(
            &app,
            Some("mp_not_a_device"),
            Some("a"),
            "16000",
            "1",
            Some("application/octet-stream"),
            pcm_clip(3200),
        )
        .await;
        assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);

        let short = post_clip(&app, &token, "short", pcm_clip(3199)).await;
        assert_eq!(short.status(), StatusCode::BAD_REQUEST);
        let short_body = json_body(short).await;
        assert_eq!(short_body["error"], "audio too short");
        assert_eq!(short_body["code"], "AUDIO_TOO_SHORT");

        let rate = post_pcm(
            &app,
            Some(&token),
            Some("rate"),
            "8000",
            "1",
            Some("application/octet-stream"),
            pcm_clip(3200),
        )
        .await;
        assert_eq!(rate.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json_body(rate).await["code"], "BAD_SAMPLE_RATE");
        let channels = post_pcm(
            &app,
            Some(&token),
            Some("ch"),
            "16000",
            "2",
            Some("application/octet-stream"),
            pcm_clip(3200),
        )
        .await;
        assert_eq!(channels.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json_body(channels).await["code"], "BAD_CHANNELS");

        let media = post_pcm(
            &app,
            Some(&token),
            Some("media"),
            "16000",
            "1",
            Some("text/plain"),
            pcm_clip(3200),
        )
        .await;
        assert_eq!(media.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        let media_body = json_body(media).await;
        assert_eq!(media_body["error"], "unsupported media type");
        assert_eq!(media_body["code"], "UNSUPPORTED_MEDIA");
        let missing_type = post_pcm(
            &app,
            Some(&token),
            Some("notype"),
            "16000",
            "1",
            None,
            pcm_clip(3200),
        )
        .await;
        assert_eq!(missing_type.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);

        let missing_id = post_pcm(
            &app,
            Some(&token),
            None,
            "16000",
            "1",
            Some("application/octet-stream"),
            pcm_clip(3200),
        )
        .await;
        assert_eq!(missing_id.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json_body(missing_id).await["code"], "CLIENT_TURN_ID");
        let blank_id = post_pcm(
            &app,
            Some(&token),
            Some("   "),
            "16000",
            "1",
            Some("application/octet-stream"),
            pcm_clip(3200),
        )
        .await;
        assert_eq!(json_body(blank_id).await["code"], "CLIENT_TURN_ID");
        let long_id = "x".repeat(65);
        let long_id = post_pcm(
            &app,
            Some(&token),
            Some(&long_id),
            "16000",
            "1",
            Some("application/octet-stream"),
            pcm_clip(3200),
        )
        .await;
        assert_eq!(json_body(long_id).await["code"], "CLIENT_TURN_ID");

        let too_long = post_clip(&app, &token, "long-audio", pcm_clip(960_001)).await;
        assert_eq!(too_long.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(json_body(too_long).await.get("code").is_none());
        let huge_turn = "a".repeat(70 * 1024);
        let limited = post_turn(&app, &token, &huge_turn).await;
        assert_eq!(limited.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(voice.hits(), 0);
        assert_eq!(turns.len(), 0);
        assert_eq!(loads(&calls), 0);
        assert_eq!(cfg.read().expect("config").voice.mode, "cascaded");
        assert!(!voice.saw_profile.load(std::sync::atomic::Ordering::SeqCst));

        let min_id = "m".repeat(64);
        let min = post_pcm(
            &app,
            Some(&token),
            Some(&min_id),
            "16000",
            "1",
            Some("application/octet-stream; charset=binary"),
            pcm_clip(3200),
        )
        .await;
        assert_eq!(min.status(), StatusCode::OK);
        let min_body = json_body(min).await;
        assert_eq!(min_body, silence_json(&min_id));
        assert_eq!(voice.hits(), 1);
        let min_again = post_pcm(
            &app,
            Some(&token),
            Some(&min_id),
            "16000",
            "1",
            Some("application/octet-stream"),
            pcm_clip(3200),
        )
        .await;
        assert_eq!(json_body(min_again).await, min_body);
        assert_eq!(voice.hits(), 1);
        let via = serde_json::json!({
            "text": "hi",
            "spoken": false,
            "clientTurnId": min_id,
        })
        .to_string();
        let via_turn = post_turn(&app, &token, &via).await;
        assert_eq!(via_turn.status(), StatusCode::OK);
        assert_eq!(json_body(via_turn).await, min_body);
        assert_eq!(loads(&calls), 0);

        let wide = post_clip(&app, &token, "wide-1", pcm_clip(70 * 1024)).await;
        assert_eq!(wide.status(), StatusCode::OK);
        assert_eq!(json_body(wide).await, silence_json("wide-1"));
        assert_eq!(voice.hits(), 2);

        voice.set_text("  \n");
        let blank = post_clip(&app, &token, "blank-text", pcm_clip(3200)).await;
        assert_eq!(blank.status(), StatusCode::OK);
        assert_eq!(json_body(blank).await, silence_json("blank-text"));
        assert_eq!(voice.hits(), 3);
        assert_eq!(turns.len(), 3);

        voice
            .asr_status
            .store(500, std::sync::atomic::Ordering::SeqCst);
        voice.set_text("hello");
        let down = post_clip(&app, &token, "down", pcm_clip(3200)).await;
        assert_eq!(down.status(), StatusCode::SERVICE_UNAVAILABLE);
        let down_body = json_body(down).await;
        assert_eq!(down_body["error"], "stt unavailable");
        assert_eq!(down_body["code"], "VOICE_UNAVAILABLE");
        assert!(down_body.get("disposed").is_none());
        assert_eq!(turns.len(), 3);
        assert_eq!(voice.hits(), 4);
        let down_again = post_clip(&app, &token, "down", pcm_clip(3200)).await;
        assert_eq!(down_again.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(voice.hits(), 5);
        assert!(turns.lookup(&device, "down").is_none());
        assert_eq!(loads(&calls), 0);
        assert!(!voice.saw_profile.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(cfg.read().expect("config").voice.mode, "cascaded");
    }

    #[tokio::test]
    async fn handset_utterance_speaks_first_sentence() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let tools_seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let calls2 = Arc::clone(&calls);
        let seen2 = Arc::clone(&seen);
        let tools2 = Arc::clone(&tools_seen);
        let scripted = mp_brain::ScriptedLlm::with_intent_tools(
            |_| "ask".into(),
            move |q, tools| {
                calls2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                seen2.lock().expect("seen").push(q.to_string());
                *tools2.lock().expect("tools") = tool_names(tools);
                let tool_calls = if q == "stop the music" {
                    vec![intent_call("stop", serde_json::json!({}))]
                } else if q == "too loud" {
                    vec![intent_call(
                        "set_volume",
                        serde_json::json!({ "level": 500 }),
                    )]
                } else if q == "volume" {
                    vec![intent_call(
                        "set_volume",
                        serde_json::json!({ "level": 40 }),
                    )]
                } else {
                    Vec::new()
                };
                let content = if q == "stop the music" {
                    Some("Hello team. More later.".into())
                } else if q == "piper down" {
                    Some("Still here.".into())
                } else if q == "long line" {
                    Some("a".repeat(450))
                } else {
                    None
                };
                mp_brain::IntentResult {
                    content,
                    tool_calls,
                }
            },
        );
        let voice = VoiceStub::start().await;
        let (dir, mut state) = music_state();
        state = attach_voice(state, &voice.base);
        assert!(state.read_config().voice.require_watchword);
        assert_eq!(state.read_config().voice.mode, "cascaded");
        let station = state.station.clone().unwrap();
        let volume_before = station.player.get_volume();
        let mut ws = state.ws_tx.subscribe();
        let (token, _) = mint_handset(&state);
        let brain = mp_brain::BrainRuntime::in_process(
            mp_brain::InProcessBrain::scripted(scripted).with_id_factory(|| "t-handset".into()),
        );
        let app = handset_router(state.with_brain(brain));
        voice.set_text("stop the music");

        let said = post_clip(&app, &token, "say-1", pcm_clip(3200)).await;
        assert_eq!(said.status(), StatusCode::OK);
        let said_body = json_body(said).await;
        assert_eq!(said_body["transcript"], "stop the music");
        assert_eq!(said_body["turnId"], "t-handset");
        assert_eq!(said_body["clientTurnId"], "say-1");
        assert_eq!(said_body["replyText"], "Hello team. More later.");
        assert!(said_body["error"].is_null());
        assert!(said_body.get("sources").is_none());
        assert!(said_body.get("skill").is_none());
        assert!(said_body.get("toolProposals").is_none());
        let tool = &said_body["disposedTools"][0];
        assert_eq!(tool["name"], "stop");
        assert_eq!(tool["ok"], true);
        assert_eq!(tool["result"], "Stopped and queue cleared");
        assert!(tool["error"].is_null());
        assert!(tool.get("args").is_none());
        assert_eq!(voice.spoke(), "Hello team.");
        assert_eq!(voice.voice_name(), "en_GB-cori-high");
        assert_wav(&said_body["audio"], 22050);
        assert_eq!(
            seen.lock().expect("seen").as_slice(),
            ["stop the music".to_string()]
        );
        assert_eq!(
            tools_seen.lock().expect("tools").as_slice(),
            [
                "now_playing",
                "pause",
                "play_music",
                "queue",
                "resume",
                "set_volume",
                "skip",
                "stop",
            ]
        );
        assert_eq!(state_changes(&mut ws), 1);
        assert_eq!(voice.hits(), 1);
        assert_eq!(voice.tts_hits(), 1);
        assert_eq!(loads(&calls), 1);

        let again = post_clip(&app, &token, "say-1", pcm_clip(3200)).await;
        assert_eq!(again.status(), StatusCode::OK);
        assert_eq!(json_body(again).await, said_body);
        let via = serde_json::json!({
            "text": "other words",
            "spoken": false,
            "clientTurnId": "say-1",
        })
        .to_string();
        let via_turn = post_turn(&app, &token, &via).await;
        assert_eq!(json_body(via_turn).await, said_body);
        let via_verb = post_verb(&app, &token, r#"{"name":"pause","clientTurnId":"say-1"}"#).await;
        assert_eq!(json_body(via_verb).await, said_body);
        assert_eq!(voice.hits(), 1);
        assert_eq!(voice.tts_hits(), 1);
        assert_eq!(loads(&calls), 1);
        assert_eq!(state_changes(&mut ws), 0);

        voice.set_text("too loud");
        let loud = post_clip(&app, &token, "loud-1", pcm_clip(3200)).await;
        assert_eq!(loud.status(), StatusCode::OK);
        let loud_body = json_body(loud).await;
        let raw = serde_json::to_string(&loud_body).unwrap();
        assert!(!raw.contains("Usage"), "{raw}");
        assert!(!raw.contains("allowDangerous"), "{raw}");
        let loud_tool = &loud_body["disposedTools"][0];
        assert_eq!(loud_tool["ok"], false);
        assert!(loud_tool["result"].is_null());
        assert_eq!(loud_tool["error"], "bad tool arguments");
        assert!(loud_body["audio"].is_null());
        assert!(loud_body["error"].is_null());
        assert_eq!(loud_body["replyText"], "");
        assert_eq!(station.player.get_volume(), volume_before);
        assert_eq!(voice.tts_hits(), 1);
        assert_eq!(state_changes(&mut ws), 1);

        voice.set_text("volume");
        let quiet = post_clip(&app, &token, "vol-1", pcm_clip(3200)).await;
        assert_eq!(quiet.status(), StatusCode::OK);
        let quiet_body = json_body(quiet).await;
        assert_eq!(
            quiet_body["disposedTools"][0]["result"],
            "Volume set to 40%"
        );
        assert_eq!(voice.spoke(), "Volume set to 40%");
        assert_eq!(station.player.get_volume(), 40);
        assert_wav(&quiet_body["audio"], 22050);
        assert!(quiet_body["error"].is_null());
        assert_eq!(voice.tts_hits(), 2);
        assert_eq!(state_changes(&mut ws), 1);

        voice.set_text("piper down");
        voice
            .tts_status
            .store(500, std::sync::atomic::Ordering::SeqCst);
        let failed = post_clip(&app, &token, "tts-1", pcm_clip(3200)).await;
        assert_eq!(failed.status(), StatusCode::OK);
        let failed_body = json_body(failed).await;
        assert_eq!(failed_body["replyText"], "Still here.");
        assert!(failed_body["audio"].is_null());
        assert_eq!(failed_body["error"]["code"], "TTS_UNAVAILABLE");
        assert_eq!(failed_body["error"]["error"], "tts unavailable");
        let raw = serde_json::to_string(&failed_body).unwrap();
        assert!(!raw.contains("tts http"), "{raw}");
        assert_eq!(voice.tts_hits(), 3);
        assert_eq!(loads(&calls), 4);
        let failed_again = post_clip(&app, &token, "tts-1", pcm_clip(3200)).await;
        assert_eq!(json_body(failed_again).await, failed_body);
        assert_eq!(voice.tts_hits(), 3);
        assert_eq!(loads(&calls), 4);
        assert_eq!(state_changes(&mut ws), 0);

        voice
            .tts_status
            .store(200, std::sync::atomic::Ordering::SeqCst);
        voice.set_text("long line");
        let long = post_clip(&app, &token, "long-1", pcm_clip(3200)).await;
        assert_eq!(long.status(), StatusCode::OK);
        let long_body = json_body(long).await;
        assert_eq!(
            long_body["replyText"].as_str().unwrap().chars().count(),
            450
        );
        assert_eq!(voice.spoke().chars().count(), 400);
        assert!(voice.spoke().chars().all(|c| c == 'a'));
        assert_wav(&long_body["audio"], 22050);
        assert_eq!(loads(&calls), 5);
        assert_eq!(voice.hits(), 5);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn handset_utterance_abort_during_tts_stores_once() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls2 = Arc::clone(&calls);
        let scripted = mp_brain::ScriptedLlm::with_intent_tools(
            |_| "ask".into(),
            move |_q, _tools| {
                calls2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                mp_brain::IntentResult {
                    content: Some("Hello team. More later.".into()),
                    tool_calls: vec![intent_call("stop", serde_json::json!({}))],
                }
            },
        );
        let voice = VoiceStub::start().await;
        voice.set_text("stop the music");
        let (dir, mut state) = music_state();
        state = attach_voice(state, &voice.base);
        state.handset_dispose_delay = std::time::Duration::from_millis(300);
        let mut ws = state.ws_tx.subscribe();
        let flight = Arc::clone(&state.handset_flight);
        let turns = Arc::clone(&state.handset_turns);
        let (token, device) = mint_handset(&state);
        let brain = mp_brain::BrainRuntime::in_process(
            mp_brain::InProcessBrain::scripted(scripted).with_id_factory(|| "t-handset".into()),
        );
        let app = handset_router(state.with_brain(brain));
        let app2 = app.clone();
        let token2 = token.clone();
        let inflight =
            tokio::spawn(async move { post_clip(&app2, &token2, "abort-1", pcm_clip(3200)).await });
        let started = std::time::Instant::now();
        loop {
            if loads(&calls) >= 1 {
                break;
            }
            if started.elapsed() > std::time::Duration::from_secs(2) {
                panic!("brain never called");
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        wait_until_busy(&flight).await;
        let during = get_now(&app, &token).await;
        assert_eq!(during.status(), StatusCode::OK);
        assert_eq!(json_body(during).await["connected"], true);
        let busy = post_clip(&app, &token, "other", pcm_clip(3200)).await;
        assert_eq!(busy.status(), StatusCode::CONFLICT);
        let busy_body = json_body(busy).await;
        assert_eq!(busy_body["error"], "handset busy");
        assert_eq!(busy_body["code"], "BUSY");
        assert!(busy_body.get("retryAfterMs").is_none());
        assert!(busy_body.get("disposed").is_none());
        assert!(turns.lookup(&device, "other").is_none());
        inflight.abort();
        let stored = wait_row(&turns, &device, "abort-1").await;
        assert_eq!(stored["transcript"], "stop the music");
        assert_eq!(stored["replyText"], "Hello team. More later.");
        assert_eq!(
            stored["disposedTools"][0]["result"],
            "Stopped and queue cleared"
        );
        assert!(stored["error"].is_null());
        assert_wav(&stored["audio"], 22050);
        assert_eq!(voice.hits(), 1);
        assert_eq!(voice.tts_hits(), 1);
        assert_eq!(loads(&calls), 1);
        assert_eq!(state_changes(&mut ws), 1);
        let again = post_clip(&app, &token, "abort-1", pcm_clip(3200)).await;
        assert_eq!(again.status(), StatusCode::OK);
        assert_eq!(json_body(again).await, stored);
        assert_eq!(voice.hits(), 1);
        assert_eq!(voice.tts_hits(), 1);
        assert_eq!(loads(&calls), 1);
        assert_eq!(turns.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn handset_utterance_deadline_and_brain_errors_are_not_stored() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (_scripted, brain) = counting_brain(&calls);
        let voice = VoiceStub::start().await;
        voice.set_text("hello");
        voice
            .asr_delay_ms
            .store(400, std::sync::atomic::Ordering::SeqCst);
        let mut state = AppState::new(
            Arc::new(Database::open_in_memory().unwrap()),
            Arc::new(BotConfig::default()),
            None,
        );
        state = attach_voice(state, &voice.base);
        state.handset_deadline = std::time::Duration::from_millis(80);
        let turns = Arc::clone(&state.handset_turns);
        let (token, _) = mint_handset(&state);
        let app = handset_router(state.with_brain(brain));
        let late = post_clip(&app, &token, "slow", pcm_clip(3200)).await;
        assert_eq!(late.status(), StatusCode::GATEWAY_TIMEOUT);
        let late_body = json_body(late).await;
        assert_eq!(late_body["error"], "handset deadline");
        assert_eq!(late_body["code"], "DEADLINE");
        assert_eq!(late_body["disposed"], false);
        assert!(late_body.get("transcript").is_none());
        assert_eq!(turns.len(), 0);
        assert_eq!(loads(&calls), 0);
        assert_eq!(voice.hits(), 1);
        voice
            .asr_delay_ms
            .store(0, std::sync::atomic::Ordering::SeqCst);
        let again = post_clip(&app, &token, "slow", pcm_clip(3200)).await;
        assert_eq!(again.status(), StatusCode::OK);
        let again_body = json_body(again).await;
        assert_eq!(again_body["transcript"], "hello");
        assert_eq!(again_body["replyText"], "ok:hello");
        assert_wav(&again_body["audio"], 22050);
        assert_eq!(voice.hits(), 2);
        assert_eq!(loads(&calls), 1);
        assert_eq!(turns.len(), 1);
        let stored = post_clip(&app, &token, "slow", pcm_clip(3200)).await;
        assert_eq!(json_body(stored).await, again_body);
        assert_eq!(voice.hits(), 2);
        assert_eq!(loads(&calls), 1);

        let fetches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let fetches2 = Arc::clone(&fetches);
        let fetch: mp_brain::FetchFn = Arc::new(move |_url, _body| {
            fetches2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async {
                Ok(mp_brain::RawHttp {
                    status: 200,
                    body: b"{}".to_vec(),
                })
            })
        });
        let remote = mp_brain::BrainRuntime::with_transport(mp_brain::BrainTransport::Http(
            mp_brain::HttpBrain::with_fetch("http://127.0.0.1:9", fetch),
        ));
        let voice = VoiceStub::start().await;
        let mut state = AppState::new(
            Arc::new(Database::open_in_memory().unwrap()),
            Arc::new(BotConfig::default()),
            None,
        );
        state = attach_voice(state, &voice.base);
        let turns = Arc::clone(&state.handset_turns);
        let (token, device) = mint_handset(&state);
        let app = handset_router(state.with_brain(remote));
        let quiet = post_clip(&app, &token, "quiet", pcm_clip(3200)).await;
        assert_eq!(quiet.status(), StatusCode::OK);
        assert_eq!(json_body(quiet).await, silence_json("quiet"));
        assert_eq!(loads(&fetches), 0);
        assert_eq!(voice.hits(), 1);
        assert_eq!(turns.len(), 1);
        voice.set_text("play something");
        let remote_turn = post_clip(&app, &token, "remote-1", pcm_clip(3200)).await;
        assert_eq!(remote_turn.status(), StatusCode::SERVICE_UNAVAILABLE);
        let remote_body = json_body(remote_turn).await;
        assert_eq!(remote_body["error"], "brain is remote");
        assert_eq!(remote_body["code"], "BRAIN_REMOTE");
        assert!(remote_body.get("disposed").is_none());
        assert_eq!(loads(&fetches), 0);
        assert_eq!(voice.hits(), 2);
        assert_eq!(turns.len(), 1);
        let remote_again = post_clip(&app, &token, "remote-1", pcm_clip(3200)).await;
        assert_eq!(remote_again.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(voice.hits(), 3);
        assert!(turns.lookup(&device, "remote-1").is_none());
        assert_eq!(loads(&fetches), 0);

        let voice = VoiceStub::start().await;
        voice.set_text("hello");
        let state = AppState::new(
            Arc::new(Database::open_in_memory().unwrap()),
            Arc::new(BotConfig::default()),
            None,
        );
        let state = attach_voice(state, &voice.base);
        let turns = Arc::clone(&state.handset_turns);
        let (token, _) = mint_handset(&state);
        let app = handset_router(state.with_brain(mp_brain::BrainRuntime::disabled()));
        let off = post_clip(&app, &token, "off", pcm_clip(3200)).await;
        assert_eq!(off.status(), StatusCode::CONFLICT);
        let off_body = json_body(off).await;
        assert_eq!(off_body["error"], "LLM is not enabled");
        assert_eq!(off_body["code"], "LLM_DISABLED");
        assert_eq!(turns.len(), 0);
        assert_eq!(voice.hits(), 1);
        let off_again = post_clip(&app, &token, "off", pcm_clip(3200)).await;
        assert_eq!(off_again.status(), StatusCode::CONFLICT);
        assert_eq!(voice.hits(), 2);
        assert_eq!(turns.len(), 0);

        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls2 = Arc::clone(&calls);
        let mut scripted = mp_brain::ScriptedLlm::ask_only(|_| "ask".into());
        scripted.chat_for_intent_with = Some(Arc::new(move |_q, _tools| {
            calls2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err("boom prompt".into())
        }));
        let voice = VoiceStub::start().await;
        voice.set_text("hello");
        let state = AppState::new(
            Arc::new(Database::open_in_memory().unwrap()),
            Arc::new(BotConfig::default()),
            None,
        );
        let state = attach_voice(state, &voice.base);
        let turns = Arc::clone(&state.handset_turns);
        let (token, _) = mint_handset(&state);
        let brain = mp_brain::BrainRuntime::in_process(
            mp_brain::InProcessBrain::scripted(scripted).with_id_factory(|| "t-handset".into()),
        );
        let app = handset_router(state.with_brain(brain));
        let failed = post_clip(&app, &token, "bad", pcm_clip(3200)).await;
        assert_eq!(failed.status(), StatusCode::BAD_GATEWAY);
        let failed_body = json_body(failed).await;
        assert_eq!(failed_body["error"], "intent failed");
        assert_eq!(failed_body["code"], "INTENT_FAILED");
        let raw = serde_json::to_string(&failed_body).unwrap();
        assert!(!raw.contains("boom"), "{raw}");
        assert_eq!(turns.len(), 0);
        assert_eq!(voice.hits(), 1);
        assert_eq!(loads(&calls), 1);
        let failed_again = post_clip(&app, &token, "bad", pcm_clip(3200)).await;
        assert_eq!(failed_again.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(voice.hits(), 2);
        assert_eq!(loads(&calls), 2);
        assert_eq!(turns.len(), 0);

        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls2 = Arc::clone(&calls);
        let scripted = mp_brain::ScriptedLlm::with_intent_tools(
            |_| "ask".into(),
            move |q, _tools| {
                calls2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if q == "go" {
                    mp_brain::IntentResult {
                        content: Some("ok".into()),
                        tool_calls: vec![intent_call("pause", serde_json::json!({}))],
                    }
                } else {
                    mp_brain::IntentResult {
                        content: Some("Noted team. Later.".into()),
                        tool_calls: Vec::new(),
                    }
                }
            },
        );
        let voice = VoiceStub::start().await;
        voice.set_text("go");
        let state = AppState::new(
            Arc::new(Database::open_in_memory().unwrap()),
            Arc::new(BotConfig::default()),
            None,
        );
        let state = attach_voice(state, &voice.base);
        let turns = Arc::clone(&state.handset_turns);
        let (token, _) = mint_handset(&state);
        let brain = mp_brain::BrainRuntime::in_process(
            mp_brain::InProcessBrain::scripted(scripted).with_id_factory(|| "t-handset".into()),
        );
        let app = handset_router(state.with_brain(brain));
        let missing = post_clip(&app, &token, "go-1", pcm_clip(3200)).await;
        assert_eq!(missing.status(), StatusCode::CONFLICT);
        let missing_body = json_body(missing).await;
        assert_eq!(missing_body["error"], "No bot instance available");
        assert_eq!(missing_body["code"], "NO_BOT");
        assert_eq!(turns.len(), 0);
        assert_eq!(voice.hits(), 1);
        assert_eq!(loads(&calls), 1);
        let missing_again = post_clip(&app, &token, "go-1", pcm_clip(3200)).await;
        assert_eq!(missing_again.status(), StatusCode::CONFLICT);
        assert_eq!(voice.hits(), 2);
        assert_eq!(loads(&calls), 2);
        assert_eq!(turns.len(), 0);
        voice.set_text("hello");
        let noted = post_clip(&app, &token, "note-1", pcm_clip(3200)).await;
        assert_eq!(noted.status(), StatusCode::OK);
        let noted_body = json_body(noted).await;
        assert_eq!(noted_body["replyText"], "Noted team. Later.");
        assert!(noted_body["disposedTools"].as_array().unwrap().is_empty());
        assert!(noted_body["error"].is_null());
        assert_eq!(voice.spoke(), "Noted team.");
        assert_wav(&noted_body["audio"], 22050);
        assert_eq!(voice.hits(), 3);
        assert_eq!(loads(&calls), 3);
        assert_eq!(turns.len(), 1);
        let noted_again = post_clip(&app, &token, "note-1", pcm_clip(3200)).await;
        assert_eq!(json_body(noted_again).await, noted_body);
        assert_eq!(voice.hits(), 3);
        assert_eq!(loads(&calls), 3);
    }

    fn is_display_code(code: &str) -> bool {
        let alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let mut parts = code.split('-');
        let (Some(left), Some(right), None) = (parts.next(), parts.next(), parts.next()) else {
            return false;
        };
        left.len() == 4
            && right.len() == 4
            && left
                .chars()
                .chain(right.chars())
                .all(|c| alphabet.contains(c))
    }

    async fn device_call(
        app: &Router,
        method: &str,
        uri: &str,
        token: &str,
    ) -> axum::response::Response {
        app.clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn health_ok() {
        let app = test_app();
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["status"], "ok");
        assert_eq!(v["version"], "0.1.0");
        assert!(v["opus"]["native"].is_boolean());
        assert_eq!(v["llm"]["route"], "none");
    }

    #[tokio::test]
    async fn needs_setup_true_on_empty_users() {
        let app = test_app();
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/session/needs-setup")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["needsSetup"], true);
    }

    #[tokio::test]
    async fn setup_rejected_without_csrf_origin() {
        let app = test_app();
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/session/setup")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .body(Body::from(
                        r#"{"username":"admin","password":"password12"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn setup_creates_admin() {
        let app = test_app();
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/session/setup")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .body(Body::from(
                        r#"{"username":"admin","password":"password12"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let set_cookie = res
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(set_cookie.starts_with("moneypenny_session="));
        assert!(set_cookie.contains("HttpOnly"));
        assert!(set_cookie.contains("SameSite=Lax"));
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["username"], "admin");
        assert_eq!(v["role"], "admin");
    }

    #[tokio::test]
    async fn bot_list_requires_auth() {
        let app = test_app();
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/bot")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn bot_list_and_library_after_setup() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let cfg = Arc::new(BotConfig::default());
        let dir = std::env::temp_dir().join(format!(
            "mp-http-lib-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.mp3"), b"x").unwrap();
        let station = Arc::new(mp_music::MusicStation::new(&dir, None));
        station.set_dry_run(true);
        let executor = Arc::new(mp_control::CommandExecutor::new(Arc::clone(&station), "!"));
        let state = AppState::new(db, cfg, None).with_music(station, executor, None);
        let app = router(state);

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/session/setup")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .body(Body::from(
                        r#"{"username":"admin","password":"password12"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let cookie = res
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/bot")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["bots"][0]["name"], "Moneypenny");
        assert!(v["bots"][0]["id"].is_string());

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/music/library")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v["count"].as_u64().unwrap() >= 1);

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/bot/live")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/bot/settings")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(
            v["llmSystemPromptDefault"]
                .as_str()
                .unwrap_or("")
                .contains("Colonel Moneypenny"),
            "built-in persona missing: {v}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn openapi_lists_frozen_paths() {
        let app = test_app();
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/openapi.json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v["paths"]["/api/health"]["get"].is_object());
        assert!(v["paths"]["/api/session/needs-setup"]["get"].is_object());
        assert!(v["paths"]["/v1/turn"]["post"].is_object());
    }

    async fn setup_cookie(app: Router) -> (Router, String) {
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/session/setup")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .body(Body::from(
                        r#"{"username":"admin","password":"password12"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let cookie = res
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();
        (app, cookie)
    }

    fn turn_post(cookie: &str, body: &'static str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/v1/turn")
            .header("content-type", "application/json")
            .header("host", "localhost:3000")
            .header("origin", "http://localhost:3000")
            .header("cookie", cookie)
            .body(Body::from(body))
            .unwrap()
    }

    #[tokio::test]
    async fn turn_requires_admin() {
        let app = test_app();
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/turn")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .body(Body::from(r#"{"text":"hello"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn turn_missing_text_is_400() {
        let (app, cookie) = setup_cookie(test_app()).await;
        let res = app
            .oneshot(turn_post(&cookie, r#"{"text":"  "}"#))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn turn_llm_disabled_is_409() {
        let (app, cookie) = setup_cookie(test_app()).await;
        let res = app
            .oneshot(turn_post(&cookie, r#"{"text":"hello"}"#))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CONFLICT);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["code"], "LLM_DISABLED");
        assert!(v["error"].as_str().unwrap_or("").contains("not enabled"));
        assert!(v["toolProposals"].as_array().unwrap().is_empty());
    }

    fn music_state() -> (std::path::PathBuf, AppState) {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let cfg = Arc::new(BotConfig::default());
        let dir = std::env::temp_dir().join(format!(
            "mp-http-turn-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("sine.mp3"), b"x").unwrap();
        let station = Arc::new(mp_music::MusicStation::new(&dir, None));
        station.set_dry_run(true);
        let executor = Arc::new(mp_control::CommandExecutor::new(Arc::clone(&station), "!"));
        let state = AppState::new(db, cfg, None).with_music(station, executor, None);
        (dir, state)
    }

    #[tokio::test]
    async fn execute_tools_false_does_not_mutate_queue() {
        let (dir, state) = music_state();
        let station = state.station.clone().unwrap();
        let brain = mp_brain::BrainRuntime::in_process(
            mp_brain::InProcessBrain::scripted(mp_brain::ScriptedLlm::with_intent(
                |_| "Sure".into(),
                |_| mp_brain::IntentResult {
                    content: Some("Sure".into()),
                    tool_calls: vec![mp_brain::IntentToolCall {
                        id: "call-1".into(),
                        name: "play_music".into(),
                        arguments: serde_json::json!({ "query": "sine" }),
                    }],
                },
            ))
            .with_id_factory(|| "t-intent".into()),
        );
        let app = router(state.with_brain(brain));
        let (app, cookie) = setup_cookie(app).await;
        let res = app
            .clone()
            .oneshot(turn_post(
                &cookie,
                r#"{"text":"play sine","mode":"intent","executeTools":false}"#,
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["toolProposals"][0]["name"], "play_music");
        assert!(v.get("disposedTools").is_none());
        assert_eq!(station.queue.lock().unwrap().size(), 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn execute_tools_true_disposes_after_rights() {
        let (dir, state) = music_state();
        let station = state.station.clone().unwrap();
        let brain = mp_brain::BrainRuntime::in_process(
            mp_brain::InProcessBrain::scripted(mp_brain::ScriptedLlm::with_intent(
                |_| "Sure".into(),
                |_| mp_brain::IntentResult {
                    content: Some("Sure".into()),
                    tool_calls: vec![mp_brain::IntentToolCall {
                        id: "call-1".into(),
                        name: "play_music".into(),
                        arguments: serde_json::json!({ "query": "sine" }),
                    }],
                },
            ))
            .with_id_factory(|| "t-exec".into()),
        );
        let app = router(state.with_brain(brain));
        let (app, cookie) = setup_cookie(app).await;
        let res = app
            .oneshot(turn_post(
                &cookie,
                r#"{"text":"play sine","mode":"intent","executeTools":true}"#,
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["disposedTools"][0]["ok"], true);
        let result = v["disposedTools"][0]["result"].as_str().unwrap_or("");
        assert!(result.starts_with("Now playing"), "{result}");
        assert_eq!(station.queue.lock().unwrap().size(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn execute_tools_dry_run_does_not_mutate_queue() {
        let (dir, state) = music_state();
        let station = state.station.clone().unwrap();
        let brain = mp_brain::BrainRuntime::in_process(
            mp_brain::InProcessBrain::scripted(mp_brain::ScriptedLlm::with_intent(
                |_| "Sure".into(),
                |_| mp_brain::IntentResult {
                    content: Some("Sure".into()),
                    tool_calls: vec![mp_brain::IntentToolCall {
                        id: "call-1".into(),
                        name: "play_music".into(),
                        arguments: serde_json::json!({ "query": "sine" }),
                    }],
                },
            ))
            .with_id_factory(|| "t-dry".into()),
        );
        let app = router(state.with_brain(brain));
        let (app, cookie) = setup_cookie(app).await;
        let res = app
            .oneshot(turn_post(
                &cookie,
                r#"{"text":"play sine","mode":"intent","executeTools":true,"dryRun":true}"#,
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["disposedTools"][0]["ok"], true);
        assert!(
            v["disposedTools"][0]["result"]
                .as_str()
                .unwrap_or("")
                .contains("[dry-run]")
        );
        assert_eq!(station.queue.lock().unwrap().size(), 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn doctrine_create_list_query() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let cfg = Arc::new(BotConfig::default());
        let data = std::env::temp_dir().join(format!(
            "mp-http-doc-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let retrieval = Arc::new(mp_rag::RetrievalStore::new(
            mp_rag::Embedder::Hash { dim: 16 },
            mp_rag::VectorStore::Memory(mp_rag::MemoryVectorStore::new()),
            "t".into(),
            4,
        ));
        let doctrine = Arc::new(mp_rag::DoctrineStore::new(Arc::clone(&db), &data).unwrap());
        let rag = mp_rag::RagRuntime::new(retrieval, doctrine, true, true, 4);
        let state = AppState::new(db, cfg, None).with_rag(rag);
        let app = router(state);
        let (app, cookie) = setup_cookie(app).await;

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/rag/doctrine/new")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from(
                        r##"{"source":"combat.md","content":"# Formation\nHeavies establish the perimeter before jump.\n"}"##,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/rag/doctrine")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["docs"][0]["source"], "combat.md");

        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/rag/query")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from(r#"{"q":"formation perimeter"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(
            v["chunks"]
                .as_array()
                .map(|a| !a.is_empty())
                .unwrap_or(false),
            "{v}"
        );
        let _ = std::fs::remove_dir_all(data);
    }

    #[tokio::test]
    async fn voice_status_inactive_by_default() {
        let (app, cookie) = setup_cookie(test_app()).await;
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/bot/voice/status")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["enabled"], false);
        assert_eq!(v["active"], false);
        assert_eq!(v["watchword"], "moneypenny");
    }

    #[tokio::test]
    async fn voice_test_requires_active_pipeline() {
        let (dir, state) = music_state();
        let app = router(state);
        let (app, cookie) = setup_cookie(app).await;
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bot/voice/test")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from(
                        r#"{"transcript":"Moneypenny pause","speak":false}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CONFLICT);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["code"], "VOICE_UNAVAILABLE");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn voice_synthetic_pause_after_enable() {
        let (dir, state) = music_state();
        let mut vc = state.voice.config();
        vc.enabled = true;
        vc.stt_url = "http://127.0.0.1:9".into();
        state.voice.apply(vc);
        let app = router(state);
        let (app, cookie) = setup_cookie(app).await;

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bot/voice/test")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from(r#"{"transcript":"pause","speak":false}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["watchwordOnly"], false);
        assert!(v["reply"].is_null(), "{v}");

        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bot/voice/test")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from(
                        r#"{"transcript":"Moneypenny pause","speak":false}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["command"], "pause");
        assert_eq!(v["watchwordOnly"], false);
        assert!(
            v["reply"].as_str().unwrap_or("").contains("Paused")
                || v["reply"].as_str() == Some("Nothing is playing"),
            "{v}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn radio_status_off_by_default() {
        let (app, cookie) = setup_cookie(test_app()).await;
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/bot/radio/status")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["enabled"], false);
        assert_eq!(v["activeProfile"], "lobby");
    }

    #[tokio::test]
    async fn radio_enable_seeds_local_library() {
        let (dir, state) = music_state();
        let app = router(state);
        let (app, cookie) = setup_cookie(app).await;
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bot/settings")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from(r#"{"radio":{"enabled":true}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/bot/radio/status")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["enabled"], true);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn radio_test_bumper_requires_on() {
        let (dir, state) = music_state();
        let app = router(state);
        let (app, cookie) = setup_cookie(app).await;
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bot/radio/test-bumper")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CONFLICT);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn economy_seed_catalog_and_workorder() {
        let (app, cookie) = setup_cookie(test_app()).await;
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/economy/overview")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v["oreCount"].as_u64().unwrap() >= 11, "{v}");
        assert_eq!(v["workOrders"]["available"], true);

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/economy/mine?ore=quantanium&scu=16")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ore"]["id"], "quantainium");
        assert_eq!(v["targetScu"], 16.0);

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/economy/workorders")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from(r#"{"item":"quantainium","qty":8}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let id = v["order"]["id"].as_i64().unwrap();
        assert!(id > 0);

        let res = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/economy/workorders/{id}"))
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn mcp_disabled_is_404() {
        let app = test_app();
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/mcp/tools")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn mcp_confirm_blocks_stop_not_skip() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let cfg = Arc::new(BotConfig::default());
        let mcp = mp_mcp::McpConfig {
            enabled: true,
            token: "phase8-test".into(),
            require_confirm: true,
            default_profile: mp_mcp::McpProfile::Admin,
            ..mp_mcp::McpConfig::default()
        };
        let dir = std::env::temp_dir().join(format!(
            "mp-http-mcp-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("sine.mp3"), b"x").unwrap();
        let station = Arc::new(mp_music::MusicStation::new(&dir, None));
        station.set_dry_run(true);
        let executor = Arc::new(mp_control::CommandExecutor::new(Arc::clone(&station), "!"));
        let state = AppState::new(db, cfg, None)
            .with_music(station, executor, None)
            .with_mcp(mcp);
        let app = router(state);

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/mcp/tools")
                    .header("authorization", "Bearer phase8-test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp/tools/call")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer phase8-test")
                    .body(Body::from(r#"{"name":"music_stop","arguments":{}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["code"], "NEEDS_CONFIRMATION");

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp/tools/call")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer phase8-test")
                    .body(Body::from(r#"{"name":"music_skip","arguments":{}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_ne!(v["code"], "NEEDS_CONFIRMATION", "{v}");

        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp/tools/call")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer phase8-test")
                    .body(Body::from(
                        r#"{"name":"music_stop","arguments":{"confirm":true}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["code"], "OK");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn mcp_jsonrpc_initialize_and_list() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let cfg = Arc::new(BotConfig::default());
        let mcp = mp_mcp::McpConfig {
            enabled: true,
            token: "phase8-test".into(),
            ..mp_mcp::McpConfig::default()
        };
        let app = router(AppState::new(db, cfg, None).with_mcp(mcp));
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp")
                    .header("authorization", "Bearer phase8-test")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["result"]["serverInfo"]["name"], "moneypenny");
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp")
                    .header("authorization", "Bearer phase8-test")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let tools = v["result"]["tools"].as_array().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "music_play"));
        assert!(tools.iter().any(|t| t["name"] == "music_skip"));
    }

    #[tokio::test]
    async fn roast_settings_toggle() {
        let (app, cookie) = setup_cookie(test_app()).await;
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bot/settings")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from(r#"{"roastEnabled":true,"roastMinScore":6}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/bot/settings")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["roastEnabled"], true);
        assert_eq!(v["roastMinScore"], 6);
    }

    #[tokio::test]
    async fn settings_persist_to_config_json() {
        let dir = std::env::temp_dir().join(format!(
            "mp-http-cfg-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg_path = dir.join("config.json");
        std::fs::write(&cfg_path, r#"{"webPort":3000,"customExtra":"keep"}"#).unwrap();
        let db = Arc::new(Database::open_in_memory().unwrap());
        let cfg = Arc::new(BotConfig::default());
        let state = AppState::new(db, cfg, None).with_config_path(cfg_path.clone());
        let app = router(state);
        let (app, cookie) = setup_cookie(app).await;
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bot/settings")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from(
                        r#"{"llmEnabled":true,"llmUrl":"http://127.0.0.1:11434"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&cfg_path).unwrap()).unwrap();
        assert_eq!(raw["customExtra"], "keep");
        assert_eq!(raw["llmEnabled"], true);
        assert_eq!(raw["llmUrl"], "http://127.0.0.1:11434");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn audit_records_first_admin() {
        let (app, cookie) = setup_cookie(test_app()).await;
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/audit?limit=10")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let entries = v["entries"].as_array().unwrap();
        assert_eq!(entries[0]["action"], "admin.first_created");
        assert_eq!(entries[0]["actorUsername"], "admin");
    }

    #[tokio::test]
    async fn under_music_check_passes_defaults() {
        let (app, cookie) = setup_cookie(test_app()).await;
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/bot/voice/under-music-check")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], true, "{v}");
        assert!(v["plan"]["textFallbackAlwaysWorks"].as_bool().unwrap());
        let ids: Vec<&str> = v["results"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|r| r["id"].as_str())
            .collect();
        assert!(ids.contains(&"text-wake-pause"));
        assert!(ids.contains(&"kws-path"));
    }

    fn rag_state() -> (std::path::PathBuf, AppState) {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let cfg = Arc::new(BotConfig::default());
        let data = std::env::temp_dir().join(format!(
            "mp-http-doc2-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let retrieval = Arc::new(mp_rag::RetrievalStore::new(
            mp_rag::Embedder::Hash { dim: 16 },
            mp_rag::VectorStore::Memory(mp_rag::MemoryVectorStore::new()),
            "t".into(),
            4,
        ));
        let doctrine = Arc::new(mp_rag::DoctrineStore::new(Arc::clone(&db), &data).unwrap());
        let rag = mp_rag::RagRuntime::new(retrieval, doctrine, true, true, 4);
        let state = AppState::new(db, cfg, None).with_rag(rag);
        (data, state)
    }

    #[tokio::test]
    async fn doctrine_reformat_and_export_caps() {
        let (data, state) = rag_state();
        let app = router(state);
        let (app, cookie) = setup_cookie(app).await;

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/rag/doctrine/new")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from(r##"{"source":"brief.md","content":"hello world from the hangar tonight.\n"}"##))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/rag/doctrine/reformat")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], true, "{v}");
        assert!(v["changed"].as_u64().unwrap() >= 1);

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/rag/doctrine/export/capabilities")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v["pandoc"].is_boolean());

        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/rag/doctrine/brief.md/export?format=docx")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(
            res.status() == StatusCode::OK
                || res.status() == StatusCode::SERVICE_UNAVAILABLE
                || res.status() == StatusCode::BAD_GATEWAY,
            "{}",
            res.status()
        );
        let _ = std::fs::remove_dir_all(data);
    }

    #[tokio::test]
    async fn doctrine_multipart_upload() {
        let (data, state) = rag_state();
        let app = router(state);
        let (app, cookie) = setup_cookie(app).await;
        let boundary = "----mpboundary";
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"upload.md\"\r\nContent-Type: text/markdown\r\n\r\n# Upload\n\nHeavies establish the perimeter before jump.\n\r\n--{boundary}--\r\n"
        );
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/rag/doctrine")
                    .header(
                        "content-type",
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{:?}", res.status());
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["ingested"][0]["source"], "upload.md");

        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/rag/doctrine")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["docs"][0]["source"], "upload.md");
        let _ = std::fs::remove_dir_all(data);
    }

    #[tokio::test]
    async fn mcp_skip_writes_audit() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let cfg = Arc::new(BotConfig::default());
        let mcp = mp_mcp::McpConfig {
            enabled: true,
            token: "phase8-test".into(),
            require_confirm: true,
            default_profile: mp_mcp::McpProfile::Admin,
            ..mp_mcp::McpConfig::default()
        };
        let dir = std::env::temp_dir().join(format!(
            "mp-http-mcp-audit-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("sine.mp3"), b"x").unwrap();
        let station = Arc::new(mp_music::MusicStation::new(&dir, None));
        station.set_dry_run(true);
        let executor = Arc::new(mp_control::CommandExecutor::new(Arc::clone(&station), "!"));
        let state = AppState::new(db, cfg, None)
            .with_music(station, executor, None)
            .with_mcp(mcp);
        let app = router(state);
        let (app, cookie) = setup_cookie(app).await;

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp/tools/call")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer phase8-test")
                    .body(Body::from(r#"{"name":"music_skip","arguments":{}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/audit?limit=20")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let actions: Vec<&str> = v["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e["action"].as_str())
            .collect();
        assert!(actions.contains(&"mcp.tool"), "{v}");
        assert!(actions.contains(&"admin.first_created"), "{v}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn org_kg_seed_list_and_status_probes() {
        let (data, state) = rag_state();
        let app = router(state);
        let (app, cookie) = setup_cookie(app).await;

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bot/org-kg")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from(r#"{"fact":"Alice is the fleet commander"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{:?}", res.status());
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], true, "{v}");
        assert!(v["message"].as_str().unwrap_or("").contains("org KG"));

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/bot/org-kg")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["facts"][0]["fact"], "Alice is the fleet commander");

        for path in [
            "/api/bot/llm/status",
            "/api/bot/rag/status",
            "/api/bot/memory/status",
            "/api/bot/stream-bridge/status",
            "/api/bot/rights/debug",
            "/api/bot/ops/status",
            "/api/bot/memory/scopes",
        ] {
            let res = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .header("cookie", &cookie)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::OK, "{path}");
        }
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/bot/rag/status")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["configured"], true);
        let _ = std::fs::remove_dir_all(data);
    }

    #[tokio::test]
    async fn users_crud_and_harness_llm_disabled() {
        let (app, cookie) = setup_cookie(test_app()).await;
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/users")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from(
                        r#"{"username":"member1","password":"password12","role":"member"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let id = v["id"].as_str().unwrap().to_string();

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/users")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["users"].as_array().unwrap().len(), 2);

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bot/harness/ask")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from(r#"{"question":"hello"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CONFLICT);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["code"], "LLM_DISABLED");
        assert_eq!(v["turn"]["error"], "LLM is not enabled");

        let res = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/users/{id}"))
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn tags_rating_upload_recordings() {
        let (dir, mut state) = music_state();
        state
            .recordings_enabled
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let data = std::env::temp_dir().join(format!(
            "mp-rec-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&data).unwrap();
        state.data_dir = data.clone();
        let app = router(state);
        let (app, cookie) = setup_cookie(app).await;

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/music/tracks/sine/rating")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from(r#"{"stars":5}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["rating"]["count"], 1);

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/music/tracks/sine/tags")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from(r#"{"genre":"ambient","mood":"calm"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let boundary = "----mpup";
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"clip.mp3\"\r\nContent-Type: audio/mpeg\r\n\r\nID3fake\r\n--{boundary}--\r\n"
        );
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/music/upload")
                    .header(
                        "content-type",
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{:?}", res.status());
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["success"], true, "{v}");

        let b64 =
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"RIFF....WEBM");
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bot/recordings")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from(format!(
                        r#"{{"filename":"take-1.webm","dataBase64":"{b64}"}}"#
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CREATED, "{:?}", res.status());

        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/bot/recordings")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["enabled"], true);
        assert_eq!(v["recordings"][0]["filename"], "take-1.webm");
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(data);
    }

    #[tokio::test]
    async fn delete_track_admin_and_reject_traversal() {
        let (dir, state) = music_state();
        let app = router(state);
        let (app, cookie) = setup_cookie(app).await;

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/music/tracks/foo..bar")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/music/search?platform=local&limit=20")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let id = v["songs"][0]["id"].as_str().unwrap().to_string();

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/music/tracks/{id}"))
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{:?}", res.status());
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["success"], true);
        assert_eq!(v["deleted"], true);

        let res = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/music/tracks/{id}"))
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn rag_eval_returns_report() {
        let (data, state) = rag_state();
        let app = router(state);
        let (app, cookie) = setup_cookie(app).await;
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bot/rag/eval")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .header("cookie", &cookie)
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{:?}", res.status());
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v.get("passed").is_some(), "{v}");
        assert!(v.get("failed").is_some(), "{v}");
        assert!(v["results"].as_array().unwrap().len() >= 4, "{v}");
        let _ = std::fs::remove_dir_all(data);
    }

    #[tokio::test]
    async fn datarunner_bearer_ingests_without_cookie_or_origin() {
        let prev = std::env::var("ECONOMY_INGEST_TOKEN").ok();
        unsafe { std::env::set_var("ECONOMY_INGEST_TOKEN", "test-ingest-token-please") };
        let app = test_app();
        let body = r#"{"source":"datarunner","game_version":"4.10.0","environment":"LIVE","id_terminal":18,"type":"commodity","captured_at":1700000000,"prices":[{"name":"Laranite","price_buy":500}]}"#;
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/economy/ingest/terminal-snapshot")
                    .header("host", "127.0.0.1:9")
                    .header("authorization", "Bearer test-ingest-token-please")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        unsafe {
            match prev {
                Some(v) => std::env::set_var("ECONOMY_INGEST_TOKEN", v),
                None => std::env::remove_var("ECONOMY_INGEST_TOKEN"),
            }
        }
        assert_eq!(res.status(), StatusCode::CREATED, "{:?}", res.status());
        let v = json_body(res).await;
        assert_eq!(v["snapshot"]["created_by"], "datarunner");
        assert_eq!(v["snapshot"]["captured_at"], 1_700_000_000_000_i64);
    }

    fn authed(method: &str, uri: &str, cookie: &str, body: Option<&str>) -> Request<Body> {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("host", "localhost:3000")
            .header("origin", "http://localhost:3000")
            .header("cookie", cookie);
        if body.is_some() {
            builder = builder.header("content-type", "application/json");
        }
        builder
            .body(Body::from(body.unwrap_or("").to_string()))
            .unwrap()
    }

    async fn json_body(res: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(res.into_body(), 256 * 1024)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    }

    #[tokio::test]
    async fn seek_profile_and_economy_match_node_status() {
        let (dir, state) = music_state();
        let station = state.station.clone().unwrap();
        station
            .player
            .play("https://example.invalid/track.mp3", 0.0, 180.0);
        let bot_id = state.bot_id.clone();
        let (app, cookie) = setup_cookie(router(state)).await;

        let missing = app
            .clone()
            .oneshot(authed(
                "POST",
                &format!("/api/player/{bot_id}/seek"),
                &cookie,
                Some(r#"{"position":-1}"#),
            ))
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::BAD_REQUEST);
        let missing_body = json_body(missing).await;
        assert_eq!(missing_body["code"], "VALIDATION_ERROR");

        let sought = app
            .clone()
            .oneshot(authed(
                "POST",
                &format!("/api/player/{bot_id}/seek"),
                &cookie,
                Some(r#"{"position":12.5}"#),
            ))
            .await
            .unwrap();
        assert_eq!(sought.status(), StatusCode::OK);
        let sought_body = json_body(sought).await;
        assert_eq!(sought_body["message"], "Seeked to 12s");
        assert_eq!(sought_body["seekOffset"], 12.5);
        assert!((station.player.get_elapsed() - 12.5).abs() < 0.01);

        let unauth = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/player/{bot_id}/seek"))
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .body(Body::from(r#"{"position":1}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);

        let put = app
            .clone()
            .oneshot(authed(
                "PUT",
                &format!("/api/player/{bot_id}/profile"),
                &cookie,
                Some(r#"{"awayStatusEnabled":false,"nowPlayingMsgEnabled":false}"#),
            ))
            .await
            .unwrap();
        assert_eq!(put.status(), StatusCode::OK);
        let profile = json_body(put).await;
        assert_eq!(profile["avatarEnabled"], true);
        assert_eq!(profile["awayStatusEnabled"], false);
        assert_eq!(profile["nowPlayingMsgEnabled"], false);
        assert_eq!(profile["nicknameEnabled"], true);

        let got = app
            .clone()
            .oneshot(authed(
                "GET",
                &format!("/api/player/{bot_id}/profile"),
                &cookie,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(got.status(), StatusCode::OK);
        let got_body = json_body(got).await;
        assert_eq!(got_body["awayStatusEnabled"], false);

        let refreshed = app
            .clone()
            .oneshot(authed(
                "POST",
                "/api/economy/cache/refresh",
                &cookie,
                Some("{}"),
            ))
            .await
            .unwrap();
        assert_eq!(refreshed.status(), StatusCode::OK);
        let refresh_body = json_body(refreshed).await;
        assert_eq!(refresh_body["ok"], true);
        assert!(refresh_body["at"].as_i64().unwrap_or(0) > 0);
        assert_eq!(refresh_body["results"][0]["source"], "seed");
        assert_eq!(refresh_body["results"][0]["ok"], true);
        let cache = app
            .clone()
            .oneshot(authed("GET", "/api/economy/cache", &cookie, None))
            .await
            .unwrap();
        assert_eq!(cache.status(), StatusCode::OK);
        let cache_body = json_body(cache).await;
        assert!(cache_body["lastRefresh"]["at"].as_i64().unwrap_or(0) > 0);
        assert!(cache_body.get("root").is_none());

        let bad_snap = app
            .clone()
            .oneshot(authed(
                "POST",
                "/api/economy/ingest/terminal-snapshot",
                &cookie,
                Some(r#"{"type":"commodity"}"#),
            ))
            .await
            .unwrap();
        assert_eq!(bad_snap.status(), StatusCode::BAD_REQUEST);
        let bad_body = json_body(bad_snap).await;
        assert!(
            bad_body["error"]
                .as_str()
                .unwrap_or("")
                .contains("id_terminal"),
            "{bad_body}"
        );

        let snap = r#"{"source":"datarunner","game_version":"4.10.0","environment":"LIVE","id_terminal":89,"terminal_name":"Area 18 TDD","type":"commodity","captured_at":4102444800000,"prices":[{"name":"Agricium","price_buy":4000,"price_sell":12000}]}"#;
        let created = app
            .clone()
            .oneshot(authed(
                "POST",
                "/api/economy/ingest/terminal-snapshot",
                &cookie,
                Some(snap),
            ))
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::CREATED);
        let created_body = json_body(created).await;
        assert_eq!(created_body["snapshot"]["id_terminal"], 89);
        assert_eq!(created_body["snapshot"]["status"], "accepted");
        let snap_id = created_body["snapshot"]["id"].as_i64().unwrap();

        let listed = app
            .clone()
            .oneshot(authed(
                "GET",
                "/api/economy/ingest/snapshots?status=accepted",
                &cookie,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let listed_body = json_body(listed).await;
        assert!(listed_body["count"].as_u64().unwrap_or(0) >= 1);

        let missing_id = app
            .clone()
            .oneshot(authed(
                "POST",
                "/api/economy/ingest/snapshots/999999/reject",
                &cookie,
                Some("{}"),
            ))
            .await
            .unwrap();
        assert_eq!(missing_id.status(), StatusCode::NOT_FOUND);
        let missing_snap = json_body(missing_id).await;
        assert_eq!(missing_snap["error"], "No snapshot #999999");

        let priced = app
            .clone()
            .oneshot(authed(
                "GET",
                "/api/economy/prices?q=Agricium",
                &cookie,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(priced.status(), StatusCode::OK);
        let price_body = json_body(priced).await;
        assert_eq!(price_body["source"], "local");
        assert_eq!(price_body["sell"].as_f64(), Some(12000.0));

        let rejected = app
            .clone()
            .oneshot(authed(
                "POST",
                &format!("/api/economy/ingest/snapshots/{snap_id}/reject"),
                &cookie,
                Some("{}"),
            ))
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::OK);
        let rejected_body = json_body(rejected).await;
        assert_eq!(rejected_body["snapshot"]["status"], "rejected");

        let trade_on = mp_economy::clients().sc_trade.is_enabled();
        let buyers = app
            .clone()
            .oneshot(authed(
                "POST",
                "/api/economy/trade/buyers",
                &cookie,
                Some("{}"),
            ))
            .await
            .unwrap();
        if trade_on {
            assert_eq!(buyers.status(), StatusCode::BAD_REQUEST);
            let buyers_body = json_body(buyers).await;
            assert_eq!(buyers_body["error"], "commodity required");
        } else {
            assert_eq!(buyers.status(), StatusCode::SERVICE_UNAVAILABLE);
        }
        let circuit = app
            .clone()
            .oneshot(authed(
                "POST",
                "/api/economy/trade/circuit",
                &cookie,
                Some("{}"),
            ))
            .await
            .unwrap();
        if trade_on {
            assert_eq!(circuit.status(), StatusCode::BAD_REQUEST);
            let circuit_body = json_body(circuit).await;
            assert_eq!(
                circuit_body["error"],
                "id required (trade route id from routes results)"
            );
        } else {
            assert_eq!(circuit.status(), StatusCode::SERVICE_UNAVAILABLE);
        }
        let itinerary = app
            .clone()
            .oneshot(authed(
                "POST",
                "/api/economy/trade/itinerary",
                &cookie,
                Some(r#"{"from":""}"#),
            ))
            .await
            .unwrap();
        if trade_on {
            assert_eq!(itinerary.status(), StatusCode::BAD_REQUEST);
            let itinerary_body = json_body(itinerary).await;
            assert!(
                itinerary_body["error"]
                    .as_str()
                    .unwrap_or("")
                    .contains("from and to"),
                "{itinerary_body}"
            );
        } else {
            assert_eq!(itinerary.status(), StatusCode::SERVICE_UNAVAILABLE);
        }

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn stream_speaks_the_first_sentence_before_later_tokens_arrive() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;
        let first_sentence = Arc::new(AtomicBool::new(false));
        let gate = Arc::clone(&first_sentence);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let saw_stream = Arc::new(AtomicBool::new(false));
        let saw_stream_srv = Arc::clone(&saw_stream);
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let mut got = String::new();
            loop {
                let n = sock.read(&mut buf).await.unwrap();
                if n == 0 {
                    return;
                }
                got.push_str(&String::from_utf8_lossy(&buf[..n]));
                if got.contains("\r\n\r\n") {
                    break;
                }
            }
            saw_stream_srv.store(got.contains("\"stream\":true"), Ordering::SeqCst);
            let header = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/event-stream\r\n\r\n";
            sock.write_all(header.as_bytes()).await.unwrap();
            let first = "data: {\"choices\":[{\"delta\":{\"content\":\"Hello team. \"}}]}\n\n";
            let chunk = format!("{:x}\r\n{first}\r\n", first.len());
            sock.write_all(chunk.as_bytes()).await.unwrap();
            let _ = sock.flush().await;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            while !gate.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            assert!(
                gate.load(Ordering::SeqCst),
                "first sentence was not spoken before the rest of the tokens"
            );
            let rest = "data: {\"choices\":[{\"delta\":{\"content\":\"Still working\"}}]}\n\ndata: [DONE]\n\n";
            let chunk = format!("{:x}\r\n{rest}\r\n", rest.len());
            sock.write_all(chunk.as_bytes()).await.unwrap();
            sock.write_all(b"0\r\n\r\n").await.unwrap();
        });
        let mut settings = mp_brain::LlmSettings::default();
        settings.enabled = true;
        settings.url = format!("http://{}", addr);
        settings.model = "test".into();
        settings.timeout_ms = 5_000;
        let llm = mp_brain::OpenAiLlm::from_settings(&settings);
        let buf = Arc::new(std::sync::Mutex::new(String::new()));
        let spoken = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let flag = Arc::clone(&first_sentence);
        let buf_cb = Arc::clone(&buf);
        let spoken_cb = Arc::clone(&spoken);
        let text = llm
            .stream_user_prompt("hi", move |delta| {
                let ready = {
                    let mut b = buf_cb.lock().expect("buf");
                    mp_voice::push_stream_delta(&mut b, delta)
                };
                for sentence in ready {
                    if sentence.contains("Hello team") {
                        flag.store(true, Ordering::SeqCst);
                    }
                    spoken_cb.lock().expect("spoken").push(sentence);
                }
            })
            .await
            .unwrap();
        assert!(
            saw_stream.load(Ordering::SeqCst),
            "request did not set stream true"
        );
        assert!(text.contains("Hello team"));
        assert!(text.contains("Still working"));
        let spoken = spoken.lock().unwrap().clone();
        assert_eq!(spoken.first().map(String::as_str), Some("Hello team."));
    }
}
