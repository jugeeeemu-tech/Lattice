use std::{
    collections::{HashMap, HashSet},
    net::IpAddr,
    sync::Arc,
};

use anyhow::{Context, Result};
use async_trait::async_trait;
use chrono::Utc;

use crate::{
    config::ProxmoxSourceConfig,
    discovery::{DiscoverySource, DiscoverySourceOutput, DiscoveryTree, DiscoveryTreeNode},
    graph::{
        DeploymentType, Device, DeviceRole, DeviceStatus, GuestAttachment, GuestKind, IdentityKeys,
        Interface, Link, LinkProtocol, OperStatus, Topology,
    },
    proxmox::{
        ClusterResource, GuestAgentNetworkInterface, GuestNetworkAttachment, ProxmoxApi,
        ProxmoxApiClient,
    },
};
use tracing::debug;

#[derive(Debug, Clone)]
struct ResolvedGuestAttachment {
    attachment: GuestNetworkAttachment,
    guest_interface_name: String,
}

#[derive(Clone)]
pub struct ProxmoxDiscoverySource {
    api: Arc<dyn ProxmoxApi>,
}

impl std::fmt::Debug for ProxmoxDiscoverySource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProxmoxDiscoverySource").finish()
    }
}

impl ProxmoxDiscoverySource {
    pub fn new(api: Arc<dyn ProxmoxApi>) -> Self {
        Self { api }
    }

    pub fn from_config(config: ProxmoxSourceConfig) -> Result<Self> {
        Ok(Self {
            api: Arc::new(ProxmoxApiClient::new(&config)?),
        })
    }
}

