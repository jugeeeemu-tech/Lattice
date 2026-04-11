use std::{collections::HashMap, time::Duration};

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use reqwest::{
    header::{HeaderMap, HeaderValue, AUTHORIZATION},
    redirect::Policy,
    Client,
};
use serde::de::DeserializeOwned;
use serde::Deserialize;

use crate::config::ProxmoxSourceConfig;

#[async_trait]
pub trait ProxmoxApi: Send + Sync {
    async fn cluster_resources(&self) -> Result<Vec<ClusterResource>>;
    async fn node_network(&self, node: &str) -> Result<Vec<NodeNetworkInterface>>;
    async fn qemu_config(&self, node: &str, vmid: u64) -> Result<GuestConfig>;
    async fn lxc_config(&self, node: &str, vmid: u64) -> Result<GuestConfig>;
    async fn qemu_agent_network_interfaces(
        &self,
        node: &str,
        vmid: u64,
    ) -> Result<Vec<GuestAgentNetworkInterface>>;
}

#[derive(Debug, Clone)]
pub struct ProxmoxApiClient {
    base_url: reqwest::Url,
    base_path_segments: Vec<String>,
    client: Client,
}

impl ProxmoxApiClient {
    pub fn new(config: &ProxmoxSourceConfig, request_timeout: Duration) -> Result<Self> {
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!(
                "PVEAPIToken={}={}",
                config.token_id, config.token_secret
            ))
            .context("failed to build proxmox authorization header")?,
        );

        let client = Client::builder()
            .default_headers(headers)
            .connect_timeout(request_timeout)
            .timeout(request_timeout)
            .redirect(Policy::none())
            .danger_accept_invalid_certs(!config.tls_verify)
            .build()
            .context("failed to build proxmox HTTP client")?;

        let mut base_url =
            reqwest::Url::parse(&config.base_url).context("failed to parse proxmox base_url")?;
        base_url.set_query(None);
        base_url.set_fragment(None);
        let base_path_segments = base_url
            .path()
            .split('/')
            .filter(|segment| !segment.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();

        Ok(Self {
            base_url,
            base_path_segments,
            client,
        })
    }

    async fn get<T>(&self, segments: &[&str]) -> Result<T>
    where
        T: DeserializeOwned,
    {
        let url = self.api_url(segments)?;
        let response = self
            .client
            .get(url.clone())
            .send()
            .await
            .with_context(|| format!("proxmox request failed: GET {}", url.path()))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .with_context(|| format!("proxmox response read failed: GET {}", url.path()))?;

        if !status.is_success() {
            let detail = body.lines().next().unwrap_or("no response body");
            return Err(anyhow!("GET {} returned {status}: {detail}", url.path()));
        }

        let envelope = serde_json::from_str::<ApiEnvelope<T>>(&body)
            .with_context(|| format!("failed to decode proxmox response for {}", url.path()))?;
        Ok(envelope.data)
    }

    fn api_url(&self, segments: &[&str]) -> Result<reqwest::Url> {
        let mut url = self.base_url.clone();
        {
            let mut path_segments = url
                .path_segments_mut()
                .map_err(|_| anyhow!("proxmox api root cannot be used as a base URL"))?;
            path_segments.clear();
            for segment in &self.base_path_segments {
                path_segments.push(segment);
            }
            path_segments.push("api2");
            path_segments.push("json");
            for segment in segments {
                path_segments.push(segment);
            }
        }
        Ok(url)
    }
}

#[async_trait]
impl ProxmoxApi for ProxmoxApiClient {
    async fn cluster_resources(&self) -> Result<Vec<ClusterResource>> {
        self.get(&["cluster", "resources"]).await
    }

    async fn node_network(&self, node: &str) -> Result<Vec<NodeNetworkInterface>> {
        self.get(&["nodes", node, "network"]).await
    }

    async fn qemu_config(&self, node: &str, vmid: u64) -> Result<GuestConfig> {
        let vmid = vmid.to_string();
        self.get(&["nodes", node, "qemu", &vmid, "config"]).await
    }

    async fn lxc_config(&self, node: &str, vmid: u64) -> Result<GuestConfig> {
        let vmid = vmid.to_string();
        self.get(&["nodes", node, "lxc", &vmid, "config"]).await
    }

