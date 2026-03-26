use clap::Parser;
use lattice_server::app;
use tokio::net::TcpListener;

#[derive(Debug, Parser)]
#[command(
    name = "lattice-server",
    about = "Local API and frontend host for Lattice"
)]
struct Cli {
    #[arg(long, default_value = "127.0.0.1:3000")]
    listen: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let listener = TcpListener::bind(&cli.listen).await?;

    println!("lattice-server listening on http://{}", cli.listen);

    axum::serve(listener, app()).await?;

    Ok(())
}
