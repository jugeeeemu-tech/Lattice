use std::sync::Arc;

use axum::{
    extract::State,
    http::{header, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use lattice_core::Device;

use super::{ws::topology_socket, DiscoveryCoordinator, ViewSnapshot};

#[derive(Clone)]
pub struct AppState {
    pub coordinator: Arc<DiscoveryCoordinator>,
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/topology", get(get_topology))
        .route("/api/devices", get(get_devices))
        .route("/api/discover", post(post_discover))
        .route("/ws/topology", get(topology_socket))
        .route("/", get(index_html))
        .route("/app.js", get(app_js))
        .route("/style.css", get(style_css))
        .route("/vendor/three.module.js", get(three_module))
        .route("/vendor/OrbitControls.js", get(orbit_controls))
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

async fn post_discover(State(state): State<AppState>) -> impl IntoResponse {
    let _ = state.coordinator.trigger_manual_discovery();
    StatusCode::ACCEPTED
}

async fn index_html() -> Html<&'static str> {
    Html(include_str!("../frontend/index.html"))
}

async fn app_js() -> Response {
    javascript(include_str!("../frontend/app.js"))
}

async fn style_css() -> Response {
    text_response(
        include_str!("../frontend/style.css"),
        "text/css; charset=utf-8",
    )
}

async fn three_module() -> Response {
    javascript(include_str!("../frontend/vendor/three.module.js"))
}

async fn orbit_controls() -> Response {
    javascript(include_str!("../frontend/vendor/OrbitControls.js"))
}

fn javascript(body: &'static str) -> Response {
    text_response(body, "text/javascript; charset=utf-8")
}

fn text_response(body: &'static str, content_type: &'static str) -> Response {
    let mut response = body.into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
}
