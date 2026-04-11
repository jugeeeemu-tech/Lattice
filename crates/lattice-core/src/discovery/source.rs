use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result};
use async_trait::async_trait;

use crate::{
    config::{DiscoveryConfig, SourceConfig},
    proxmox::{ProxmoxApiClient, ProxmoxDiscoverySource},
};

use super::{DiscoverySourceOutput, SnmpDiscoverySource};

#[async_trait]
pub trait DiscoverySource: Send + Sync {
    fn kind(&self) -> &'static str;
    async fn discover(&self) -> Result<DiscoverySourceOutput>;
}

pub fn build_discovery_sources(
    discovery: &DiscoveryConfig,
    sources: &[SourceConfig],
) -> Result<Vec<Arc<dyn DiscoverySource>>> {
    let mut built_sources: Vec<Arc<dyn DiscoverySource>> = Vec::new();

    for source in sources {
        match source {
            SourceConfig::Snmp(config) => {
                built_sources.push(Arc::new(SnmpDiscoverySource::new(
                    discovery.clone(),
                    config.clone(),
                )));
            }
            SourceConfig::Proxmox(config) => {
                let request_timeout = Duration::from_secs(discovery.timeout_seconds.max(1));
                let client = Arc::new(
                    ProxmoxApiClient::new(config, request_timeout)
                        .with_context(|| "failed to build proxmox api client")?,
                );
                built_sources.push(Arc::new(ProxmoxDiscoverySource::new(client)));
            }
        }
    }

    Ok(built_sources)
}
