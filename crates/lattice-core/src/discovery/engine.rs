use anyhow::{Context, Result};
use chrono::Utc;
use futures_util::future::try_join_all;

use crate::{
    config::{DiscoveryConfig, SourceConfig},
    discovery::{build_discovery_sources, merge_source_results, DiscoveryResult},
};

#[derive(Debug, Clone)]
pub struct DiscoveryEngine {
    config: DiscoveryConfig,
    sources: Vec<SourceConfig>,
}

impl DiscoveryEngine {
    pub fn new(config: DiscoveryConfig, sources: Vec<SourceConfig>) -> Self {
        Self { config, sources }
    }

    pub async fn discover(&self) -> Result<DiscoveryResult> {
        let source_runs = build_discovery_sources(&self.config, &self.sources)?
            .into_iter()
            .map(|source| {
                let label = source.kind().to_string();
                async move {
                    source
                        .discover()
                        .await
                        .with_context(|| format!("{label} source failed"))
                }
            });
        let partials = try_join_all(source_runs).await?;

        let mut result = merge_source_results(partials);
        let discovered_at = Utc::now();
        result.discovered_at = discovered_at;
        result.topology.updated_at = discovered_at;
        Ok(result)
    }
}
