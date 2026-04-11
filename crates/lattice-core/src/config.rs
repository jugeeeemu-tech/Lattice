use std::{
    env, fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AppConfig {
    #[serde(default)]
    pub server: ServerConfig,
    #[serde(default)]
    pub discovery: DiscoveryConfig,
    #[serde(default)]
    pub topology_hints: TopologyHintsConfig,
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
    #[serde(default)]
    pub allowed_origins: Vec<String>,
    #[serde(default = "default_max_websocket_connections")]
    pub max_websocket_connections: usize,
    #[serde(default = "default_request_header_timeout_seconds")]
    pub request_header_timeout_seconds: u64,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: default_host(),
            port: default_port(),
            allowed_origins: Vec::new(),
            max_websocket_connections: default_max_websocket_connections(),
            request_header_timeout_seconds: default_request_header_timeout_seconds(),
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
    #[serde(default = "default_manual_discovery_cooldown_seconds")]
    pub manual_discovery_cooldown_seconds: u64,
}

impl Default for DiscoveryConfig {
    fn default() -> Self {
        Self {
            max_hops: default_max_hops(),
            timeout_seconds: default_timeout_seconds(),
            retries: default_retries(),
            concurrent_devices: default_concurrent_devices(),
            auto_discovery_interval_seconds: default_auto_discovery_interval_seconds(),
            manual_discovery_cooldown_seconds: default_manual_discovery_cooldown_seconds(),
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TopologyHintsConfig {
    #[serde(default)]
    pub links: Vec<TopologyHintLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TopologyHintLink {
    pub endpoints: Vec<TopologyHintEndpoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TopologyHintEndpoint {
    pub device: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interface: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interface_pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sys_descr_contains: Option<String>,
}

pub fn load_config<P>(path: P) -> Result<AppConfig>
where
    P: AsRef<Path>,
{
    let path = path.as_ref();
    load_adjacent_env_file(path).with_context(|| {
        format!(
            "failed to load environment file for config: {}",
            path.display()
        )
    })?;
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to open config file: {}", path.display()))?;
    let expanded = expand_env_placeholders(&raw)
        .with_context(|| format!("failed to expand config file: {}", path.display()))?;

    parse_config_text(&expanded)
        .with_context(|| format!("failed to parse config file: {}", path.display()))
}

pub fn resolve_config_path(explicit_path: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(path) = explicit_path {
        return Ok(path);
    }

    let candidates = default_config_candidates()?;
    for path in &candidates {
        if path.is_file() {
            return Ok(path.clone());
        }
    }

    let searched = candidates
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    anyhow::bail!(
        "could not find a lattice config file. looked for: {searched}. use --config to specify a file explicitly"
    );
}

fn parse_config_text(text: &str) -> Result<AppConfig> {
    serde_yaml::from_str(text).context("invalid YAML configuration")
}

fn default_config_candidates() -> Result<Vec<PathBuf>> {
    let current_dir = env::current_dir().context("failed to determine current directory")?;
    let mut candidates = vec![
        current_dir.join("config/lattice.yaml"),
        current_dir.join("lattice.yaml"),
    ];

    if let Some(xdg_config_home) = env::var_os("XDG_CONFIG_HOME") {
        candidates.push(PathBuf::from(xdg_config_home).join("lattice/lattice.yaml"));
    } else if let Some(home) = env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join(".config/lattice/lattice.yaml"));
    }

    Ok(candidates)
}

fn load_adjacent_env_file(config_path: &Path) -> Result<()> {
    let env_path = config_path.with_extension("env");
    if !env_path.exists() {
        return Ok(());
    }

    for item in dotenvy::from_path_iter(&env_path)
        .with_context(|| format!("failed to read {}", env_path.display()))?
    {
        let (key, value) =
            item.with_context(|| format!("failed to parse {}", env_path.display()))?;
        if env::var_os(&key).is_none() {
            // Keep process-level overrides higher priority than the adjacent env file.
            unsafe { env::set_var(key, value) };
        }
    }

    Ok(())
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

const fn default_manual_discovery_cooldown_seconds() -> u64 {
    10
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

const fn default_max_websocket_connections() -> usize {
    64
}

const fn default_request_header_timeout_seconds() -> u64 {
    5
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::{Mutex, OnceLock},
        time::{SystemTime, UNIX_EPOCH},
    };

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn unique_temp_path(name: &str) -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("lattice-{name}-{suffix}-{}", std::process::id()))
    }

    #[test]
    fn parses_example_config() {
        let config: AppConfig =
            serde_yaml::from_str(include_str!("../../../config/lattice.example.yaml")).unwrap();

        assert_eq!(config.server.host, "127.0.0.1");
        assert_eq!(config.server.port, 8080);
        assert!(config.server.allowed_origins.is_empty());
        assert_eq!(config.server.max_websocket_connections, 64);
        assert_eq!(config.server.request_header_timeout_seconds, 5);
        assert_eq!(config.discovery.max_hops, 10);
        assert_eq!(config.discovery.auto_discovery_interval_seconds, 60);
        assert_eq!(config.discovery.manual_discovery_cooldown_seconds, 10);
        assert!(config.topology_hints.links.is_empty());
        assert_eq!(config.sources.len(), 2);

        let SourceConfig::Snmp(snmp) = &config.sources[0] else {
            panic!("first source should be snmp");
        };
        assert_eq!(snmp.community, "${LATTICE_SNMP_COMMUNITY}");
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
        assert_eq!(json["server"]["allowed_origins"], serde_json::json!([]));
        assert_eq!(json["server"]["max_websocket_connections"], 64);
        assert_eq!(json["server"]["request_header_timeout_seconds"], 5);
        assert_eq!(json["discovery"]["max_hops"], 10);
        assert_eq!(json["discovery"]["auto_discovery_interval_seconds"], 60);
        assert_eq!(json["discovery"]["manual_discovery_cooldown_seconds"], 10);
        assert_eq!(json["topology_hints"]["links"], serde_json::json!([]));
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
        assert!(config.allowed_origins.is_empty());
        assert_eq!(config.max_websocket_connections, 64);
        assert_eq!(config.request_header_timeout_seconds, 5);
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

    #[test]
    fn parses_topology_hints() {
        let config = parse_config_text(
            r#"
topology_hints:
  links:
    - endpoints:
        - device: "ix2215"
          interface_pattern: "GE2.*"
          sys_descr_contains: "IX2215"
        - device: "pve"
          interface: "enp3s0"
sources: []
"#,
        )
        .unwrap();

        assert_eq!(config.topology_hints.links.len(), 1);
        let link = &config.topology_hints.links[0];
        assert_eq!(link.endpoints.len(), 2);
        assert_eq!(link.endpoints[0].device, "ix2215");
        assert_eq!(
            link.endpoints[0].interface_pattern.as_deref(),
            Some("GE2.*")
        );
        assert_eq!(
            link.endpoints[0].sys_descr_contains.as_deref(),
            Some("IX2215")
        );
        assert_eq!(link.endpoints[1].device, "pve");
        assert_eq!(link.endpoints[1].interface.as_deref(), Some("enp3s0"));
    }

    #[test]
    fn loads_adjacent_env_file_before_expanding_config_placeholders() {
        let _guard = env_lock().lock().unwrap();
        unsafe {
            env::remove_var("LATTICE_PROXMOX_TOKEN_ID");
            env::remove_var("LATTICE_PROXMOX_TOKEN_SECRET");
        }

        let dir = unique_temp_path("config-loads-env");
        fs::create_dir_all(&dir).unwrap();
        let config_path = dir.join("lattice.yaml");
        let env_path = dir.join("lattice.env");

        fs::write(
            &config_path,
            r#"
sources:
  - kind: "proxmox"
    base_url: "https://192.168.10.50:8006"
    token_id: "${LATTICE_PROXMOX_TOKEN_ID}"
    token_secret: "${LATTICE_PROXMOX_TOKEN_SECRET}"
    tls_verify: true
"#,
        )
        .unwrap();
        fs::write(
            &env_path,
            "LATTICE_PROXMOX_TOKEN_ID=root@pam!lattice\nLATTICE_PROXMOX_TOKEN_SECRET=secret\n",
        )
        .unwrap();

        let config = load_config(&config_path).unwrap();
        let SourceConfig::Proxmox(proxmox) = &config.sources[0] else {
            panic!("first source should be proxmox");
        };
        assert_eq!(proxmox.token_id, "root@pam!lattice");
        assert_eq!(proxmox.token_secret, "secret");

        fs::remove_dir_all(&dir).unwrap();
        unsafe {
            env::remove_var("LATTICE_PROXMOX_TOKEN_ID");
            env::remove_var("LATTICE_PROXMOX_TOKEN_SECRET");
        }
    }

    #[test]
    fn process_environment_overrides_adjacent_env_file() {
        let _guard = env_lock().lock().unwrap();
        unsafe {
            env::set_var("LATTICE_PROXMOX_TOKEN_ID", "override-id");
            env::set_var("LATTICE_PROXMOX_TOKEN_SECRET", "override-secret");
        }

        let dir = unique_temp_path("config-prefers-process-env");
        fs::create_dir_all(&dir).unwrap();
        let config_path = dir.join("lattice.yaml");
        let env_path = dir.join("lattice.env");

        fs::write(
            &config_path,
            r#"
sources:
  - kind: "proxmox"
    base_url: "https://192.168.10.50:8006"
    token_id: "${LATTICE_PROXMOX_TOKEN_ID}"
    token_secret: "${LATTICE_PROXMOX_TOKEN_SECRET}"
    tls_verify: true
"#,
        )
        .unwrap();
        fs::write(
            &env_path,
            "LATTICE_PROXMOX_TOKEN_ID=file-id\nLATTICE_PROXMOX_TOKEN_SECRET=file-secret\n",
        )
        .unwrap();

        let config = load_config(&config_path).unwrap();
        let SourceConfig::Proxmox(proxmox) = &config.sources[0] else {
            panic!("first source should be proxmox");
        };
        assert_eq!(proxmox.token_id, "override-id");
        assert_eq!(proxmox.token_secret, "override-secret");

        fs::remove_dir_all(&dir).unwrap();
        unsafe {
            env::remove_var("LATTICE_PROXMOX_TOKEN_ID");
            env::remove_var("LATTICE_PROXMOX_TOKEN_SECRET");
        }
    }

    #[test]
    fn resolve_config_path_prefers_config_directory_in_current_dir() {
        let _guard = env_lock().lock().unwrap();
        let original_dir = env::current_dir().unwrap();
        let dir = unique_temp_path("config-prefers-config-dir");
        fs::create_dir_all(dir.join("config")).unwrap();
        fs::write(dir.join("config/lattice.yaml"), "sources: []\n").unwrap();
        fs::write(dir.join("lattice.yaml"), "sources: []\n").unwrap();

        env::set_current_dir(&dir).unwrap();
        let resolved = resolve_config_path(None).unwrap();
        env::set_current_dir(&original_dir).unwrap();

        assert_eq!(resolved, dir.join("config/lattice.yaml"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn resolve_config_path_supports_explicit_override() {
        let explicit = PathBuf::from("/tmp/custom-lattice.yaml");
        assert_eq!(
            resolve_config_path(Some(explicit.clone())).unwrap(),
            explicit
        );
    }

    #[test]
    fn resolve_config_path_reports_search_locations_when_missing() {
        let _guard = env_lock().lock().unwrap();
        let original_dir = env::current_dir().unwrap();
        let dir = unique_temp_path("config-missing");
        fs::create_dir_all(&dir).unwrap();

        env::set_current_dir(&dir).unwrap();
        let error = resolve_config_path(None).unwrap_err().to_string();
        env::set_current_dir(&original_dir).unwrap();

        assert!(error.contains("could not find a lattice config file"));
        assert!(error.contains("config/lattice.yaml"));
        assert!(error.contains("--config"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