#[async_trait]
impl DiscoverySource for ProxmoxDiscoverySource {
    fn kind(&self) -> &'static str {
        "proxmox"
    }

    async fn discover(&self) -> Result<DiscoverySourceOutput> {
        let resources = self.api.cluster_resources().await?;
        let node_names = collect_node_names(&resources);
        let node_resource_by_name = resources
            .iter()
            .filter(|resource| resource.is_node())
            .filter_map(|resource| {
                resource
                    .node
                    .clone()
                    .or_else(|| resource.name.clone())
                    .map(|name| (name, resource.clone()))
            })
            .collect::<HashMap<_, _>>();
        let mut bridge_devices = HashMap::new();
        let mut bridge_rows = HashMap::new();
        let mut topology_devices = HashMap::new();
        let mut topology_links = Vec::new();
        let mut tree_nodes = Vec::new();

        for node in &node_names {
            let node_resource = node_resource_by_name.get(node);
            let node_device = build_node_device(node, node_resource);
            topology_devices.insert(node_device.id.clone(), node_device);

            let networks = self
                .api
                .node_network(node)
                .await
                .with_context(|| format!("failed to load proxmox network for node {node}"))?;
            for network in networks.into_iter().filter(|entry| entry.is_bridge()) {
                let bridge = build_bridge_device(
                    node,
                    &network.iface,
                    &network,
                    node_resource_by_name.get(node),
                );
                let row_id = bridge_row_id(node, &network.iface);
                bridge_rows.insert((node.clone(), network.iface.clone()), row_id.clone());
                bridge_devices.insert((node.clone(), network.iface.clone()), bridge.clone());
                topology_devices.insert(bridge.id.clone(), bridge.clone());
                tree_nodes.push(DiscoveryTreeNode {
                    row_id,
                    device_id: bridge.id.clone(),
                    parent_row_id: None,
                    label: Some(network.iface.clone()),
                    depth: 0,
                });
            }
        }

        for resource in resources {
            if resource.template == Some(1) || (!resource.is_qemu() && !resource.is_lxc()) {
                continue;
            }

            let node = resource
                .node
                .clone()
                .context("proxmox guest resource is missing node")?;
            let vmid = resource
                .vmid
                .context("proxmox guest resource is missing vmid")?;
            let config = if resource.is_qemu() {
                self.api.qemu_config(&node, vmid).await?
            } else {
                self.api.lxc_config(&node, vmid).await?
            };

            let attachments = config.network_attachments();
            let guest_agent_interfaces = if resource.is_qemu() {
                match self.api.qemu_agent_network_interfaces(&node, vmid).await {
                    Ok(interfaces) => interfaces,
                    Err(error) => {
                        debug!(
                            node = %node,
                            vmid,
                            guest = resource.name.as_deref().unwrap_or("unknown"),
                            "failed to read proxmox guest agent interfaces: {error}"
                        );
                        Vec::new()
                    }
                }
            } else {
                Vec::new()
            };
            let resolved_attachments =
                resolve_guest_attachments(&attachments, &guest_agent_interfaces);
            let guest = build_guest_device(
                &resource,
                &resolved_attachments,
                &guest_agent_interfaces,
                node_resource_by_name.get(&node),
            );
            topology_devices.insert(guest.id.clone(), guest.clone());

            for resolved_attachment in resolved_attachments {
                let attachment = &resolved_attachment.attachment;
                let bridge = ensure_bridge_device(
                    &mut topology_devices,
                    &mut tree_nodes,
                    &mut bridge_rows,
                    &mut bridge_devices,
                    &node,
                    &attachment.bridge,
                    node_resource_by_name.get(&node),
                );
                topology_links.push(Link {
                    id: format!(
                        "proxmox-guest-link:{}:{}:{}",
                        bridge.id, guest.id, attachment.interface_name
                    ),
                    local_device_id: bridge.id.clone(),
                    local_interface: attachment.bridge.clone(),
                    local_ip: bridge
                        .interfaces
                        .iter()
                        .find(|interface| interface.if_name == attachment.bridge)
                        .and_then(|interface| interface.ip_addresses.first().cloned()),
                    remote_device_id: guest.id.clone(),
                    remote_interface: resolved_attachment.guest_interface_name.clone(),
                    remote_ip: guest_interface_primary_ip(
                        &guest,
                        &resolved_attachment.guest_interface_name,
                    ),
                    speed_bps: None,
                    protocol: LinkProtocol::ProxmoxGuestLink,
                    guest_attachment: Some(GuestAttachment {
                        bridge_name: attachment.bridge.clone(),
                        vlan_tag: attachment.vlan_tag,
                        trunk_vlans: attachment.trunk_vlans.clone(),
                    }),
                });
                tree_nodes.push(DiscoveryTreeNode {
                    row_id: guest_row_id(
                        &node,
                        &attachment.bridge,
                        &guest.id,
                        &resolved_attachment.guest_interface_name,
                    ),
                    device_id: guest.id.clone(),
                    parent_row_id: Some(bridge_row_id(&node, &attachment.bridge)),
                    label: Some(guest.label()),
                    depth: 1,
                });
            }
        }

        topology_links.sort_by(|left, right| left.id.cmp(&right.id));
        tree_nodes.sort_by(|left, right| left.row_id.cmp(&right.row_id));

        Ok(DiscoverySourceOutput {
            topology: Topology {
                devices: topology_devices,
                links: topology_links,
                updated_at: Utc::now(),
            },
            tree: DiscoveryTree { nodes: tree_nodes },
        })
    }
}

fn collect_node_names(resources: &[ClusterResource]) -> Vec<String> {
    let mut names = resources
        .iter()
        .filter(|resource| resource.is_node())
        .filter_map(|resource| resource.node.clone().or_else(|| resource.name.clone()))
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    names
}

