use std::{convert::Infallible, future::Future, io, time::Duration};

use axum::Router;
use hyper::{body::Incoming, server::conn::http1, service::service_fn, Request};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::TcpListener;
use tower::ServiceExt;
use tracing::{debug, warn};

pub async fn serve_router(
    listener: TcpListener,
    app: Router,
    request_header_timeout: Duration,
) -> io::Result<()> {
    serve_router_with_shutdown(
        listener,
        app,
        request_header_timeout,
        std::future::pending(),
    )
    .await
}

pub async fn serve_router_with_shutdown<F>(
    listener: TcpListener,
    app: Router,
    request_header_timeout: Duration,
    shutdown: F,
) -> io::Result<()>
where
    F: Future<Output = ()>,
{
    tokio::pin!(shutdown);

    loop {
        tokio::select! {
            _ = &mut shutdown => {
                break;
            }
            accept_result = listener.accept() => {
                let (stream, peer_addr) = accept_result?;
                let app = app.clone();
                tokio::spawn(async move {
                    let mut builder = http1::Builder::new();
                    builder.timer(TokioTimer::new());
                    builder.header_read_timeout(request_header_timeout);

                    let service = service_fn(move |request: Request<Incoming>| {
                        let app = app.clone();
                        async move {
                            let response = app
                                .oneshot(request)
                                .await
                                .expect("router service should be infallible");
                            Ok::<_, Infallible>(response)
                        }
                    });

                    let connection = builder
                        .serve_connection(TokioIo::new(stream), service)
                        .with_upgrades();
                    if let Err(error) = connection.await {
                        if error.to_string().contains("header read timeout") {
                            debug!(%peer_addr, "closing connection after request header timeout");
                        } else {
                            warn!(%peer_addr, "http connection failed: {error}");
                        }
                    }
                });
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{io, time::Duration};

    use axum::{routing::get, Router};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpStream,
        sync::oneshot,
        time::timeout,
    };

    use super::serve_router_with_shutdown;

    #[tokio::test]
    async fn closes_connections_that_do_not_finish_request_headers() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            serve_router_with_shutdown(
                listener,
                Router::new().route("/health", get(|| async { "ok" })),
                Duration::from_millis(50),
                async move {
                    let _ = shutdown_rx.await;
                },
            )
            .await
            .unwrap();
        });

        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream
            .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Test: ")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(120)).await;
        let _ = stream.write_all(b"still-open\r\n\r\n").await;

        let mut buffer = [0u8; 32];
        let result = timeout(Duration::from_secs(1), stream.read(&mut buffer))
            .await
            .unwrap();
        match result {
            Ok(0) => {}
            Ok(size) => panic!(
                "expected the server to close the slow connection, got {:?}",
                String::from_utf8_lossy(&buffer[..size])
            ),
            Err(error) => assert!(
                matches!(
                    error.kind(),
                    io::ErrorKind::ConnectionReset
                        | io::ErrorKind::BrokenPipe
                        | io::ErrorKind::UnexpectedEof
                ),
                "unexpected slow-connection read error: {error}"
            ),
        }

        let _ = shutdown_tx.send(());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn serves_complete_requests_before_the_timeout() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            serve_router_with_shutdown(
                listener,
                Router::new().route("/health", get(|| async { "ok" })),
                Duration::from_millis(200),
                async move {
                    let _ = shutdown_rx.await;
                },
            )
            .await
            .unwrap();
        });

        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream
            .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();

        let mut response = [0u8; 128];
        let size = timeout(Duration::from_secs(1), stream.read(&mut response))
            .await
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&response[..size]).starts_with("HTTP/1.1 200 OK"));

        let _ = shutdown_tx.send(());
        server.await.unwrap();
    }
}
