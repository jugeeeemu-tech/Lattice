#[tokio::main]
async fn main() -> anyhow::Result<()> {
    lattice_server::cli::run().await
}