fn build_bridge_device(
    node: &str,
    bridge_name: &str,
    network: &crate::proxmox::NodeNetworkInterface,
    node_resource: Option<&ClusterResource>,
) -> Device {
    let mut interfaces = vec![Interface {
        if_index: 0,
        if_name: bridge_name.to_string(),
        ip_addresses: network.cidr_address().into_iter().collect(),
        speed_bps: None,
        oper_status: oper_status_from_active(network.active),
    }];
    for (index, port) in network.bridge_ports_list().into_iter().enumerate() {
        interfaces.push(Interface {
            if_index: index as u32 + 1,
            if_name: port,
            ip_addresses: Vec::new(),
            speed_bps: None,
            oper_status: OperStatus::Up,
        });
    }

    Device {
        id: format!("proxmox:{node}:bridge:{bridge_name}"),
        identity_keys: IdentityKeys {
            chassis_id: None,
            sys_name: Some(bridge_name.to_string()),
            mgmt_ip: network.cidr_address().as_deref().map(strip_prefix_len),
            mac_addresses: Vec::new(),
        },
        sys_descr: format!("Proxmox bridge {bridge_name}"),
        vendor: "proxmox".to_string(),
        model: None,
        device_role: DeviceRole::Bridge,
        deployment_type: DeploymentType::Virtual,
        guest_kind: None,
        interfaces,
        host_label: Some(node.to_string()),
        host_mgmt_ip: node_resource.and_then(|resource| resource.ip.clone()),
        upstream_interface: network.bridge_ports_list().into_iter().next(),
        default_gateway_ip: network
            .gateway
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        default_upstream_device_id: None,
        status: device_status_from_active(network.active),
        last_seen: Utc::now(),
    }
}

fn build_node_device(node: &str, node_resource: Option<&ClusterResource>) -> Device {
    Device {
        id: format!("proxmox:{node}:node"),
        identity_keys: IdentityKeys {
            chassis_id: None,
            sys_name: Some(node.to_string()),
            mgmt_ip: node_resource.and_then(|resource| resource.ip.clone()),
            mac_addresses: Vec::new(),
        },
        sys_descr: format!("Proxmox node {node}"),
        vendor: "proxmox".to_string(),
        model: None,
        device_role: DeviceRole::Server,
        deployment_type: DeploymentType::Physical,
        guest_kind: None,
        interfaces: Vec::new(),
        host_label: Some(node.to_string()),
        host_mgmt_ip: node_resource.and_then(|resource| resource.ip.clone()),
        upstream_interface: None,
        default_gateway_ip: None,
        default_upstream_device_id: None,
        status: match node_resource.and_then(|resource| resource.status.as_deref()) {
            Some("online") => DeviceStatus::Up,
            Some("offline") => DeviceStatus::Down,
            _ => DeviceStatus::Unknown,
        },
        last_seen: Utc::now(),
    }
}

fn build_guest_device(
    resource: &ClusterResource,
    attachments: &[ResolvedGuestAttachment],
    guest_agent_interfaces: &[GuestAgentNetworkInterface],
    node_resource: Option<&ClusterResource>,
) -> Device {
    let mut interfaces_by_name = HashMap::new();
    for (index, interface) in guest_agent_interfaces.iter().enumerate() {
        interfaces_by_name.insert(
            interface.name.clone(),
            Interface {
                if_index: index as u32,
                if_name: interface.name.clone(),
                ip_addresses: interface.cidr_addresses(),
                speed_bps: None,
                oper_status: OperStatus::Up,
            },
        );
    }
    for attachment in attachments {
        let next_index = interfaces_by_name.len() as u32;
        interfaces_by_name
            .entry(attachment.guest_interface_name.clone())
            .or_insert_with(|| Interface {
                if_index: next_index,
                if_name: attachment.guest_interface_name.clone(),
                ip_addresses: Vec::new(),
                speed_bps: None,
                oper_status: OperStatus::Up,
            });
    }
    let mut interfaces = interfaces_by_name.into_values().collect::<Vec<_>>();
    interfaces.sort_by(|left, right| left.if_name.cmp(&right.if_name));
    for (index, interface) in interfaces.iter_mut().enumerate() {
        interface.if_index = index as u32;
    }

    let mut mac_addresses = attachments
        .iter()
        .filter_map(|attachment| attachment.attachment.mac_address.clone())
        .collect::<Vec<_>>();
    mac_addresses.extend(
        guest_agent_interfaces
            .iter()
            .filter_map(GuestAgentNetworkInterface::normalized_mac_address),
    );
    mac_addresses.sort();
    mac_addresses.dedup();
    let node = resource.node.as_deref().unwrap_or("unknown");
    let vmid = resource.vmid.unwrap_or(0);
    let name = resource
        .name
        .clone()
        .unwrap_or_else(|| format!("{}-{vmid}", resource.resource_type));

    Device {
        id: format!("proxmox:{node}:{}:{vmid}", resource.resource_type),
        identity_keys: IdentityKeys {
            chassis_id: None,
            sys_name: Some(name.clone()),
            mgmt_ip: guest_management_ip(&interfaces),
            mac_addresses,
        },
        sys_descr: format!("Proxmox {} {name}", resource.resource_type),
        vendor: "proxmox".to_string(),
        model: None,
        device_role: DeviceRole::Server,
        deployment_type: DeploymentType::Virtual,
        guest_kind: if resource.is_lxc() {
            Some(GuestKind::Container)
        } else {
            Some(GuestKind::Vm)
        },
        interfaces,
        host_label: Some(node.to_string()),
        host_mgmt_ip: node_resource.and_then(|resource| resource.ip.clone()),
        upstream_interface: None,
        default_gateway_ip: None,
        default_upstream_device_id: None,
        status: match resource.status.as_deref() {
            Some("running") => DeviceStatus::Up,
            Some("stopped") => DeviceStatus::Down,
            _ => DeviceStatus::Unknown,
        },
        last_seen: Utc::now(),
    }
}

