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
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderName, HeaderValue};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Serialize;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tower_http::set_header::SetResponseHeaderLayer;
use tracing::info;

mod authz;
mod bot_api;
mod brain;
mod command;
mod csrf;
mod economy_api;
mod harness;
mod json_song;
mod mcp_api;
mod music_api;
mod openapi;
mod player_api;
mod radio_api;
mod rag_api;
mod rate_limit;
mod recordings;
mod roast;
mod session;
mod spa;
mod sc_org;
mod follow;
mod status_api;
mod stubs;
mod users_api;
mod voice_api;
mod ws;

pub use command::dispatch_command;
pub use follow::FollowRuntime;
pub use roast::RoastRuntime;
pub use sc_org::ScOrgRuntime;
pub use csrf::csrf_origin_check;
pub use session::SESSION_COOKIE_NAME;

use mp_config::BotConfig;
use mp_db::Database;
use rate_limit::RateLimiter;

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Database>,
    pub config: Arc<BotConfig>,
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
    pub follow: Arc<FollowRuntime>,
    pub sc_org: Arc<ScOrgRuntime>,
    login_limit: Arc<RateLimiter>,
    setup_limit: Arc<RateLimiter>,
}

impl AppState {
    pub fn new(db: Arc<Database>, config: Arc<BotConfig>, static_dir: Option<PathBuf>) -> Self {
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
        Self {
            db,
            config,
            started: Instant::now(),
            static_dir,
            station: None,
            executor: None,
            rights: None,
            bot_id: std::env::var("BOT_ID")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "default".into()),
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
            follow,
            sc_org,
            login_limit: Arc::new(RateLimiter::new(5, 5.0 / 60.0)),
            setup_limit: Arc::new(RateLimiter::new(3, 3.0 / 60.0)),
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
            self.radio
                .set_bumper_dir(mp_radio::default_bumper_dir(dir));
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
    let raw = st.config.public_url.trim().trim_end_matches('/');
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
        .route("/api/bot", get(bot_api::list_bots).post(bot_api::create_bot))
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
        .route("/api/bot/voice/status", get(voice_api::voice_status))
        .route("/api/bot/voice/test", post(voice_api::voice_test))
        .route("/api/bot/radio/status", get(radio_api::radio_status))
        .route("/api/bot/radio/test-bumper", post(radio_api::radio_test_bumper))
        .route("/api/bot/rag/status", get(status_api::rag_status))
        .route("/api/bot/memory/status", get(status_api::memory_status))
        .route("/api/bot/ace-step/status", get(stubs::bot_status_stub))
        .route("/api/bot/stream-bridge/status", get(status_api::stream_bridge_status))
        .route("/api/bot/ops/status", get(status_api::ops_status))
        .route("/api/bot/rights/debug", get(status_api::rights_debug))
        .route("/api/bot/voice/under-music-check", get(voice_api::under_music_check))
        .route("/api/bot/memory/scopes", get(status_api::memory_scopes))
        .route("/api/bot/memory/private", get(status_api::memory_private))
        .route("/api/bot/org-kg", get(status_api::org_kg_get).post(status_api::org_kg_post))
        .route("/api/bot/harness/turns", get(harness::harness_turns))
        .route("/api/bot/harness/ask", post(harness::harness_ask))
        .route("/api/bot/rag/eval", post(rag_api::rag_eval))
        .route("/api/bot/rag/query", post(rag_api::rag_query))
        .route("/api/bot/llm/ask", post(status_api::llm_ask))
        .route("/api/bot/{id}", get(bot_api::get_bot).delete(bot_api::delete_bot))
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
        .route("/api/music/blacklist/{id}", delete(music_api::blacklist_delete))
        .route("/api/music/tracks/{id}/tags", get(music_api::tags_get).patch(music_api::tags_patch))
        .route("/api/music/tracks/{id}/tags/guess", post(music_api::tags_guess))
        .route("/api/music/tracks/tags/bulk", axum::routing::patch(music_api::tags_bulk))
        .route("/api/music/tracks/{id}/rating", post(music_api::rating_post).delete(music_api::rating_delete))
        .route("/api/music/tracks/{id}", delete(music_api::track_delete))
        .route("/api/music/analyze/status", get(music_api::analyze_status))
        .route("/api/music/analyze", post(music_api::analyze_post))
        .route("/api/music/upload", post(music_api::music_upload))
        .route("/api/bot/ace-step/generate", post(stubs::not_ported))
        .route("/api/rag/doctrine/new", post(rag_api::doctrine_new))
        .route("/api/rag/doctrine/reindex", post(rag_api::doctrine_reindex))
        .route("/api/rag/doctrine/reformat", post(rag_api::doctrine_reformat))
        .route("/api/rag/query", post(rag_api::rag_query))
        .route("/api/rag/ingest", post(rag_api::rag_ingest))
        .route("/api/economy/workorders", get(economy_api::workorders_get).post(economy_api::workorders_post).delete(economy_api::workorders_clear))
        .route("/api/economy/workorders/{id}", delete(economy_api::workorders_delete_one))
        .route("/api/economy/cache/refresh", post(economy_api::cache_refresh))
        .route("/api/economy/trade/routes", post(economy_api::trade_routes))
        .route("/api/economy/trade/buyers", post(economy_api::trade_off))
        .route("/api/economy/trade/itinerary", post(economy_api::trade_off))
        .route("/api/economy/trade/circuit", post(economy_api::trade_off))
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
        .route("/api/player/{botId}/play-by-id", post(player_api::play_by_id))
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
        .route("/api/rag/doctrine/export/capabilities", get(rag_api::doctrine_export_caps))
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
        .route("/api/users", get(users_api::users_list).post(users_api::users_create))
        .route("/api/audit", get(session::audit_list))
        .route("/api/users/{id}", delete(users_api::users_delete))
        .route("/api/users/{id}/role", axum::routing::patch(users_api::users_role))
        .route("/api/users/{id}/reset-password", post(users_api::users_reset_password));

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
    let app = router(state);
    let listener = TcpListener::bind(addr).await?;
    info!(%addr, "http listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        use tokio::signal::unix::{signal, SignalKind};
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
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    fn test_app() -> Router {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let cfg = Arc::new(BotConfig::default());
        router(AppState::new(db, cfg, None))
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
                    .body(Body::from(r#"{"username":"admin","password":"password12"}"#))
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
                    .body(Body::from(r#"{"username":"admin","password":"password12"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let set_cookie = res.headers().get(header::SET_COOKIE).unwrap().to_str().unwrap();
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
                    .body(Body::from(r#"{"username":"admin","password":"password12"}"#))
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
                    .body(Body::from(r#"{"username":"admin","password":"password12"}"#))
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
        let res = app.oneshot(turn_post(&cookie, r#"{"text":"  "}"#)).await.unwrap();
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
        assert!(v["disposedTools"][0]["result"]
            .as_str()
            .unwrap_or("")
            .contains("[dry-run]"));
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
            v["chunks"].as_array().map(|a| !a.is_empty()).unwrap_or(false),
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
                    .body(Body::from(r#"{"transcript":"Moneypenny pause","speak":false}"#))
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
                    .body(Body::from(r#"{"name":"music_stop","arguments":{"confirm":true}}"#))
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
                    .body(Body::from(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#))
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
                    .body(Body::from(r#"{"llmEnabled":true,"llmUrl":"http://127.0.0.1:11434"}"#))
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

        let b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            b"RIFF....WEBM",
        );
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
}
