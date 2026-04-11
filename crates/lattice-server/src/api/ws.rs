use std::sync::Arc;

use super::{
    routes::require_request_allowed,
    routes::{AppState, StaticAppState},
    DiscoveryEvent,
};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Host, State,
    },
    http::HeaderMap,
    response::IntoResponse,
};
use tracing::{debug, info, warn};

const MAX_INCOMING_WEBSOCKET_MESSAGE_BYTES: usize = 64 * 1024;

pub async fn topology_socket(
    Host(host): Host,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    if let Err(response) = require_request_allowed(&state.access_policy, &host, &headers) {
        return response;
    }

    let Ok(permit) = state.websocket_slots.clone().try_acquire_owned() else {
        return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response();
    };

    info!("websocket upgrade requested");
    ws.max_message_size(MAX_INCOMING_WEBSOCKET_MESSAGE_BYTES)
        .max_frame_size(MAX_INCOMING_WEBSOCKET_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, state.coordinator, permit))
}

pub async fn static_topology_socket(
    Host(host): Host,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
    State(state): State<StaticAppState>,
) -> impl IntoResponse {
    if let Err(response) = require_request_allowed(&state.access_policy, &host, &headers) {
        return response;
    }

    let Ok(permit) = state.websocket_slots.clone().try_acquire_owned() else {
        return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response();
    };

    info!("static websocket upgrade requested");
    ws.max_message_size(MAX_INCOMING_WEBSOCKET_MESSAGE_BYTES)
        .max_frame_size(MAX_INCOMING_WEBSOCKET_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_static_socket(socket, state.snapshot, permit))
}

async fn handle_socket(
    mut socket: WebSocket,
    coordinator: Arc<super::DiscoveryCoordinator>,
    _permit: tokio::sync::OwnedSemaphorePermit,
) {
    info!("websocket connected");

    if let Err(error) = send_snapshot(&mut socket, &coordinator).await {
        log_websocket_error(
            &error,
            "websocket closed before initial snapshot could be sent",
        );
        return;
    }

    let mut receiver = coordinator.subscribe();
    loop {
        match receiver.recv().await {
            Ok(DiscoveryEvent::Started)
            | Ok(DiscoveryEvent::Completed)
            | Ok(DiscoveryEvent::Failed) => {
                if let Err(error) = send_snapshot(&mut socket, &coordinator).await {
                    log_websocket_error(
                        &error,
                        "websocket snapshot send failed after discovery event",
                    );
                    break;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                debug!("websocket receiver lagged; sending the latest snapshot");
                if let Err(error) = send_snapshot(&mut socket, &coordinator).await {
                    log_websocket_error(&error, "websocket snapshot send failed after lag");
                    break;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                info!("websocket subscription closed");
                break;
            }
        }
    }

    info!("websocket disconnected");
}

async fn handle_static_socket(
    mut socket: WebSocket,
    snapshot: Arc<super::ViewSnapshot>,
    _permit: tokio::sync::OwnedSemaphorePermit,
) {
    info!("static websocket connected");

    if let Err(error) = send_static_snapshot(&mut socket, snapshot.as_ref()).await {
        log_websocket_error(
            &error,
            "static websocket closed before initial snapshot could be sent",
        );
        return;
    }

    while let Some(message) = socket.recv().await {
        match message {
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(error) => {
                log_websocket_error(&error, "static websocket receive failed");
                break;
            }
        }
    }

    info!("static websocket disconnected");
}

async fn send_snapshot(
    socket: &mut WebSocket,
    coordinator: &Arc<super::DiscoveryCoordinator>,
) -> Result<(), axum::Error> {
    let snapshot = coordinator.current_snapshot().await;
    send_static_snapshot(socket, &snapshot).await
}

async fn send_static_snapshot(
    socket: &mut WebSocket,
    snapshot: &super::ViewSnapshot,
) -> Result<(), axum::Error> {
    let payload = serde_json::to_string(&snapshot).map_err(|error| {
        warn!(error = %error, "failed to serialize websocket snapshot");
        axum::Error::new(error)
    })?;
    socket.send(Message::Text(payload.into())).await
}

fn log_websocket_error(error: &impl std::fmt::Display, message: &str) {
    let error_text = error.to_string();
    if is_benign_websocket_disconnect(&error_text) {
        debug!(error = %error_text, "{message}");
    } else {
        warn!(error = %error_text, "{message}");
    }
}

fn is_benign_websocket_disconnect(error_text: &str) -> bool {
    let lowered = error_text.to_ascii_lowercase();
    lowered.contains("connection reset by peer")
        || lowered.contains("broken pipe")
        || lowered.contains("without closing handshake")
        || lowered.contains("connection closed normally")
}

#[cfg(test)]
mod tests {
    use super::is_benign_websocket_disconnect;

    #[test]
    fn classifies_common_disconnects_as_benign() {
        assert!(is_benign_websocket_disconnect(
            "IO error: Connection reset by peer (os error 104)"
        ));
        assert!(is_benign_websocket_disconnect(
            "WebSocket protocol error: Connection reset without closing handshake"
        ));
        assert!(is_benign_websocket_disconnect("broken pipe"));
    }

    #[test]
    fn keeps_unexpected_websocket_errors_loud() {
        assert!(!is_benign_websocket_disconnect(
            "failed to serialize websocket snapshot"
        ));
        assert!(!is_benign_websocket_disconnect("permission denied"));
    }
}