fn resolve_guest_attachments(
    attachments: &[GuestNetworkAttachment],
    guest_agent_interfaces: &[GuestAgentNetworkInterface],
) -> Vec<ResolvedGuestAttachment> {
    let mut used_names = HashSet::new();
    let mut resolved = Vec::with_capacity(attachments.len());

    for attachment in attachments {
        let guest_interface_name =
            resolve_guest_interface_name(attachment, guest_agent_interfaces, &used_names);
        used_names.insert(guest_interface_name.clone());
        resolved.push(ResolvedGuestAttachment {
            attachment: attachment.clone(),
            guest_interface_name,
        });
    }

    resolved
}

fn resolve_guest_interface_name(
    attachment: &GuestNetworkAttachment,
    guest_agent_interfaces: &[GuestAgentNetworkInterface],
    used_names: &HashSet<String>,
) -> String {
    if guest_agent_interfaces
        .iter()
        .any(|interface| interface.name == attachment.interface_name)
    {
        return attachment.interface_name.clone();
    }

    if let Some(mac_address) = attachment.mac_address.as_deref() {
        if let Some(interface) = guest_agent_interfaces.iter().find(|interface| {
            interface
                .normalized_mac_address()
                .as_deref()
                .is_some_and(|candidate| candidate == mac_address)
                && !used_names.contains(&interface.name)
        }) {
            return interface.name.clone();
        }
    }

    attachment.interface_name.clone()
}

fn guest_interface_primary_ip(device: &Device, interface_name: &str) -> Option<String> {
    device
        .interfaces
        .iter()
        .find(|interface| interface.if_name == interface_name)
        .and_then(|interface| {
            interface
                .ip_addresses
                .iter()
                .find(|cidr| !is_loopback_cidr(cidr))
        })
        .cloned()
}

fn guest_management_ip(interfaces: &[Interface]) -> Option<String> {
    interfaces
        .iter()
        .flat_map(|interface| interface.ip_addresses.iter())
        .find(|cidr| !is_loopback_cidr(cidr))
        .map(|cidr| strip_prefix_len(cidr))
}

fn is_loopback_cidr(value: &str) -> bool {
    let Some((address, _)) = value.split_once('/') else {
        return false;
    };
    let Ok(ip) = address.parse::<IpAddr>() else {
        return false;
    };
    ip.is_loopback()
}

