use std::sync::Arc;

use super::{routes::AppState, DiscoveryEvent};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
};

pub async fn topology_socket(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state.coordinator))
}

async fn handle_socket(mut socket: WebSocket, coordinator: Arc<super::DiscoveryCoordinator>) {
    if send_snapshot(&mut socket, &coordinator).await.is_err() {
        return;
    }

    let mut receiver = coordinator.subscribe();
    loop {
        match receiver.recv().await {
            Ok(DiscoveryEvent::Started)
            | Ok(DiscoveryEvent::Completed)
            | Ok(DiscoveryEvent::Failed) => {
                if send_snapshot(&mut socket, &coordinator).await.is_err() {
                    break;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                if send_snapshot(&mut socket, &coordinator).await.is_err() {
                    break;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
}

async fn send_snapshot(
    socket: &mut WebSocket,
    coordinator: &Arc<super::DiscoveryCoordinator>,
) -> Result<(), axum::Error> {
    let snapshot = coordinator.current_snapshot().await;
    let payload = serde_json::to_string(&snapshot).unwrap_or_else(|_| "{}".to_string());
    socket.send(Message::Text(payload.into())).await
}
