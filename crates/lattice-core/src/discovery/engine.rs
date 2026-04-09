use anyhow::{Context, Result};
use chrono::Utc;
use futures_util::future::try_join_all;

use crate::{
    config::{DiscoveryConfig, SourceConfig, TopologyHintsConfig},
    discovery::{build_discovery_sources, merge_source_results_with_hints, DiscoveryResult},
};

#[derive(Debug, Clone)]
pub struct DiscoveryEngine {
    config: DiscoveryConfig,
    sources: Vec<SourceConfig>,
    topology_hints: TopologyHintsConfig,
}

impl DiscoveryEngine {
    pub fn new(
        config: DiscoveryConfig,
        sources: Vec<SourceConfig>,
        topology_hints: TopologyHintsConfig,
    ) -> Self {
        Self {
            config,
            sources,
            topology_hints,
        }
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

        let mut result = merge_source_results_with_hints(partials, &self.topology_hints);
        let discovered_at = Utc::now();
        result.discovered_at = discovered_at;
        result.topology.updated_at = discovered_at;
        Ok(result)
    }
}