fn ensure_bridge_device(
    topology_devices: &mut HashMap<String, Device>,
    tree_nodes: &mut Vec<DiscoveryTreeNode>,
    bridge_rows: &mut HashMap<(String, String), String>,
    bridge_devices: &mut HashMap<(String, String), Device>,
    node: &str,
    bridge_name: &str,
    node_resource: Option<&ClusterResource>,
) -> Device {
    if let Some(device) = bridge_devices.get(&(node.to_string(), bridge_name.to_string())) {
        return device.clone();
    }

    let bridge = Device {
        id: format!("proxmox:{node}:bridge:{bridge_name}"),
        identity_keys: IdentityKeys {
            chassis_id: None,
            sys_name: Some(bridge_name.to_string()),
            mgmt_ip: None,
            mac_addresses: Vec::new(),
        },
        sys_descr: format!("Proxmox bridge {bridge_name}"),
        vendor: "proxmox".to_string(),
        model: None,
        device_role: DeviceRole::Bridge,
        deployment_type: DeploymentType::Virtual,
        guest_kind: None,
        interfaces: vec![Interface {
            if_index: 0,
            if_name: bridge_name.to_string(),
            ip_addresses: Vec::new(),
            speed_bps: None,
            oper_status: OperStatus::Unknown,
        }],
        host_label: Some(node.to_string()),
        host_mgmt_ip: node_resource.and_then(|resource| resource.ip.clone()),
        upstream_interface: None,
        default_gateway_ip: None,
        default_upstream_device_id: None,
        status: DeviceStatus::Unknown,
        last_seen: Utc::now(),
    };
    topology_devices.insert(bridge.id.clone(), bridge.clone());
    bridge_devices.insert((node.to_string(), bridge_name.to_string()), bridge.clone());
    bridge_rows.insert(
        (node.to_string(), bridge_name.to_string()),
        bridge_row_id(node, bridge_name),
    );
    tree_nodes.push(DiscoveryTreeNode {
        row_id: bridge_row_id(node, bridge_name),
        device_id: bridge.id.clone(),
        parent_row_id: None,
        label: Some(bridge_name.to_string()),
        depth: 0,
    });
    bridge
}

fn bridge_row_id(node: &str, bridge_name: &str) -> String {
    format!("proxmox:{node}:bridge:{bridge_name}")
}

fn guest_row_id(node: &str, bridge_name: &str, guest_id: &str, interface_name: &str) -> String {
    format!("proxmox:{node}:bridge:{bridge_name}/guest:{guest_id}:{interface_name}")
}

fn strip_prefix_len(value: &str) -> String {
    value.split('/').next().unwrap_or(value).to_string()
}

fn oper_status_from_active(active: Option<u8>) -> OperStatus {
    match active {
        Some(1) => OperStatus::Up,
        Some(0) => OperStatus::Down,
        _ => OperStatus::Unknown,
    }
}