    async fn qemu_agent_network_interfaces(
        &self,
        node: &str,
        vmid: u64,
    ) -> Result<Vec<GuestAgentNetworkInterface>> {
        let vmid = vmid.to_string();
        let response = self
            .get::<GuestAgentNetworkInterfacesResponse>(&[
                "nodes",
                node,
                "qemu",
                &vmid,
                "agent",
                "network-get-interfaces",
            ])
            .await?;
        Ok(response.result)
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct ClusterResource {
    pub id: String,
    #[serde(rename = "type")]
    pub resource_type: String,
    #[serde(default)]
    pub node: Option<String>,
    #[serde(default)]
    pub vmid: Option<u64>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub ip: Option<String>,
    #[serde(default)]
    pub template: Option<u8>,
}

impl ClusterResource {
    pub fn is_node(&self) -> bool {
        self.resource_type == "node"
    }

    pub fn is_qemu(&self) -> bool {
        self.resource_type == "qemu"
    }

    pub fn is_lxc(&self) -> bool {
        self.resource_type == "lxc"
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct NodeNetworkInterface {
    pub iface: String,
    #[serde(default, rename = "type")]
    pub interface_type: String,
    #[serde(default)]
    pub address: Option<String>,
    #[serde(default)]
    pub cidr: Option<CidrValue>,
    #[serde(default)]
    pub active: Option<u8>,
    #[serde(default)]
    pub gateway: Option<String>,
    #[serde(default, alias = "bridge_ports", alias = "bridge-ports")]
    pub bridge_ports: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum CidrValue {
    Prefix(u8),
    Address(String),
}

impl NodeNetworkInterface {
    pub fn is_bridge(&self) -> bool {
        self.interface_type == "bridge"
    }

    pub fn bridge_ports_list(&self) -> Vec<String> {
        self.bridge_ports
            .as_deref()
            .unwrap_or("")
            .split_whitespace()
            .filter(|value| !value.is_empty() && *value != "none")
            .map(str::to_string)
            .collect()
    }

    pub fn cidr_address(&self) -> Option<String> {
        match (&self.address, self.cidr.as_ref()) {
            (_, Some(CidrValue::Address(cidr))) if cidr.contains('/') => Some(cidr.clone()),
            (Some(address), Some(CidrValue::Prefix(prefix))) if !address.is_empty() => {
                Some(format!("{address}/{prefix}"))
            }
            (Some(address), None) if address.contains('/') => Some(address.clone()),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct GuestConfig {
    #[serde(flatten)]
    pub entries: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct GuestAgentNetworkInterfacesResponse {
    #[serde(default)]
    pub result: Vec<GuestAgentNetworkInterface>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct GuestAgentNetworkInterface {
    pub name: String,
    #[serde(default, rename = "hardware-address")]
    pub hardware_address: Option<String>,
    #[serde(default, rename = "ip-addresses")]
    pub ip_addresses: Vec<GuestAgentIpAddress>,
}

impl GuestAgentNetworkInterface {
    pub fn normalized_mac_address(&self) -> Option<String> {
        self.hardware_address
            .as_deref()
            .and_then(normalize_mac_address)
    }

    pub fn cidr_addresses(&self) -> Vec<String> {
        self.ip_addresses
            .iter()
            .filter_map(GuestAgentIpAddress::cidr_address)
            .collect()
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct GuestAgentIpAddress {
    #[serde(rename = "ip-address")]
    pub ip_address: String,
    #[serde(rename = "ip-address-type")]
    pub ip_address_type: String,
    pub prefix: u8,
}

impl GuestAgentIpAddress {
    pub fn cidr_address(&self) -> Option<String> {
        let address = self.ip_address.trim();
        if address.is_empty() {
            return None;
        }

        Some(format!("{address}/{}", self.prefix))
    }
}

impl GuestConfig {
    pub fn network_attachments(&self) -> Vec<GuestNetworkAttachment> {
        let mut attachments = Vec::new();
        for (key, value) in &self.entries {
            if !key.starts_with("net") {
                continue;
            }
            let Some(value) = value.as_str() else {
                continue;
            };
            if let Some(attachment) = GuestNetworkAttachment::parse(key, value) {
                attachments.push(attachment);
            }
        }
        attachments.sort_by(|left, right| {
            left.entry_key
                .cmp(&right.entry_key)
                .then_with(|| left.bridge.cmp(&right.bridge))
        });
        attachments
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuestNetworkAttachment {
    pub entry_key: String,
    pub interface_name: String,
    pub bridge: String,
    pub mac_address: Option<String>,
    pub vlan_tag: Option<u16>,
    pub trunk_vlans: Vec<u16>,
}

impl GuestNetworkAttachment {
    pub fn parse(key: &str, value: &str) -> Option<Self> {
        let mut fields = HashMap::new();
        for part in value.split(',') {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Some((field_key, field_value)) = trimmed.split_once('=') {
                fields.insert(field_key.trim().to_string(), field_value.trim().to_string());
            }
        }

        let bridge = fields.get("bridge")?.to_string();
        let interface_name = fields
            .get("name")
            .cloned()
            .unwrap_or_else(|| key.to_string());
        let mac_address = fields
            .values()
            .find_map(|field_value| normalize_mac_address(field_value));
        let vlan_tag = fields.get("tag").and_then(|value| parse_vlan_id(value));
        let trunk_vlans = fields
            .get("trunks")
            .map(|value| parse_vlan_list(value))
            .unwrap_or_default();

        Some(Self {
            entry_key: key.to_string(),
            interface_name,
            bridge,
            mac_address,
            vlan_tag,
            trunk_vlans,
        })
    }
}

fn normalize_mac_address(value: &str) -> Option<String> {
    let normalized = value.trim().replace('-', ":").to_ascii_lowercase();
    let parts = normalized.split(':').collect::<Vec<_>>();
    if parts.len() != 6
        || parts
            .iter()
            .any(|part| part.len() != 2 || !part.chars().all(|ch| ch.is_ascii_hexdigit()))
    {
        return None;
    }

    Some(parts.join(":"))
}

fn parse_vlan_id(value: &str) -> Option<u16> {
    value.trim().parse::<u16>().ok()
}

fn parse_vlan_list(value: &str) -> Vec<u16> {
    let mut vlans = value
        .split(';')
        .filter_map(parse_vlan_id)
        .collect::<Vec<_>>();
    vlans.sort_unstable();
    vlans.dedup();
    vlans
}

#[derive(Debug, Deserialize)]
struct ApiEnvelope<T> {
    data: T,
}

#[cfg(test)]
mod tests {
    use std::{net::SocketAddr, sync::Arc};

    use axum::{
        extract::State,
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::get,
        Json, Router,
    };
    use tokio::{net::TcpListener, sync::Mutex};

    use super::*;

    #[derive(Clone, Default)]
    struct TestState {
        headers: Arc<Mutex<Vec<String>>>,
    }

    async fn spawn_server(router: Router) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        addr
    }

    #[tokio::test]
    async fn client_sends_api_token_and_parses_cluster_resources() {
        let state = TestState::default();
        let router = Router::new()
            .route(
                "/api2/json/cluster/resources",
                get(
                    |State(state): State<TestState>, headers: HeaderMap| async move {
                        if let Some(value) = headers.get(AUTHORIZATION) {
                            state
                                .headers
                                .lock()
                                .await
                                .push(value.to_str().unwrap().to_string());
                        }
                        Json(serde_json::json!({
                            "data": [
                                {
                                    "id": "node/pve-1",
                                    "type": "node",
                                    "node": "pve-1",
                                    "status": "online",
                                    "ip": "192.0.2.10"
                                }
                            ]
                        }))
                    },
                ),
            )
            .route(
                "/api2/json/nodes/pve-1/network",
                get(|| async {
                    Json(serde_json::json!({
                        "data": [
                            {
                                "iface": "vmbr0",
                                "type": "bridge",
                                "address": "192.0.2.10",
                                "cidr": 24,
                                "bridge_ports": "eno1"
                            }
                        ]
                    }))
                }),
            )
            .route(
                "/api2/json/nodes/pve-1/qemu/100/config",
                get(|| async {
                    Json(serde_json::json!({
                        "data": {
                            "net0": "virtio=DE:AD:BE:EF:00:01,bridge=vmbr0"
                        }
                    }))
                }),
            )
            .route(
                "/api2/json/nodes/pve-1/lxc/200/config",
                get(|| async {
                    Json(serde_json::json!({
                        "data": {
                            "net0": "name=eth0,bridge=vmbr0,type=veth"
                        }
                    }))
                }),
            )
            .route(
                "/api2/json/nodes/pve-1/qemu/100/agent/network-get-interfaces",
                get(|| async {
                    Json(serde_json::json!({
                        "data": {
                            "result": [
                                {
                                    "name": "ens18",
                                    "hardware-address": "DE:AD:BE:EF:00:01",
                                    "ip-addresses": [
                                        {
                                            "ip-address": "192.0.2.101",
                                            "ip-address-type": "ipv4",
                                            "prefix": 24
                                        }
                                    ]
                                }
                            ]
                        }
                    }))
                }),
            )
            .with_state(state.clone());

        let addr = spawn_server(router).await;
        let client = ProxmoxApiClient::new(
            &crate::config::ProxmoxSourceConfig {
                base_url: format!("http://{addr}"),
                token_id: "root@pam!token".to_string(),
                token_secret: "secret".to_string(),
                tls_verify: false,
            },
            Duration::from_secs(1),
        )
        .unwrap();

        let resources = client.cluster_resources().await.unwrap();
        let networks = client.node_network("pve-1").await.unwrap();
        let vm = client.qemu_config("pve-1", 100).await.unwrap();
        let ct = client.lxc_config("pve-1", 200).await.unwrap();
        let guest_interfaces = client
            .qemu_agent_network_interfaces("pve-1", 100)
            .await
            .unwrap();

        assert_eq!(resources.len(), 1);
        assert_eq!(networks[0].bridge_ports_list(), vec!["eno1".to_string()]);
        assert_eq!(networks[0].cidr_address().as_deref(), Some("192.0.2.10/24"));
        assert_eq!(vm.network_attachments()[0].bridge, "vmbr0");
        assert_eq!(
            vm.network_attachments()[0].mac_address.as_deref(),
            Some("de:ad:be:ef:00:01")
        );
        assert_eq!(ct.network_attachments()[0].interface_name, "eth0");
        assert_eq!(guest_interfaces[0].name, "ens18");
        assert_eq!(
            guest_interfaces[0].normalized_mac_address().as_deref(),
            Some("de:ad:be:ef:00:01")
        );
        assert_eq!(
            guest_interfaces[0].cidr_addresses(),
            vec!["192.0.2.101/24".to_string()]
        );
        assert_eq!(
            state.headers.lock().await[0],
            "PVEAPIToken=root@pam!token=secret"
        );
    }

    #[tokio::test]
    async fn client_accepts_string_cidr_from_proxmox_network_api() {
        let router = Router::new().route(
            "/api2/json/nodes/pve/network",
            get(|| async {
                Json(serde_json::json!({
                    "data": [
                        {
                            "iface": "vmbr0",
                            "type": "bridge",
                            "address": "192.168.10.50",
                            "cidr": "192.168.10.50/24",
                            "bridge_ports": "enp3s0"
                        }
                    ]
                }))
            }),
        );

        let addr = spawn_server(router).await;
        let client = ProxmoxApiClient::new(
            &crate::config::ProxmoxSourceConfig {
                base_url: format!("http://{addr}"),
                token_id: "root@pam!token".to_string(),
                token_secret: "secret".to_string(),
                tls_verify: false,
            },
            Duration::from_secs(1),
        )
        .unwrap();

        let networks = client.node_network("pve").await.unwrap();

        assert_eq!(networks.len(), 1);
        assert_eq!(
            networks[0].cidr_address().as_deref(),
            Some("192.168.10.50/24")
        );
    }

    #[tokio::test]
    async fn client_wraps_http_errors_with_context() {
        let router = Router::new().route(
            "/api2/json/cluster/resources",
            get(|| async { (StatusCode::UNAUTHORIZED, "denied").into_response() }),
        );
        let addr = spawn_server(router).await;
        let client = ProxmoxApiClient::new(
            &crate::config::ProxmoxSourceConfig {
                base_url: format!("http://{addr}"),
                token_id: "root@pam!token".to_string(),
                token_secret: "secret".to_string(),
                tls_verify: false,
            },
            Duration::from_secs(1),
        )
        .unwrap();

        let error = client.cluster_resources().await.unwrap_err().to_string();

        assert!(error.contains("/cluster/resources"));
        assert!(error.contains("401"));
    }

    #[tokio::test]
    async fn client_times_out_when_proxmox_does_not_respond() {
        let router = Router::new().route(
            "/api2/json/cluster/resources",
            get(|| async {
                tokio::time::sleep(Duration::from_millis(250)).await;
                Json(serde_json::json!({ "data": [] }))
            }),
        );
        let addr = spawn_server(router).await;
        let client = ProxmoxApiClient::new(
            &crate::config::ProxmoxSourceConfig {
                base_url: format!("http://{addr}"),
                token_id: "root@pam!token".to_string(),
                token_secret: "secret".to_string(),
                tls_verify: false,
            },
            Duration::from_millis(50),
        )
        .unwrap();

        let error = client.cluster_resources().await.unwrap_err().to_string();

        assert!(error.contains("proxmox request failed"));
    }

    #[tokio::test]
    async fn client_does_not_follow_redirects_to_other_hosts() {
        let redirected = Arc::new(Mutex::new(false));
        let redirected_flag = Arc::clone(&redirected);

        let target_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_addr = target_listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((_, _)) = target_listener.accept().await {
                *redirected_flag.lock().await = true;
            }
        });

        let redirect_router = Router::new().route(
            "/api2/json/cluster/resources",
            get(move || async move {
                (
                    StatusCode::FOUND,
                    [(
                        reqwest::header::LOCATION.as_str(),
                        format!("http://{target_addr}/api2/json/cluster/resources"),
                    )],
                )
                    .into_response()
            }),
        );
        let redirect_addr = spawn_server(redirect_router).await;
        let client = ProxmoxApiClient::new(
            &crate::config::ProxmoxSourceConfig {
                base_url: format!("http://{redirect_addr}"),
                token_id: "root@pam!token".to_string(),
                token_secret: "secret".to_string(),
                tls_verify: false,
            },
            Duration::from_secs(1),
        )
        .unwrap();

        let error = client.cluster_resources().await.unwrap_err().to_string();

        assert!(error.contains("302"));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!*redirected.lock().await);
    }

    #[tokio::test]
    async fn client_percent_encodes_dynamic_path_segments() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let seen_request_line = Arc::new(Mutex::new(String::new()));
        let seen_request_line_writer = Arc::clone(&seen_request_line);
        tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let mut buffer = [0u8; 2048];
                let size = stream
                    .readable()
                    .await
                    .and_then(|_| stream.try_read(&mut buffer))
                    .unwrap();
                let request = String::from_utf8_lossy(&buffer[..size]).to_string();
                *seen_request_line_writer.lock().await =
                    request.lines().next().unwrap_or("").to_string();
                let body = br#"{"data":[]}"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                    body.len(),
                    String::from_utf8_lossy(body)
                );
                let _ = stream.writable().await;
                let _ = stream.try_write(response.as_bytes());
            }
        });

        let client = ProxmoxApiClient::new(
            &crate::config::ProxmoxSourceConfig {
                base_url: format!("http://{addr}"),
                token_id: "root@pam!token".to_string(),
                token_secret: "secret".to_string(),
                tls_verify: false,
            },
            Duration::from_secs(1),
        )
        .unwrap();

        let _ = client.node_network("node/a?x=1").await.unwrap();
        let request_line = seen_request_line.lock().await.clone();

        assert!(
            request_line.starts_with("GET /api2/json/nodes/node%2Fa%3Fx=1/network "),
            "unexpected request line: {request_line}"
        );
        assert!(
            !request_line.contains("/nodes/node/a?x=1/network"),
            "dynamic segment escaped into request path: {request_line}"
        );
    }
}
