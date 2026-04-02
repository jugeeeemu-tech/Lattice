use std::{path::PathBuf, sync::Arc};

use anyhow::Result;
use clap::{Parser, Subcommand, ValueEnum};
use lattice_core::{load_config, DiscoveryEngine};
use tokio::net::TcpListener;
use tracing::info;

use crate::{
    api::{routes::{build_router, build_static_router}, AppState, DiscoveryCoordinator, StaticAppState, ViewSnapshot},
    observability::init_tracing,
};

#[derive(Debug, Parser)]
#[command(name = "lattice", about = "Dynamic network topology explorer")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    Discover {
        #[arg(long, default_value = "config/lattice.yaml")]
        config: PathBuf,
        #[arg(long, value_enum, default_value_t = OutputFormat::Json)]
        output: OutputFormat,
    },
    Serve {
        #[arg(long, default_value = "config/lattice.yaml")]
        config: PathBuf,
        #[arg(long)]
        host: Option<String>,
        #[arg(long)]
        port: Option<u16>,
    },
    ServeSnapshot {
        #[arg(long)]
        snapshot: PathBuf,
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        #[arg(long, default_value_t = 8080)]
        port: u16,
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
        } => run_serve_snapshot(snapshot, host, port).await,
    }
}

async fn run_discover(config_path: PathBuf, output: OutputFormat) -> Result<()> {
    let config = load_config(config_path)?;
    let engine = DiscoveryEngine::new(config.discovery.clone(), config.sources.clone());
    let result = engine.discover().await?;

    match output {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&result.topology)?);
        }
    }

    Ok(())
}

async fn run_serve(
    config_path: PathBuf,
    host_override: Option<String>,
    port_override: Option<u16>,
) -> Result<()> {
    init_tracing();

    let mut config = load_config(config_path)?;
    if let Some(host) = host_override {
        config.server.host = host;
    }
    if let Some(port) = port_override {
        config.server.port = port;
    }

    let bind_addr = config.server.listen_addr();
    let engine = Arc::new(DiscoveryEngine::new(
        config.discovery.clone(),
        config.sources.clone(),
    ));
    let coordinator = Arc::new(DiscoveryCoordinator::new(
        engine,
        config.discovery.auto_discovery_interval_seconds,
    ));
    coordinator.start();

    let listener = TcpListener::bind(&bind_addr).await?;
    info!(listen_addr = %bind_addr, "lattice server listening");

    let state = AppState { coordinator };
    axum::serve(listener, build_router(state)).await?;

    Ok(())
}

async fn run_serve_snapshot(
    snapshot_path: PathBuf,
    host: String,
    port: u16,
) -> Result<()> {
    init_tracing();

    let snapshot = load_snapshot(snapshot_path)?;
    let bind_addr = format!("{host}:{port}");
    let listener = TcpListener::bind(&bind_addr).await?;
    info!(listen_addr = %bind_addr, "lattice snapshot viewer listening");

    let state = StaticAppState {
        snapshot: Arc::new(snapshot),
    };
    axum::serve(listener, build_static_router(state)).await?;

    Ok(())
}

fn load_snapshot(snapshot_path: PathBuf) -> Result<ViewSnapshot> {
    let raw = std::fs::read_to_string(&snapshot_path)?;
    let snapshot = serde_json::from_str::<ViewSnapshot>(&raw)?;
    Ok(snapshot)
}
