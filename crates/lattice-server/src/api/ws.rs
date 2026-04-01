use std::sync::Arc;

use super::{routes::AppState, DiscoveryEvent};
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

async fn send_snapshot(
    socket: &mut WebSocket,
    coordinator: &Arc<super::DiscoveryCoordinator>,
) -> Result<(), axum::Error> {
    let snapshot = coordinator.current_snapshot().await;
    let payload = match serde_json::to_string(&snapshot) {
        Ok(payload) => payload,
        Err(error) => {
            warn!(error = %error, "failed to serialize websocket snapshot");
            "{}".to_string()
        }
    };
    socket.send(Message::Text(payload.into())).await
}
