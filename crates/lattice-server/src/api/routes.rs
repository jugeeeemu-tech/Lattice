use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Body,
    extract::{MatchedPath, Path, State},
    http::{header, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use lattice_core::Device;
use serde::Serialize;
use tower_http::{classify::ServerErrorsFailureClass, trace::TraceLayer};
use tracing::{info_span, Level};

use super::{frontend_assets, ws::topology_socket, DiscoveryCoordinator, ViewSnapshot};

#[derive(Clone)]
pub struct AppState {
    pub coordinator: Arc<DiscoveryCoordinator>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum PostDiscoverResponse {
    Busy,
    Started { snapshot: ViewSnapshot },
}

pub fn build_router(state: AppState) -> Router {
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

    Router::new()
        .route("/health", get(health))
        .route("/api/topology", get(get_topology))
        .route("/api/devices", get(get_devices))
        .route("/api/discover", post(post_discover))
        .route("/ws/topology", get(topology_socket))
        .route("/", get(index_html))
        .route("/*asset_path", get(static_asset))
        .layer(trace_layer)
        .with_state(state)
}

async fn health() -> &'static str {
    "ok"
}

async fn get_topology(State(state): State<AppState>) -> Json<ViewSnapshot> {
    Json(state.coordinator.current_snapshot().await)
}

async fn get_devices(State(state): State<AppState>) -> Json<Vec<Device>> {
    Json(state.coordinator.current_devices().await)
}

async fn post_discover(State(state): State<AppState>) -> Response {
    match state.coordinator.trigger_manual_discovery().await {
        Some(snapshot) => (
            StatusCode::ACCEPTED,
            Json(PostDiscoverResponse::Started { snapshot }),
        )
            .into_response(),
        None => (StatusCode::OK, Json(PostDiscoverResponse::Busy)).into_response(),
    }
}

async fn index_html() -> Html<&'static str> {
    Html(frontend_assets::index_html())
}

async fn static_asset(Path(asset_path): Path<String>) -> Response {
    match frontend_assets::get(asset_path.trim_start_matches('/')) {
        Some(asset) => binary_response(asset.bytes, asset.content_type),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn binary_response(body: &'static [u8], content_type: &'static str) -> Response {
    let mut response = Body::from(body).into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
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
    };
    use serde_json::Value;
    use tokio::{
        sync::Notify,
        time::{timeout, Duration},
    };
    use tower::ServiceExt;

    use super::*;
    use crate::api::discovery_coordinator::DiscoveryRunner;

    fn test_state() -> AppState {
        let config = DiscoveryConfig::default();
        let engine = Arc::new(DiscoveryEngine::new(config.clone(), Vec::new()));
        let coordinator = Arc::new(DiscoveryCoordinator::new(
            engine,
            config.auto_discovery_interval_seconds,
        ));
        AppState { coordinator }
    }

    #[derive(Clone)]
    struct BlockingRunner {
        entered: Arc<Notify>,
        release: Arc<Notify>,
    }

    #[async_trait]
    impl DiscoveryRunner for BlockingRunner {
        async fn run_discovery(&self) -> Result<DiscoveryResult> {
            self.entered.notify_waiters();
            self.release.notified().await;
            Ok(DiscoveryResult {
                topology: Topology::default(),
                tree: DiscoveryTree::default(),
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
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            HeaderValue::from_static("text/html; charset=utf-8")
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
                Request::builder()
                    .uri("/assets/does-not-exist.js")
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
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);

        let topology = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/topology")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(topology.status(), StatusCode::OK);

        let devices = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/devices")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(devices.status(), StatusCode::OK);

        let discover = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/discover")
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
                Request::builder()
                    .uri("/ws/topology")
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
        ));
        let router = build_router(AppState { coordinator });

        let started = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/discover")
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
                Request::builder()
                    .method("POST")
                    .uri("/api/discover")
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
}
