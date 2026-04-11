use std::sync::Arc;

use super::{
    routes::{AppState, StaticAppState},
    DiscoveryEvent,
};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
};
use tracing::{info, warn};

pub async fn topology_socket(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    info!("websocket upgrade requested");
    ws.on_upgrade(move |socket| handle_socket(socket, state.coordinator))
}

pub async fn static_topology_socket(
    ws: WebSocketUpgrade,
    State(state): State<StaticAppState>,
) -> impl IntoResponse {
    info!("static websocket upgrade requested");
    ws.on_upgrade(move |socket| handle_static_socket(socket, state.snapshot))
}

async fn handle_socket(mut socket: WebSocket, coordinator: Arc<super::DiscoveryCoordinator>) {
    info!("websocket connected");

    if send_snapshot(&mut socket, &coordinator).await.is_err() {
        warn!("websocket closed before initial snapshot could be sent");
        return;
    }

    let mut receiver = coordinator.subscribe();
    loop {
        match receiver.recv().await {
            Ok(DiscoveryEvent::Started)
            | Ok(DiscoveryEvent::Completed)
            | Ok(DiscoveryEvent::Failed) => {
                if send_snapshot(&mut socket, &coordinator).await.is_err() {
                    warn!("websocket snapshot send failed after discovery event");
                    break;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                warn!("websocket receiver lagged; sending the latest snapshot");
                if send_snapshot(&mut socket, &coordinator).await.is_err() {
                    warn!("websocket snapshot send failed after lag");
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

async fn handle_static_socket(mut socket: WebSocket, snapshot: Arc<super::ViewSnapshot>) {
    info!("static websocket connected");

    if send_static_snapshot(&mut socket, snapshot.as_ref())
        .await
        .is_err()
    {
        warn!("static websocket closed before initial snapshot could be sent");
        return;
    }

    while let Some(message) = socket.recv().await {
        match message {
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(error) => {
                warn!(error = %error, "static websocket receive failed");
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
