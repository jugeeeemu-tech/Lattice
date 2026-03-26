use std::{fs::File, path::Path};

use anyhow::{Context, Result};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub discovery: DiscoveryConfig,
    pub sources: Vec<DataSourceConfig>,
}

impl AppConfig {
    pub fn as_json(&self) -> Result<serde_json::Value> {
        Ok(serde_json::to_value(self)?)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServerConfig {
    pub listen: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoveryConfig {
    pub interval_seconds: u64,
    pub timeout_millis: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DataSourceConfig {
    pub name: String,
    pub kind: String,
    pub target: String,
    pub community: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SnapshotMetadata {
    pub generated_at: DateTime<Utc>,
}

impl SnapshotMetadata {
    pub fn now() -> Self {
        Self {
            generated_at: Utc::now(),
        }
    }
}

#[async_trait]
pub trait TopologySource: Send + Sync {
    async fn collect(&self) -> Result<SnapshotMetadata>;
}

pub fn load_config<P>(path: P) -> Result<AppConfig>
where
    P: AsRef<Path>,
{
    let path = path.as_ref();
    let file = File::open(path)
        .with_context(|| format!("failed to open config file: {}", path.display()))?;

    serde_yaml::from_reader(file)
        .with_context(|| format!("failed to parse config file: {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_example_config() {
        let config: AppConfig =
            serde_yaml::from_str(include_str!("../../../config/lattice.example.yaml")).unwrap();

        assert_eq!(config.server.listen, "127.0.0.1:3000");
        assert_eq!(config.sources.len(), 1);
        assert_eq!(config.sources[0].kind, "snmp");
    }

    #[test]
    fn converts_config_to_json() {
        let config: AppConfig =
            serde_yaml::from_str(include_str!("../../../config/lattice.example.yaml")).unwrap();

        let json = config.as_json().unwrap();

        assert_eq!(json["server"]["listen"], "127.0.0.1:3000");
    }

    #[tokio::test]
    async fn snapshot_metadata_sets_a_timestamp() {
        let metadata = SnapshotMetadata::now();

        assert!(metadata.generated_at <= Utc::now());
    }
}
