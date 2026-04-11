use std::time::Duration;
use std::{collections::BTreeSet, net::IpAddr, sync::Arc};

use anyhow::{bail, Context};
use axum::{
    body::Body,
    extract::{Host, MatchedPath, Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use serde::Serialize;
use tokio::sync::Semaphore;
use tower_http::{classify::ServerErrorsFailureClass, trace::TraceLayer};
use tracing::{info_span, Level};

use super::{
    frontend_assets,
    ws::{static_topology_socket, topology_socket},
    DiscoveryCoordinator, ManualDiscoveryRequest, ViewDevice, ViewSnapshot,
};

const MAX_DEVICE_LIST_RESPONSE: usize = 1024;

#[derive(Clone)]
pub struct AppState {
    pub coordinator: Arc<DiscoveryCoordinator>,
    pub access_policy: AccessPolicy,
    pub websocket_slots: Arc<Semaphore>,
}

#[derive(Clone)]
pub struct StaticAppState {
    pub snapshot: Arc<ViewSnapshot>,
    pub access_policy: AccessPolicy,
    pub websocket_slots: Arc<Semaphore>,
}

pub trait AccessControlledState {
    fn access_policy(&self) -> &AccessPolicy;
}

impl AccessControlledState for AppState {
    fn access_policy(&self) -> &AccessPolicy {
        &self.access_policy
    }
}

impl AccessControlledState for StaticAppState {
    fn access_policy(&self) -> &AccessPolicy {
        &self.access_policy
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccessPolicy {
    allowed_hosts: BTreeSet<String>,
    allowed_origins: BTreeSet<String>,
}

impl AccessPolicy {
    pub fn for_bind_target(
        host: &str,
        port: u16,
        allowed_origins: &[String],
    ) -> anyhow::Result<Self> {
        let normalized_host = host.trim().to_ascii_lowercase();
        if normalized_host.is_empty() {
            bail!("server.host must not be empty");
        }

        let mut allowed_hosts = BTreeSet::new();
        let mut normalized_origins = BTreeSet::new();

        if is_loopback_bind_host(&normalized_host) {
            allowed_hosts.insert(format!("127.0.0.1:{port}"));
            allowed_hosts.insert(format!("localhost:{port}"));
            normalized_origins.insert(format!("http://127.0.0.1:{port}"));
            normalized_origins.insert(format!("http://localhost:{port}"));

            if normalized_host == "::1" || normalized_host == "[::1]" {
                allowed_hosts.insert(format!("[::1]:{port}"));
                normalized_origins.insert(format!("http://[::1]:{port}"));
            }
        } else if allowed_origins.is_empty() {
            bail!(
                "non-loopback bind host `{host}` requires server.allowed_origins (or --allow-origin for serve-snapshot)"
            );
        }

        for origin in allowed_origins {
            let normalized_origin = normalize_origin(origin)?;
            let authority = origin_authority(&normalized_origin)
                .context("normalized origin did not contain an authority")?;
            let authority = authority.to_string();
            normalized_origins.insert(normalized_origin);
            allowed_hosts.insert(authority);
        }

        Ok(Self {
            allowed_hosts,
            allowed_origins: normalized_origins,
        })
    }

    pub fn ensure_request_allowed(
        &self,
        host: &str,
        headers: &HeaderMap,
    ) -> Result<(), StatusCode> {
        self.ensure_host_allowed(host)?;

        let Some(origin) = headers.get(header::ORIGIN) else {
            return Ok(());
        };

        let origin = origin.to_str().map_err(|_| StatusCode::FORBIDDEN)?;
        let normalized_origin = normalize_origin(origin).map_err(|_| StatusCode::FORBIDDEN)?;
        let origin_authority = origin_authority(&normalized_origin).ok_or(StatusCode::FORBIDDEN)?;
        let normalized_host = normalize_host(host).ok_or(StatusCode::BAD_REQUEST)?;

        if !self.allowed_origins.contains(&normalized_origin) {
            return Err(StatusCode::FORBIDDEN);
        }

        if origin_authority != normalized_host {
            return Err(StatusCode::FORBIDDEN);
        }

        Ok(())
    }

    fn ensure_host_allowed(&self, host: &str) -> Result<(), StatusCode> {
        let normalized_host = normalize_host(host).ok_or(StatusCode::BAD_REQUEST)?;
        if self.allowed_hosts.contains(&normalized_host) {
            return Ok(());
        }
        Err(StatusCode::FORBIDDEN)
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum PostDiscoverResponse {
    Busy,
    RateLimited { retry_after_seconds: u64 },
    Started { snapshot: ViewSnapshot },
}

pub fn build_router(state: AppState) -> Router {
    frontend_router()
        .route("/api/topology", get(get_topology))
        .route("/api/devices", get(get_devices))
        .route("/api/discover", post(post_discover))
        .route("/ws/topology", get(topology_socket))
        .with_state(state)
}

pub fn build_static_router(state: StaticAppState) -> Router {
    frontend_router()
        .route("/api/topology", get(get_static_topology))
        .route("/api/devices", get(get_static_devices))
        .route("/api/discover", post(post_discover_static))
        .route("/ws/topology", get(static_topology_socket))
        .with_state(state)
}

fn frontend_router<S>() -> Router<S>
where
    S: AccessControlledState + Clone + Send + Sync + 'static,
{
    let trace_layer = TraceLayer::new_for_http()
        .make_span_with(|request: &axum::http::Request<Body>| {
            let matched_path = request
                .extensions()
                .get::<MatchedPath>()
                .map(MatchedPath::as_str)
                .unwrap_or_else(|| request.uri().path());

            info_span!(
                "http_request",
                method = %request.method(),
                matched_path = %matched_path,
                status = tracing::field::Empty,
                latency_ms = tracing::field::Empty,
            )
        })
        .on_response(
            |response: &Response, latency: Duration, span: &tracing::Span| {
                span.record(
                    "status",
                    tracing::field::display(response.status().as_u16()),
                );
                span.record("latency_ms", latency.as_millis());

                tracing::event!(
                    parent: span,
                    Level::INFO,
                    status = response.status().as_u16(),
                    latency_ms = latency.as_millis(),
                    "http request completed"
                );
            },
        )
        .on_failure(
            |error: ServerErrorsFailureClass, latency: Duration, span: &tracing::Span| {
                span.record("latency_ms", latency.as_millis());

                tracing::event!(
                    parent: span,
                    Level::ERROR,
                    failure_class = %error,
                    latency_ms = latency.as_millis(),
                    "http request failed"
                );
            },
        );

    Router::<S>::new()
        .route("/health", get(health::<S>))
        .route("/", get(index_html::<S>))
        .route("/*asset_path", get(static_asset::<S>))
        .layer(trace_layer)
}

async fn health<S>(Host(host): Host, headers: HeaderMap, State(state): State<S>) -> Response
where
    S: AccessControlledState + Clone + Send + Sync + 'static,
{
    if let Err(response) = require_request_allowed(state.access_policy(), &host, &headers) {
        return response;
    }

    harden_response("ok".into_response())
}

async fn get_topology(
    Host(host): Host,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    if let Err(response) = require_request_allowed(&state.access_policy, &host, &headers) {
        return response;
    }

    api_response(Json(state.coordinator.current_snapshot().await).into_response())
}

async fn get_devices(
    Host(host): Host,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    if let Err(response) = require_request_allowed(&state.access_policy, &host, &headers) {
        return response;
    }

    let snapshot = state.coordinator.current_snapshot().await;
    api_response(Json(device_list_response(&snapshot)).into_response())
}

async fn get_static_topology(
    Host(host): Host,
    headers: HeaderMap,
    State(state): State<StaticAppState>,
) -> Response {
    if let Err(response) = require_request_allowed(&state.access_policy, &host, &headers) {
        return response;
    }

    api_response(Json((*state.snapshot).clone()).into_response())
}

async fn get_static_devices(
    Host(host): Host,
    headers: HeaderMap,
    State(state): State<StaticAppState>,
) -> Response {
    if let Err(response) = require_request_allowed(&state.access_policy, &host, &headers) {
        return response;
    }

    api_response(Json(device_list_response(&state.snapshot)).into_response())
}

fn device_list_response(snapshot: &ViewSnapshot) -> Vec<ViewDevice> {
    snapshot
        .devices
        .iter()
        .take(MAX_DEVICE_LIST_RESPONSE)
        .cloned()
        .collect()
}

async fn post_discover(
    Host(host): Host,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    if let Err(response) = require_request_allowed(&state.access_policy, &host, &headers) {
        return response;
    }

    let (request, snapshot) = state.coordinator.trigger_manual_discovery().await;
    let response = match (request, snapshot) {
        (ManualDiscoveryRequest::Started, Some(snapshot)) => (
            StatusCode::ACCEPTED,
            Json(PostDiscoverResponse::Started { snapshot }),
        )
            .into_response(),
        (ManualDiscoveryRequest::Busy, _) => {
            (StatusCode::OK, Json(PostDiscoverResponse::Busy)).into_response()
        }
        (
            ManualDiscoveryRequest::Cooldown {
                retry_after_seconds,
            },
            _,
        ) => {
            let mut response = (
                StatusCode::TOO_MANY_REQUESTS,
                Json(PostDiscoverResponse::RateLimited {
                    retry_after_seconds,
                }),
            )
                .into_response();
            response.headers_mut().insert(
                header::RETRY_AFTER,
                HeaderValue::from_str(&retry_after_seconds.to_string())
                    .unwrap_or_else(|_| HeaderValue::from_static("1")),
            );
            response
        }
        (ManualDiscoveryRequest::Started, None) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(PostDiscoverResponse::Busy),
        )
            .into_response(),
    };

    api_response(response)
}

async fn post_discover_static(
    Host(host): Host,
    headers: HeaderMap,
    State(state): State<StaticAppState>,
) -> Response {
    if let Err(response) = require_request_allowed(&state.access_policy, &host, &headers) {
        return response;
    }

    api_response((StatusCode::OK, Json(PostDiscoverResponse::Busy)).into_response())
}

async fn index_html<S>(Host(host): Host, headers: HeaderMap, State(state): State<S>) -> Response
where
    S: AccessControlledState + Clone + Send + Sync + 'static,
{
    if let Err(response) = require_request_allowed(state.access_policy(), &host, &headers) {
        return response;
    }

    html_response(Html(frontend_assets::index_html()).into_response())
}

async fn static_asset<S>(
    Host(host): Host,
    headers: HeaderMap,
    Path(asset_path): Path<String>,
    State(state): State<S>,
) -> Response
where
    S: AccessControlledState + Clone + Send + Sync + 'static,
{
    if let Err(response) = require_request_allowed(state.access_policy(), &host, &headers) {
        return response;
    }

    match frontend_assets::get(asset_path.trim_start_matches('/')) {
        Some(asset) => binary_response(asset.bytes, asset.content_type),
        None => harden_response(StatusCode::NOT_FOUND.into_response()),
    }
}

fn binary_response(body: &'static [u8], content_type: &'static str) -> Response {
    let mut response = Body::from(body).into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    harden_response(response)
}

fn api_response(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, max-age=0"),
    );
    harden_response(response)
}

fn html_response(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, max-age=0"),
    );
    harden_response(response)
}

fn harden_response(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        header::HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    response.headers_mut().insert(
        header::HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        ),
    );
    response.headers_mut().insert(
        header::HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    response.headers_mut().insert(
        header::HeaderName::from_static("cross-origin-opener-policy"),
        HeaderValue::from_static("same-origin"),
    );
    response
}

pub fn require_request_allowed(
    access_policy: &AccessPolicy,
    host: &str,
    headers: &HeaderMap,
) -> Result<(), Response> {
    access_policy
        .ensure_request_allowed(host, headers)
        .map_err(IntoResponse::into_response)
}

fn normalize_host(host: &str) -> Option<String> {
    let trimmed = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if trimmed.is_empty() {
        return None;
    }

    Some(trimmed)
}

fn normalize_origin(origin: &str) -> anyhow::Result<String> {
    let trimmed = origin.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("null") {
        bail!("origin must not be empty");
    }

    let (scheme, remainder) = trimmed
        .split_once("://")
        .context("origin must include a scheme")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        bail!("origin scheme must be http or https");
    }

    let authority = remainder
        .split('/')
        .next()
        .map(str::trim)
        .filter(|authority| !authority.is_empty())
        .context("origin must include an authority")?;
    let authority = normalize_host(authority).context("origin authority must not be empty")?;

    Ok(format!("{scheme}://{authority}"))
}

fn origin_authority(origin: &str) -> Option<&str> {
    let (_, remainder) = origin.split_once("://")?;
    remainder.split('/').next()
}

fn is_loopback_bind_host(host: &str) -> bool {
    if matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]") {
        return true;
    }

    host.parse::<IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use anyhow::Result;
    use async_trait::async_trait;
    use axum::{
        body::to_bytes,
        http::{Request, StatusCode},
    };
    use lattice_core::{
        DiscoveryConfig, DiscoveryEngine, DiscoveryResult, DiscoveryTree, Topology,
        TopologyHintsConfig,
    };
    use serde_json::Value;
    use tokio::{
        sync::Notify,
        time::{timeout, Duration},
    };
    use tower::ServiceExt;

    use super::*;
    use crate::api::{discovery_coordinator::DiscoveryRunner, DiscoveryEvent, DiscoveryStatus};

    fn test_access_policy() -> AccessPolicy {
        AccessPolicy::for_bind_target("127.0.0.1", 8080, &[]).unwrap()
    }

    fn test_state() -> AppState {
        let config = DiscoveryConfig::default();
        let engine = Arc::new(DiscoveryEngine::new(
            config.clone(),
            Vec::new(),
            TopologyHintsConfig::default(),
        ));
        let coordinator = Arc::new(DiscoveryCoordinator::new(
            engine,
            config.auto_discovery_interval_seconds,
            config.manual_discovery_cooldown_seconds,
        ));
        AppState {
            coordinator,
            access_policy: test_access_policy(),
            websocket_slots: Arc::new(Semaphore::new(64)),
        }
    }

    fn static_test_state() -> StaticAppState {
        StaticAppState {
            snapshot: Arc::new(ViewSnapshot::empty(DiscoveryStatus::ready(), 60, None)),
            access_policy: test_access_policy(),
            websocket_slots: Arc::new(Semaphore::new(64)),
        }
    }

    fn with_host(request: axum::http::request::Builder) -> axum::http::request::Builder {
        request.header(header::HOST, "127.0.0.1:8080")
    }

    #[derive(Clone)]
    struct BlockingRunner {
        entered: Arc<Notify>,
        release: Arc<Notify>,
    }

    #[derive(Clone)]
    struct ImmediateRunner;

    #[async_trait]
    impl DiscoveryRunner for BlockingRunner {
        async fn run_discovery(&self) -> Result<DiscoveryResult> {
            self.entered.notify_waiters();
            self.release.notified().await;
            Ok(DiscoveryResult {
                topology: Topology::default(),
                tree: DiscoveryTree::default(),
                relations: lattice_core::DiscoveryRelations::default(),
                warnings: Vec::new(),
                discovered_at: chrono::Utc::now(),
            })
        }
    }

    #[async_trait]
    impl DiscoveryRunner for ImmediateRunner {
        async fn run_discovery(&self) -> Result<DiscoveryResult> {
            Ok(DiscoveryResult {
                topology: Topology::default(),
                tree: DiscoveryTree::default(),
                relations: lattice_core::DiscoveryRelations::default(),
                warnings: Vec::new(),
                discovered_at: chrono::Utc::now(),
            })
        }
    }

    fn html_asset_paths(html: &str) -> Vec<&str> {
        let mut paths = Vec::new();
        let mut remainder = html;

        while let Some(start) = remainder.find("assets/") {
            let candidate = &remainder[start..];
            let end = candidate
                .find(|ch: char| matches!(ch, '"' | '\'' | '<' | '>' | ' ' | ')' | '('))
                .unwrap_or(candidate.len());
            let path = &candidate[..end];

            if !paths.contains(&path) {
                paths.push(path);
            }

            remainder = &candidate[end..];
        }

        paths
    }

    #[tokio::test]
    async fn root_serves_built_index_html() {
        let response = build_router(test_state())
            .oneshot(
                with_host(Request::builder().uri("/"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            HeaderValue::from_static("text/html; charset=utf-8")
        );
        assert_eq!(
            response.headers()["x-frame-options"],
            HeaderValue::from_static("DENY")
        );
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            HeaderValue::from_static("no-store, max-age=0")
        );

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body_text = String::from_utf8(body.to_vec()).unwrap();
        assert!(body_text.contains("Lattice Frontend Workspace"));
        let html_assets = html_asset_paths(&body_text);
        assert!(html_assets.iter().any(|path| path.ends_with(".js")));
        assert!(html_assets.iter().any(|path| path.ends_with(".css")));

        for asset_path in html_assets {
            assert!(
                frontend_assets::get(asset_path).is_some(),
                "expected {asset_path} referenced by index.html to be embedded"
            );
        }
    }

    #[tokio::test]
    async fn manifest_assets_are_embedded_with_content_types() {
        let router = build_router(test_state());

        let javascript_path = frontend_assets::manifest_asset_paths()
            .iter()
            .find(|path| path.ends_with(".js"))
            .copied()
            .expect("manifest should contain a javascript asset");
        let stylesheet_path = frontend_assets::manifest_asset_paths()
            .iter()
            .find(|path| path.ends_with(".css"))
            .copied()
            .expect("manifest should contain a stylesheet asset");

        for (path, expected_content_type) in [
            (javascript_path, "text/javascript; charset=utf-8"),
            (stylesheet_path, "text/css; charset=utf-8"),
        ] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/{path}"))
                        .header(header::HOST, "127.0.0.1:8080")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();

            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()[header::CONTENT_TYPE],
                HeaderValue::from_static(expected_content_type)
            );

            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert!(!body.is_empty());
            assert!(
                frontend_assets::get(path).is_some(),
                "expected {path} to be embedded"
            );
        }
    }

    #[tokio::test]
    async fn missing_static_asset_returns_not_found() {
        let response = build_router(test_state())
            .oneshot(
                with_host(Request::builder().uri("/assets/does-not-exist.js"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn public_api_routes_remain_available() {
        let router = build_router(test_state());

        let health = router
            .clone()
            .oneshot(
                with_host(Request::builder().uri("/health"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);

        let topology = router
            .clone()
            .oneshot(
                with_host(Request::builder().uri("/api/topology"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(topology.status(), StatusCode::OK);
        assert_eq!(
            topology.headers()[header::CACHE_CONTROL],
            HeaderValue::from_static("no-store, max-age=0")
        );

        let devices = router
            .clone()
            .oneshot(
                with_host(Request::builder().uri("/api/devices"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(devices.status(), StatusCode::OK);

        let discover = router
            .clone()
            .oneshot(
                with_host(Request::builder().method("POST").uri("/api/discover"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(discover.status(), StatusCode::ACCEPTED);
        let discover_body = to_bytes(discover.into_body(), usize::MAX).await.unwrap();
        let discover_json: Value = serde_json::from_slice(&discover_body).unwrap();
        assert_eq!(discover_json["status"], "started");
        assert_eq!(
            discover_json["snapshot"]["discovery_status"]["state"],
            "discovering"
        );

        let websocket = router
            .oneshot(
                with_host(Request::builder().uri("/ws/topology"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(websocket.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn static_snapshot_routes_remain_available() {
        let router = build_static_router(static_test_state());

        let health = router
            .clone()
            .oneshot(
                with_host(Request::builder().uri("/health"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);

        let topology = router
            .clone()
            .oneshot(
                with_host(Request::builder().uri("/api/topology"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(topology.status(), StatusCode::OK);

        let discover = router
            .clone()
            .oneshot(
                with_host(Request::builder().method("POST").uri("/api/discover"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(discover.status(), StatusCode::OK);
        let discover_body = to_bytes(discover.into_body(), usize::MAX).await.unwrap();
        let discover_json: Value = serde_json::from_slice(&discover_body).unwrap();
        assert_eq!(discover_json["status"], "busy");

        let websocket = router
            .oneshot(
                with_host(Request::builder().uri("/ws/topology"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(websocket.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn discover_returns_busy_while_a_manual_run_is_already_active() {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let coordinator = Arc::new(DiscoveryCoordinator::new(
            Arc::new(BlockingRunner {
                entered: Arc::clone(&entered),
                release: Arc::clone(&release),
            }),
            60,
            10,
        ));
        let router = build_router(AppState {
            coordinator,
            access_policy: test_access_policy(),
            websocket_slots: Arc::new(Semaphore::new(64)),
        });

        let started = router
            .clone()
            .oneshot(
                with_host(Request::builder().method("POST").uri("/api/discover"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(started.status(), StatusCode::ACCEPTED);
        timeout(Duration::from_secs(1), entered.notified())
            .await
            .expect("first discovery run should start");

        let busy = router
            .oneshot(
                with_host(Request::builder().method("POST").uri("/api/discover"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(busy.status(), StatusCode::OK);
        let busy_body = to_bytes(busy.into_body(), usize::MAX).await.unwrap();
        let busy_json: Value = serde_json::from_slice(&busy_body).unwrap();
        assert_eq!(busy_json, serde_json::json!({ "status": "busy" }));

        release.notify_waiters();
    }

    #[tokio::test]
    async fn static_devices_response_is_capped() {
        let router = build_static_router(StaticAppState {
            snapshot: Arc::new(ViewSnapshot {
                devices: (0..(MAX_DEVICE_LIST_RESPONSE + 10))
                    .map(|index| ViewDevice {
                        id: format!("device-{index}"),
                        label: format!("device-{index}"),
                        depth: 0,
                        device_role: lattice_core::DeviceRole::Unknown,
                        deployment_type: lattice_core::DeploymentType::Unknown,
                        guest_kind: None,
                        identity_keys: lattice_core::IdentityKeys::default(),
                        host_label: None,
                        upstream_interface: None,
                        default_upstream_device_id: None,
                    })
                    .collect(),
                links: Vec::new(),
                tree_rows: Vec::new(),
                tree_edges: Vec::new(),
                primary_row_by_device: Default::default(),
                root_device_ids: Vec::new(),
                device_relations: Default::default(),
                discovery_status: crate::api::view_snapshot::DiscoveryStatus::ready(),
                auto_discovery_interval_seconds: 60,
                next_auto_discovery_at_ms: None,
            }),
            access_policy: test_access_policy(),
            websocket_slots: Arc::new(Semaphore::new(64)),
        });

        let devices = router
            .oneshot(
                with_host(Request::builder().uri("/api/devices"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(devices.status(), StatusCode::OK);
        let body = to_bytes(devices.into_body(), usize::MAX).await.unwrap();
        let json: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json.as_array().unwrap().len(), MAX_DEVICE_LIST_RESPONSE);
    }

    #[tokio::test]
    async fn discover_returns_rate_limited_during_manual_cooldown() {
        let coordinator = Arc::new(DiscoveryCoordinator::new(Arc::new(ImmediateRunner), 60, 10));
        let router = build_router(AppState {
            coordinator: Arc::clone(&coordinator),
            access_policy: test_access_policy(),
            websocket_slots: Arc::new(Semaphore::new(64)),
        });
        let mut receiver = coordinator.subscribe();

        let first = router
            .clone()
            .oneshot(
                with_host(Request::builder().method("POST").uri("/api/discover"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::ACCEPTED);
        assert!(matches!(
            receiver.recv().await.unwrap(),
            DiscoveryEvent::Started
        ));
        assert!(matches!(
            receiver.recv().await.unwrap(),
            DiscoveryEvent::Completed
        ));

        let second = router
            .oneshot(
                with_host(Request::builder().method("POST").uri("/api/discover"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::TOO_MANY_REQUESTS);
        let retry_after = second.headers()[header::RETRY_AFTER]
            .to_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        assert!((9..=10).contains(&retry_after));
        let body = to_bytes(second.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["status"], "rate_limited");
        assert!(value["retry_after_seconds"]
            .as_u64()
            .is_some_and(|seconds| (9..=10).contains(&seconds)));
    }

    #[test]
    fn access_policy_allows_missing_origin_for_non_browser_clients() {
        let headers = HeaderMap::new();
        let policy = test_access_policy();
        assert_eq!(
            policy.ensure_request_allowed("127.0.0.1:8080", &headers),
            Ok(())
        );
    }

    #[test]
    fn access_policy_accepts_matching_loopback_origin() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://127.0.0.1:8080"),
        );
        let policy = test_access_policy();

        assert_eq!(
            policy.ensure_request_allowed("127.0.0.1:8080", &headers),
            Ok(())
        );
    }

    #[test]
    fn access_policy_rejects_cross_origin_requests() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://127.0.0.1:9001"),
        );
        let policy = test_access_policy();

        assert_eq!(
            policy.ensure_request_allowed("127.0.0.1:8080", &headers),
            Err(StatusCode::FORBIDDEN)
        );
    }

    #[test]
    fn access_policy_rejects_unexpected_host_even_when_origin_matches_it() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://evil.test:8080"),
        );
        let policy = test_access_policy();

        assert_eq!(
            policy.ensure_request_allowed("evil.test:8080", &headers),
            Err(StatusCode::FORBIDDEN)
        );
    }

    #[test]
    fn non_loopback_bind_requires_explicit_allowed_origins() {
        let error = AccessPolicy::for_bind_target("0.0.0.0", 8080, &[])
            .unwrap_err()
            .to_string();

        assert!(error.contains("requires server.allowed_origins"));
    }

    #[test]
    fn non_loopback_policy_accepts_configured_public_origin() {
        let policy = AccessPolicy::for_bind_target(
            "0.0.0.0",
            8080,
            &[String::from("https://lattice.example.internal")],
        )
        .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://lattice.example.internal"),
        );

        assert_eq!(
            policy.ensure_request_allowed("lattice.example.internal", &headers),
            Ok(())
        );
    }

    #[tokio::test]
    async fn discover_rejects_cross_origin_post_requests() {
        let response = build_router(test_state())
            .oneshot(
                with_host(Request::builder().method("POST").uri("/api/discover"))
                    .header(header::ORIGIN, "http://127.0.0.1:9001")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn topology_rejects_unconfigured_host_header() {
        let response = build_router(test_state())
            .oneshot(
                Request::builder()
                    .uri("/api/topology")
                    .header(header::HOST, "evil.test:8080")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn root_rejects_unconfigured_host_header() {
        let response = build_router(test_state())
            .oneshot(
                Request::builder()
                    .uri("/")
                    .header(header::HOST, "evil.test:8080")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
