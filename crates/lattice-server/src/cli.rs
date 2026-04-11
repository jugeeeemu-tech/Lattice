use std::{path::PathBuf, sync::Arc};

use anyhow::Result;
use clap::{Parser, Subcommand, ValueEnum};
use lattice_core::{load_config, resolve_config_path, DiscoveryEngine};
use tokio::net::TcpListener;
use tokio::sync::Semaphore;
use tracing::info;

use crate::{
    api::{
        routes::{build_router, build_static_router, AccessPolicy},
        AppState, DiscoveryCoordinator, StaticAppState, ViewSnapshot,
    },
    observability::init_tracing,
    serve::serve_router,
};

#[derive(Debug, Parser)]
#[command(
    name = "lattice",
    version,
    about = "Dynamic network topology explorer",
    long_about = None
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    /// Run one discovery pass and print the resulting topology.
    Discover {
        /// Path to the lattice configuration file. When omitted, lattice looks in standard locations.
        #[arg(long)]
        config: Option<PathBuf>,
        /// Output format for the discovered topology.
        #[arg(long, value_enum, default_value_t = OutputFormat::Json)]
        output: OutputFormat,
    },
    /// Start the live topology server backed by discovery sources.
    Serve {
        /// Path to the lattice configuration file. When omitted, lattice looks in standard locations.
        #[arg(long)]
        config: Option<PathBuf>,
        /// Override the listen host from the configuration file.
        #[arg(long)]
        host: Option<String>,
        /// Override the listen port from the configuration file.
        #[arg(long)]
        port: Option<u16>,
    },
    /// Start the UI with a saved topology snapshot instead of live discovery.
    ServeSnapshot {
        /// Path to a saved ViewSnapshot JSON file.
        #[arg(long)]
        snapshot: PathBuf,
        /// Host interface to bind the snapshot viewer to.
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        /// TCP port to bind the snapshot viewer to.
        #[arg(long, default_value_t = 8080)]
        port: u16,
        /// Explicit browser origins that may access the viewer when binding to a non-loopback host.
        #[arg(long = "allow-origin")]
        allow_origins: Vec<String>,
        /// Maximum concurrent websocket clients.
        #[arg(long, default_value_t = 64)]
        max_websocket_connections: usize,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum OutputFormat {
    Json,
}

pub async fn run() -> Result<()> {
    match Cli::parse().command {
        Commands::Discover { config, output } => run_discover(config, output).await,
        Commands::Serve { config, host, port } => run_serve(config, host, port).await,
        Commands::ServeSnapshot {
            snapshot,
            host,
            port,
            allow_origins,
            max_websocket_connections,
        } => {
            run_serve_snapshot(
                snapshot,
                host,
                port,
                allow_origins,
                max_websocket_connections,
            )
            .await
        }
    }
}

async fn run_discover(config_path: Option<PathBuf>, output: OutputFormat) -> Result<()> {
    let config_path = resolve_config_path(config_path)?;
    let config = load_config(config_path)?;
    let engine = DiscoveryEngine::new(
        config.discovery.clone(),
        config.sources.clone(),
        config.topology_hints.clone(),
    );
    let result = engine.discover().await?;

    match output {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&result.topology)?);
        }
    }

    Ok(())
}

async fn run_serve(
    config_path: Option<PathBuf>,
    host_override: Option<String>,
    port_override: Option<u16>,
) -> Result<()> {
    init_tracing();

    let config_path = resolve_config_path(config_path)?;
    let mut config = load_config(config_path)?;
    if let Some(host) = host_override {
        config.server.host = host;
    }
    if let Some(port) = port_override {
        config.server.port = port;
    }

    let bind_addr = config.server.listen_addr();
    let access_policy = AccessPolicy::for_bind_target(
        &config.server.host,
        config.server.port,
        &config.server.allowed_origins,
    )?;
    let engine = Arc::new(DiscoveryEngine::new(
        config.discovery.clone(),
        config.sources.clone(),
        config.topology_hints.clone(),
    ));
    let coordinator = Arc::new(DiscoveryCoordinator::new(
        engine,
        config.discovery.auto_discovery_interval_seconds,
        config.discovery.manual_discovery_cooldown_seconds,
    ));
    coordinator.start();

    let listener = TcpListener::bind(&bind_addr).await?;
    info!(listen_addr = %bind_addr, "lattice server listening");

    let state = AppState {
        coordinator,
        access_policy,
        websocket_slots: Arc::new(Semaphore::new(config.server.max_websocket_connections)),
    };
    serve_router(
        listener,
        build_router(state),
        std::time::Duration::from_secs(config.server.request_header_timeout_seconds.max(1)),
    )
    .await?;

    Ok(())
}

async fn run_serve_snapshot(
    snapshot_path: PathBuf,
    host: String,
    port: u16,
    allow_origins: Vec<String>,
    max_websocket_connections: usize,
) -> Result<()> {
    init_tracing();

    let snapshot = load_snapshot(snapshot_path)?;
    let access_policy = AccessPolicy::for_bind_target(&host, port, &allow_origins)?;
    let bind_addr = format!("{host}:{port}");
    let listener = TcpListener::bind(&bind_addr).await?;
    info!(listen_addr = %bind_addr, "lattice snapshot viewer listening");

    let state = StaticAppState {
        snapshot: Arc::new(snapshot),
        access_policy,
        websocket_slots: Arc::new(Semaphore::new(max_websocket_connections)),
    };
    serve_router(
        listener,
        build_static_router(state),
        std::time::Duration::from_secs(5),
    )
    .await?;

    Ok(())
}

fn load_snapshot(snapshot_path: PathBuf) -> Result<ViewSnapshot> {
    let raw = std::fs::read_to_string(&snapshot_path)?;
    let snapshot = serde_json::from_str::<ViewSnapshot>(&raw)?;
    Ok(snapshot.sanitize_for_transport())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn help_lists_global_flags() {
        let help = Cli::command().render_help().to_string();

        assert!(help.contains("Dynamic network topology explorer"));
        assert!(help.contains("-h, --help"));
        assert!(help.contains("-V, --version"));
    }

    #[test]
    fn version_flag_is_accepted() {
        let error = Cli::try_parse_from(["lattice", "--version"]).unwrap_err();

        assert_eq!(error.kind(), clap::error::ErrorKind::DisplayVersion);
        assert!(error.to_string().contains(env!("CARGO_PKG_VERSION")));
    }
}