fn device_status_from_active(active: Option<u8>) -> DeviceStatus {
    match active {
        Some(1) => DeviceStatus::Up,
        Some(0) => DeviceStatus::Down,
        _ => DeviceStatus::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use anyhow::Result;

    use super::*;
    use crate::proxmox::{GuestConfig, GuestNetworkAttachment, NodeNetworkInterface};
    use crate::GuestKind;

    #[derive(Debug, Default)]
    struct FakeApi;

    #[async_trait]
    impl ProxmoxApi for FakeApi {
        async fn cluster_resources(&self) -> Result<Vec<ClusterResource>> {
            Ok(vec![
                ClusterResource {
                    id: "node/pve-1".to_string(),
                    resource_type: "node".to_string(),
                    node: Some("pve-1".to_string()),
                    vmid: None,
                    name: Some("pve-1".to_string()),
                    status: Some("online".to_string()),
                    ip: Some("192.0.2.10".to_string()),
                    template: None,
                },
                ClusterResource {
                    id: "qemu/100".to_string(),
                    resource_type: "qemu".to_string(),
                    node: Some("pve-1".to_string()),
                    vmid: Some(100),
                    name: Some("web".to_string()),
                    status: Some("running".to_string()),
                    ip: None,
                    template: None,
                },
                ClusterResource {
                    id: "lxc/200".to_string(),
                    resource_type: "lxc".to_string(),
                    node: Some("pve-1".to_string()),
                    vmid: Some(200),
                    name: Some("dns".to_string()),
                    status: Some("running".to_string()),
                    ip: None,
                    template: None,
                },
            ])
        }

        async fn node_network(&self, _node: &str) -> Result<Vec<NodeNetworkInterface>> {
            Ok(vec![NodeNetworkInterface {
                iface: "vmbr0".to_string(),
                interface_type: "bridge".to_string(),
                address: Some("192.0.2.10".to_string()),
                cidr: Some(crate::proxmox::client::CidrValue::Prefix(24)),
                active: Some(1),
                gateway: None,
                bridge_ports: Some("eno1".to_string()),
            }])
        }

        async fn qemu_config(&self, _node: &str, _vmid: u64) -> Result<GuestConfig> {
            Ok(GuestConfig {
                entries: HashMap::from([(
                    "net0".to_string(),
                    serde_json::Value::String(
                        "virtio=DE:AD:BE:EF:00:01,bridge=vmbr0,tag=20".to_string(),
                    ),
                )]),
            })
        }

        async fn lxc_config(&self, _node: &str, _vmid: u64) -> Result<GuestConfig> {
            Ok(GuestConfig {
                entries: HashMap::from([(
                    "net0".to_string(),
                    serde_json::Value::String(
                        "name=eth0,bridge=vmbr0,trunks=30;20;30,type=veth".to_string(),
                    ),
                )]),
            })
        }

        async fn qemu_agent_network_interfaces(
            &self,
            _node: &str,
            vmid: u64,
        ) -> Result<Vec<GuestAgentNetworkInterface>> {
            if vmid != 100 {
                return Ok(Vec::new());
            }

            Ok(vec![
                GuestAgentNetworkInterface {
                    name: "ens18".to_string(),
                    hardware_address: Some("DE:AD:BE:EF:00:01".to_string()),
                    ip_addresses: vec![crate::proxmox::GuestAgentIpAddress {
                        ip_address: "192.0.2.101".to_string(),
                        ip_address_type: "ipv4".to_string(),
                        prefix: 24,
                    }],
                },
                GuestAgentNetworkInterface {
                    name: "lo".to_string(),
                    hardware_address: None,
                    ip_addresses: vec![crate::proxmox::GuestAgentIpAddress {
                        ip_address: "127.0.0.1".to_string(),
                        ip_address_type: "ipv4".to_string(),
                        prefix: 8,
                    }],
                },
            ])
        }
    }

    #[tokio::test]
    async fn source_builds_bridge_guest_tree_and_links() {
        let source = ProxmoxDiscoverySource::new(Arc::new(FakeApi));

        let result = source.discover().await.unwrap();

        assert!(result
            .topology
            .devices
            .values()
            .any(|device| device.device_role == DeviceRole::Bridge
                && device.deployment_type == DeploymentType::Virtual
                && device.host_label.as_deref() == Some("pve-1")
                && device.host_mgmt_ip.as_deref() == Some("192.0.2.10")));
        assert!(result
            .topology
            .devices
            .values()
            .any(|device| device.device_role == DeviceRole::Server
                && device.deployment_type == DeploymentType::Virtual
                && device.guest_kind == Some(GuestKind::Vm)
                && device.identity_keys.mgmt_ip.as_deref() == Some("192.0.2.101")
                && device.identity_keys.mac_addresses.as_slice() == ["de:ad:be:ef:00:01"]
                && device.host_mgmt_ip.as_deref() == Some("192.0.2.10")));
        assert!(result.topology.devices.values().any(|device| {
            device.id == "proxmox:pve-1:lxc:200"
                && device.device_role == DeviceRole::Server
                && device.deployment_type == DeploymentType::Virtual
                && device.guest_kind == Some(GuestKind::Container)
        }));
        assert!(
            result
                .topology
                .devices
                .values()
                .filter(|device| {
                    device.device_role == DeviceRole::Server
                        && device.deployment_type == DeploymentType::Virtual
                })
                .count()
                >= 2
        );
        assert!(result.topology.devices.values().any(|device| {
            device.id == "proxmox:pve-1:node"
                && device.identity_keys.sys_name.as_deref() == Some("pve-1")
                && device.identity_keys.mgmt_ip.as_deref() == Some("192.0.2.10")
                && device.device_role == DeviceRole::Server
                && device.deployment_type == DeploymentType::Physical
        }));
        assert!(result
            .topology
            .links
            .iter()
            .all(|link| link.protocol == LinkProtocol::ProxmoxGuestLink));
        assert!(result.topology.links.iter().any(|link| {
            link.remote_device_id == "proxmox:pve-1:qemu:100"
                && link.remote_interface == "ens18"
                && link.remote_ip.as_deref() == Some("192.0.2.101/24")
                && link.guest_attachment
                    == Some(GuestAttachment {
                        bridge_name: "vmbr0".to_string(),
                        vlan_tag: Some(20),
                        trunk_vlans: Vec::new(),
                    })
        }));
        assert!(result.topology.links.iter().any(|link| {
            link.remote_device_id == "proxmox:pve-1:lxc:200"
                && link.guest_attachment
                    == Some(GuestAttachment {
                        bridge_name: "vmbr0".to_string(),
                        vlan_tag: None,
                        trunk_vlans: vec![20, 30],
                    })
        }));
        assert!(result
            .tree
            .nodes
            .iter()
            .any(|node| node.parent_row_id.is_none() && node.label.as_deref() == Some("vmbr0")));
        assert!(result.tree.nodes.iter().any(|node| {
            node.parent_row_id.as_deref() == Some("proxmox:pve-1:bridge:vmbr0")
                && node.label.as_deref() == Some("web")
        }));
    }

    #[test]
    fn guest_attachment_parser_handles_vm_and_container_shapes() {
        assert_eq!(
            GuestNetworkAttachment::parse("net0", "virtio=aa:bb,bridge=vmbr0")
                .unwrap()
                .interface_name,
            "net0"
        );
        assert_eq!(
            GuestNetworkAttachment::parse("net0", "virtio=aa:bb,bridge=vmbr0")
                .unwrap()
                .vlan_tag,
            None
        );
        assert_eq!(
            GuestNetworkAttachment::parse("net0", "virtio=aa:bb,bridge=vmbr0")
                .unwrap()
                .trunk_vlans,
            Vec::<u16>::new()
        );
        assert_eq!(
            GuestNetworkAttachment::parse("net0", "virtio=DE:AD:BE:EF:00:01,bridge=vmbr0")
                .unwrap()
                .mac_address
                .as_deref(),
            Some("de:ad:be:ef:00:01")
        );
        assert_eq!(
            GuestNetworkAttachment::parse(
                "net1",
                "name=eth1,bridge=vmbr1,type=veth,hwaddr=AA:BB:CC:DD:EE:FF"
            )
            .unwrap()
            .bridge,
            "vmbr1"
        );
        assert_eq!(
            GuestNetworkAttachment::parse(
                "net1",
                "name=eth1,bridge=vmbr1,type=veth,hwaddr=AA:BB:CC:DD:EE:FF"
            )
            .unwrap()
            .mac_address
            .as_deref(),
            Some("aa:bb:cc:dd:ee:ff")
        );
        assert_eq!(
            GuestNetworkAttachment::parse("net0", "virtio=aa:bb,bridge=vmbr0,tag=20")
                .unwrap()
                .vlan_tag,
            Some(20)
        );
        assert_eq!(
            GuestNetworkAttachment::parse("net0", "virtio=aa:bb,bridge=vmbr0,trunks=20;30")
                .unwrap()
                .trunk_vlans,
            vec![20, 30]
        );
        assert_eq!(
            GuestNetworkAttachment::parse(
                "net0",
                "virtio=aa:bb,bridge=vmbr0,tag=20,trunks=30;20;20"
            )
            .unwrap(),
            GuestNetworkAttachment {
                entry_key: "net0".to_string(),
                interface_name: "net0".to_string(),
                bridge: "vmbr0".to_string(),
                mac_address: None,
                vlan_tag: Some(20),
                trunk_vlans: vec![20, 30],
            }
        );
    }
}
