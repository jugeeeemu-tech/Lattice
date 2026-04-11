use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use futures_util::future::join_all;

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
                    let result = source
                        .discover()
                        .await
                        .with_context(|| format!("{label} source failed"));
                    (label, result)
                }
            });
        let mut partials = Vec::new();
        let mut warnings = Vec::new();
        for (label, result) in join_all(source_runs).await {
            match result {
                Ok(output) => partials.push(output),
                Err(error) => warnings.push(format!("{label}: {}", error)),
            }
        }

        if partials.is_empty() {
            if warnings.is_empty() {
                return Err(anyhow!("discovery did not produce any source results"));
            }
            return Err(anyhow!(warnings.join(" / ")));
        }

        let mut result = merge_source_results_with_hints(partials, &self.topology_hints);
        result.warnings = warnings;
        let discovered_at = Utc::now();
        result.discovered_at = discovered_at;
        result.topology.updated_at = discovered_at;
        Ok(result)
    }
}
