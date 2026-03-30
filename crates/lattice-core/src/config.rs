use std::{fs, path::Path};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AppConfig {
    #[serde(default)]
    pub server: ServerConfig,
    #[serde(default)]
    pub discovery: DiscoveryConfig,
    pub sources: Vec<SourceConfig>,
}

impl AppConfig {
    pub fn as_json(&self) -> Result<serde_json::Value> {
        Ok(serde_json::to_value(self)?)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ServerConfig {
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: default_host(),
            port: default_port(),
        }
    }
}

impl ServerConfig {
    pub fn listen_addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DiscoveryConfig {
    #[serde(default = "default_max_hops")]
    pub max_hops: u32,
    #[serde(default = "default_timeout_seconds")]
    pub timeout_seconds: u64,
    #[serde(default = "default_retries")]
    pub retries: u32,
    #[serde(default = "default_concurrent_devices")]
    pub concurrent_devices: usize,
    #[serde(default = "default_auto_discovery_interval_seconds")]
    pub auto_discovery_interval_seconds: u64,
}

impl Default for DiscoveryConfig {
    fn default() -> Self {
        Self {
            max_hops: default_max_hops(),
            timeout_seconds: default_timeout_seconds(),
            retries: default_retries(),
            concurrent_devices: default_concurrent_devices(),
            auto_discovery_interval_seconds: default_auto_discovery_interval_seconds(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceConfig {
    Snmp(SnmpSourceConfig),
    Proxmox(ProxmoxSourceConfig),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SnmpSourceConfig {
    #[serde(default = "default_snmp_version")]
    pub version: String,
    pub community: String,
    pub seeds: Vec<SeedDevice>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProxmoxSourceConfig {
    pub base_url: String,
    pub token_id: String,
    pub token_secret: String,
    #[serde(default = "default_tls_verify")]
    pub tls_verify: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SeedDevice {
    pub ip: String,
    pub label: String,
}

pub fn load_config<P>(path: P) -> Result<AppConfig>
where
    P: AsRef<Path>,
{
    let path = path.as_ref();
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to open config file: {}", path.display()))?;
    let expanded = expand_env_placeholders(&raw)
        .with_context(|| format!("failed to expand config file: {}", path.display()))?;

    parse_config_text(&expanded)
        .with_context(|| format!("failed to parse config file: {}", path.display()))
}

fn parse_config_text(text: &str) -> Result<AppConfig> {
    serde_yaml::from_str(text).context("invalid YAML configuration")
}

fn expand_env_placeholders(input: &str) -> Result<String> {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '$' || chars.peek() != Some(&'{') {
            output.push(ch);
            continue;
        }

        chars.next();
        let mut name = String::new();
        let mut closed = false;

        for current in chars.by_ref() {
            if current == '}' {
                closed = true;
                break;
            }
            name.push(current);
        }

        if !closed {
            anyhow::bail!("unterminated environment placeholder");
        }

        let variable = name.trim();
        if variable.is_empty() {
            anyhow::bail!("empty environment placeholder");
        }

        let value = std::env::var(variable)
            .with_context(|| format!("environment variable {variable} is not set"))?;
        output.push_str(&value);
    }

    Ok(output)
}

const fn default_port() -> u16 {
    8080
}

const fn default_max_hops() -> u32 {
    10
}

const fn default_timeout_seconds() -> u64 {
    5
}

const fn default_retries() -> u32 {
    2
}

const fn default_concurrent_devices() -> usize {
    1
}

const fn default_auto_discovery_interval_seconds() -> u64 {
    60
}

fn default_snmp_version() -> String {
    "2c".to_string()
}

const fn default_tls_verify() -> bool {
    true
}

fn default_host() -> String {
    "127.0.0.1".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_example_config() {
        let config: AppConfig =
            serde_yaml::from_str(include_str!("../../../config/lattice.example.yaml")).unwrap();

        assert_eq!(config.server.host, "127.0.0.1");
        assert_eq!(config.server.port, 8080);
        assert_eq!(config.discovery.max_hops, 10);
        assert_eq!(config.discovery.auto_discovery_interval_seconds, 60);
        assert_eq!(config.sources.len(), 2);

        let SourceConfig::Snmp(snmp) = &config.sources[0] else {
            panic!("first source should be snmp");
        };
        assert_eq!(snmp.community, "public");
        assert_eq!(snmp.seeds.len(), 1);

        let SourceConfig::Proxmox(proxmox) = &config.sources[1] else {
            panic!("second source should be proxmox");
        };
        assert_eq!(proxmox.base_url, "https://192.168.10.50:8006");
        assert_eq!(proxmox.token_id, "${LATTICE_PROXMOX_TOKEN_ID}");
        assert_eq!(proxmox.token_secret, "${LATTICE_PROXMOX_TOKEN_SECRET}");
        assert!(proxmox.tls_verify);
    }

    #[test]
    fn converts_config_to_json() {
        let config: AppConfig =
            serde_yaml::from_str(include_str!("../../../config/lattice.example.yaml")).unwrap();

        let json = config.as_json().unwrap();

        assert_eq!(json["server"]["host"], "127.0.0.1");
        assert_eq!(json["discovery"]["max_hops"], 10);
        assert_eq!(json["discovery"]["auto_discovery_interval_seconds"], 60);
        assert_eq!(json["sources"][0]["kind"], "snmp");
        assert_eq!(json["sources"][1]["kind"], "proxmox");
    }

    #[test]
    fn rejects_legacy_top_level_snmp_and_seeds_fields() {
        let legacy = r#"
server:
  host: "127.0.0.1"
discovery:
  max_hops: 10
snmp:
  version: "2c"
  community: "public"
seeds:
  - ip: "192.0.2.10"
    label: "edge"
"#;

        let error = serde_yaml::from_str::<AppConfig>(legacy)
            .unwrap_err()
            .to_string();
        assert!(error.contains("unknown field"));
    }

    #[test]
    fn default_server_config_builds_listen_addr() {
        let config = ServerConfig::default();
        assert_eq!(config.listen_addr(), "127.0.0.1:8080");
    }

    #[test]
    fn config_round_trips_via_json_value() {
        let config: AppConfig =
            serde_yaml::from_str(include_str!("../../../config/lattice.example.yaml")).unwrap();
        let value = serde_json::to_value(&config).unwrap();
        let round_trip: AppConfig = serde_json::from_value(value).unwrap();

        assert_eq!(round_trip, config);
    }

    #[test]
    fn expands_environment_placeholders_in_config_text() {
        let expanded = expand_env_placeholders(
            r#"
sources:
  - kind: "proxmox"
    base_url: "https://${PROXMOX_HOST}:8006"
    token_id: "${PROXMOX_TOKEN_ID}"
    token_secret: "${PROXMOX_TOKEN_SECRET}"
"#,
        )
        .unwrap_err()
        .to_string();

        assert!(expanded.contains("environment variable PROXMOX_HOST is not set"));
    }

    #[test]
    fn parses_config_after_placeholder_expansion() {
        let config = parse_config_text(
            r#"
server:
  host: "127.0.0.1"
  port: 8080
discovery:
  max_hops: 1
  timeout_seconds: 5
  retries: 2
  concurrent_devices: 1
sources:
  - kind: "proxmox"
    base_url: "https://192.168.10.50:8006"
    token_id: "root@pam!lattice"
    token_secret: "secret"
    tls_verify: false
"#,
        )
        .unwrap();

        let SourceConfig::Proxmox(proxmox) = &config.sources[0] else {
            panic!("first source should be proxmox");
        };
        assert_eq!(proxmox.base_url, "https://192.168.10.50:8006");
        assert_eq!(proxmox.token_id, "root@pam!lattice");
        assert_eq!(proxmox.token_secret, "secret");
        assert!(!proxmox.tls_verify);
    }
}
