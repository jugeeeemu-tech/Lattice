use std::{cmp::Ordering, collections::HashMap};

use lattice_core::{
    DeploymentType, Device, DeviceRole, DiscoveryTree, DiscoveryTreeNode,
    GuestAttachment as CoreGuestAttachment, GuestKind, IdentityKeys, Link, Topology,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryState {
    Loading,
    Discovering,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoveryStatus {
    pub state: DiscoveryState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl DiscoveryStatus {
    pub fn loading() -> Self {
        Self {
            state: DiscoveryState::Loading,
            message: None,
        }
    }

    pub fn discovering() -> Self {
        Self {
            state: DiscoveryState::Discovering,
            message: None,
        }
    }

    pub fn ready() -> Self {
        Self {
            state: DiscoveryState::Ready,
            message: None,
        }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            state: DiscoveryState::Failed,
            message: Some(message.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ViewDevice {
    pub id: String,
    pub label: String,
    pub depth: u32,
    pub device_role: DeviceRole,
    pub deployment_type: DeploymentType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guest_kind: Option<GuestKind>,
    pub identity_keys: IdentityKeys,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_interface: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ViewLink {
    pub id: String,
    pub local_device_id: String,
    pub local_interface: String,
    pub local_ip: Option<String>,
    pub remote_device_id: String,
    pub remote_interface: String,
    pub remote_ip: Option<String>,
    pub speed_bps: Option<u64>,
    pub protocol: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guest_attachment: Option<ViewGuestAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ViewGuestAttachment {
    pub bridge_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vlan_tag: Option<u16>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub trunk_vlans: Vec<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TreeRow {
    pub id: String,
    pub device_id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TreeEdge {
    pub parent_row_id: String,
    pub child_row_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ViewSnapshot {
    pub devices: Vec<ViewDevice>,
    pub links: Vec<ViewLink>,
    pub tree_rows: Vec<TreeRow>,
    pub tree_edges: Vec<TreeEdge>,
    pub primary_row_by_device: HashMap<String, String>,
    pub discovery_status: DiscoveryStatus,
}

impl ViewSnapshot {
    pub fn empty(status: DiscoveryStatus) -> Self {
        Self {
            devices: Vec::new(),
            links: Vec::new(),
            tree_rows: Vec::new(),
            tree_edges: Vec::new(),
            primary_row_by_device: HashMap::new(),
            discovery_status: status,
        }
    }
}

pub fn build_view_snapshot(
    topology: &Topology,
    tree: &DiscoveryTree,
    status: &DiscoveryStatus,
) -> ViewSnapshot {
    let min_depth_by_device = build_min_depths(tree);
    let devices = build_devices(topology, &min_depth_by_device);
    let links = build_links(&topology.links);
    let (tree_rows, tree_edges, primary_row_by_device) = build_tree(topology, tree);

    ViewSnapshot {
        devices,
        links,
        tree_rows,
        tree_edges,
        primary_row_by_device,
        discovery_status: status.clone(),
    }
}

fn build_min_depths(tree: &DiscoveryTree) -> HashMap<String, u32> {
    let mut by_device: HashMap<String, u32> = HashMap::new();
    for node in &tree.nodes {
        by_device
            .entry(node.device_id.clone())
            .and_modify(|current| *current = (*current).min(node.depth))
            .or_insert(node.depth);
    }
    by_device
}

fn build_devices(
    topology: &Topology,
    min_depth_by_device: &HashMap<String, u32>,
) -> Vec<ViewDevice> {
    let mut devices: Vec<ViewDevice> = topology
        .devices
        .values()
        .map(|device| ViewDevice {
            id: device.id.clone(),
            label: device_label(device),
            depth: min_depth_by_device.get(&device.id).copied().unwrap_or(0),
            device_role: device.device_role.clone(),
            deployment_type: device.deployment_type.clone(),
            guest_kind: device.guest_kind,
            identity_keys: device.identity_keys.clone(),
            host_label: device.host_label.clone(),
            upstream_interface: device.upstream_interface.clone(),
        })
        .collect();

    devices.sort_by(|left, right| {
        left.label
            .cmp(&right.label)
            .then_with(|| left.id.cmp(&right.id))
    });
    devices
}

fn build_links(links: &[Link]) -> Vec<ViewLink> {
    let mut view_links: Vec<ViewLink> = links
        .iter()
        .map(|link| ViewLink {
            id: link.id.clone(),
            local_device_id: link.local_device_id.clone(),
            local_interface: link.local_interface.clone(),
            local_ip: link.local_ip.clone(),
            remote_device_id: link.remote_device_id.clone(),
            remote_interface: link.remote_interface.clone(),
            remote_ip: link.remote_ip.clone(),
            speed_bps: link.speed_bps,
            protocol: link.protocol.as_str().to_string(),
            guest_attachment: link.guest_attachment.as_ref().map(view_guest_attachment),
        })
        .collect();
    view_links.sort_by(|left, right| left.id.cmp(&right.id));
    view_links
}

fn build_tree(
    topology: &Topology,
    tree: &DiscoveryTree,
) -> (Vec<TreeRow>, Vec<TreeEdge>, HashMap<String, String>) {
    let mut nodes = tree.nodes.clone();
    nodes.sort_by(node_order);

    let tree_rows = nodes
        .iter()
        .map(|node| TreeRow {
            id: node.row_id.clone(),
            device_id: node.device_id.clone(),
            label: node
                .label
                .clone()
                .unwrap_or_else(|| device_label_by_id(topology, &node.device_id)),
        })
        .collect::<Vec<_>>();

    let tree_edges = nodes
        .iter()
        .filter_map(|node| {
            node.parent_row_id.as_ref().map(|parent_row_id| TreeEdge {
                parent_row_id: parent_row_id.clone(),
                child_row_id: node.row_id.clone(),
            })
        })
        .collect::<Vec<_>>();

    let mut primary_row_by_device = HashMap::new();
    let mut primary_depth_by_device = HashMap::new();
    for node in &nodes {
        match primary_depth_by_device.get(&node.device_id).copied() {
            Some(existing_depth) if existing_depth < node.depth => {}
            Some(existing_depth)
                if existing_depth == node.depth
                    && primary_row_by_device
                        .get(&node.device_id)
                        .is_some_and(|existing| existing <= &node.row_id) => {}
            _ => {
                primary_depth_by_device.insert(node.device_id.clone(), node.depth);
                primary_row_by_device.insert(node.device_id.clone(), node.row_id.clone());
            }
        }
    }

    (tree_rows, tree_edges, primary_row_by_device)
}

fn node_order(left: &DiscoveryTreeNode, right: &DiscoveryTreeNode) -> Ordering {
    left.depth
        .cmp(&right.depth)
        .then_with(|| left.row_id.cmp(&right.row_id))
}

fn device_label(device: &Device) -> String {
    device
        .identity_keys
        .sys_name
        .clone()
        .or_else(|| device.identity_keys.mgmt_ip.clone())
        .unwrap_or_else(|| "Unknown".to_string())
}

fn device_label_by_id(topology: &Topology, device_id: &str) -> String {
    topology
        .devices
        .get(device_id)
        .map(device_label)
        .unwrap_or_else(|| "Unknown".to_string())
}

fn view_guest_attachment(attachment: &CoreGuestAttachment) -> ViewGuestAttachment {
    ViewGuestAttachment {
        bridge_name: attachment.bridge_name.clone(),
        vlan_tag: attachment.vlan_tag,
        trunk_vlans: attachment.trunk_vlans.clone(),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use chrono::{TimeZone, Utc};
    use lattice_core::{
        DeploymentType, DeviceRole, DeviceStatus, GuestAttachment, GuestKind, Interface,
        LinkProtocol, OperStatus,
    };

    use super::*;

    fn device(
        id: &str,
        sys_name: &str,
        device_role: DeviceRole,
        deployment_type: DeploymentType,
        guest_kind: Option<GuestKind>,
        host_label: Option<&str>,
    ) -> Device {
        Device {
            id: id.to_string(),
            identity_keys: IdentityKeys {
                chassis_id: None,
                sys_name: Some(sys_name.to_string()),
                mgmt_ip: Some(format!("192.0.2.{}", id.chars().last().unwrap_or('1'))),
                mac_addresses: Vec::new(),
            },
            sys_descr: sys_name.to_string(),
            vendor: "test".to_string(),
            model: None,
            device_role,
            deployment_type,
            guest_kind,
            interfaces: vec![Interface {
                if_index: 1,
                if_name: "eth0".to_string(),
                ip_addresses: vec![format!(
                    "198.51.100.{}/24",
                    id.chars().last().unwrap_or('1')
                )],
                speed_bps: Some(1_000_000_000),
                oper_status: OperStatus::Up,
            }],
            status: DeviceStatus::Up,
            host_label: host_label.map(str::to_string),
            host_mgmt_ip: None,
            upstream_interface: None,
            last_seen: Utc.with_ymd_and_hms(2026, 3, 27, 0, 0, 0).unwrap(),
        }
    }

    fn sample_topology() -> Topology {
        let mut devices = HashMap::new();
        devices.insert(
            "router-1".to_string(),
            device(
                "router-1",
                "core",
                DeviceRole::Router,
                DeploymentType::Unknown,
                None,
                None,
            ),
        );
        devices.insert(
            "proxmox:pve-1:bridge:vmbr0".to_string(),
            device(
                "proxmox:pve-1:bridge:vmbr0",
                "vmbr0",
                DeviceRole::Bridge,
                DeploymentType::Virtual,
                None,
                Some("pve-1"),
            ),
        );
        devices.insert(
            "proxmox:pve-1:qemu:100".to_string(),
            device(
                "proxmox:pve-1:qemu:100",
                "web",
                DeviceRole::Server,
                DeploymentType::Virtual,
                Some(GuestKind::Vm),
                Some("pve-1"),
            ),
        );

        Topology {
            devices,
            links: vec![Link {
                id: "bridge-to-vm".to_string(),
                local_device_id: "proxmox:pve-1:bridge:vmbr0".to_string(),
                local_interface: "vmbr0".to_string(),
                local_ip: Some("192.0.2.10/24".to_string()),
                remote_device_id: "proxmox:pve-1:qemu:100".to_string(),
                remote_interface: "net0".to_string(),
                remote_ip: None,
                speed_bps: None,
                protocol: LinkProtocol::ProxmoxGuestLink,
                guest_attachment: Some(GuestAttachment {
                    bridge_name: "vmbr0".to_string(),
                    vlan_tag: Some(20),
                    trunk_vlans: Vec::new(),
                }),
            }],
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn snapshot_keeps_devices_unique_even_when_tree_duplicates_them() {
        let topology = sample_topology();
        let tree = DiscoveryTree {
            nodes: vec![
                DiscoveryTreeNode {
                    row_id: "seed:192.0.2.1/router-1#1".to_string(),
                    device_id: "router-1".to_string(),
                    parent_row_id: None,
                    label: Some("core".to_string()),
                    depth: 0,
                },
                DiscoveryTreeNode {
                    row_id: "proxmox:pve-1:bridge:vmbr0".to_string(),
                    device_id: "proxmox:pve-1:bridge:vmbr0".to_string(),
                    parent_row_id: None,
                    label: Some("vmbr0".to_string()),
                    depth: 0,
                },
                DiscoveryTreeNode {
                    row_id: "proxmox:pve-1:bridge:vmbr0/guest:100".to_string(),
                    device_id: "proxmox:pve-1:qemu:100".to_string(),
                    parent_row_id: Some("proxmox:pve-1:bridge:vmbr0".to_string()),
                    label: Some("web".to_string()),
                    depth: 1,
                },
                DiscoveryTreeNode {
                    row_id: "seed:192.0.2.2/proxmox:pve-1:qemu:100#1".to_string(),
                    device_id: "proxmox:pve-1:qemu:100".to_string(),
                    parent_row_id: None,
                    label: Some("web".to_string()),
                    depth: 0,
                },
            ],
        };

        let snapshot = build_view_snapshot(&topology, &tree, &DiscoveryStatus::ready());

        assert_eq!(snapshot.devices.len(), 3);
        assert_eq!(snapshot.tree_rows.len(), 4);
        assert_eq!(
            snapshot.primary_row_by_device["proxmox:pve-1:qemu:100"],
            "seed:192.0.2.2/proxmox:pve-1:qemu:100#1"
        );
    }

    #[test]
    fn snapshot_ids_are_stable_for_same_input() {
        let topology = sample_topology();
        let tree = DiscoveryTree {
            nodes: vec![
                DiscoveryTreeNode {
                    row_id: "proxmox:pve-1:bridge:vmbr0".to_string(),
                    device_id: "proxmox:pve-1:bridge:vmbr0".to_string(),
                    parent_row_id: None,
                    label: Some("vmbr0".to_string()),
                    depth: 0,
                },
                DiscoveryTreeNode {
                    row_id: "proxmox:pve-1:bridge:vmbr0/guest:100".to_string(),
                    device_id: "proxmox:pve-1:qemu:100".to_string(),
                    parent_row_id: Some("proxmox:pve-1:bridge:vmbr0".to_string()),
                    label: Some("web".to_string()),
                    depth: 1,
                },
            ],
        };

        let first = build_view_snapshot(&topology, &tree, &DiscoveryStatus::ready());
        let second = build_view_snapshot(&topology, &tree, &DiscoveryStatus::ready());

        assert_eq!(first.tree_rows, second.tree_rows);
        assert_eq!(first.primary_row_by_device, second.primary_row_by_device);
    }

    #[test]
    fn snapshot_includes_host_label_and_tree_structure() {
        let topology = sample_topology();
        let tree = DiscoveryTree {
            nodes: vec![
                DiscoveryTreeNode {
                    row_id: "proxmox:pve-1:bridge:vmbr0".to_string(),
                    device_id: "proxmox:pve-1:bridge:vmbr0".to_string(),
                    parent_row_id: None,
                    label: Some("vmbr0".to_string()),
                    depth: 0,
                },
                DiscoveryTreeNode {
                    row_id: "proxmox:pve-1:bridge:vmbr0/guest:100".to_string(),
                    device_id: "proxmox:pve-1:qemu:100".to_string(),
                    parent_row_id: Some("proxmox:pve-1:bridge:vmbr0".to_string()),
                    label: Some("web".to_string()),
                    depth: 1,
                },
            ],
        };

        let snapshot = build_view_snapshot(&topology, &tree, &DiscoveryStatus::ready());

        assert_eq!(
            snapshot
                .devices
                .iter()
                .find(|device| device.id == "proxmox:pve-1:qemu:100")
                .map(|device| (device.host_label.as_deref(), device.guest_kind)),
            Some((Some("pve-1"), Some(GuestKind::Vm)))
        );
        assert_eq!(snapshot.tree_edges.len(), 1);
        assert_eq!(snapshot.links[0].protocol, "proxmox_guest_link");
        assert_eq!(
            snapshot.links[0].guest_attachment,
            Some(ViewGuestAttachment {
                bridge_name: "vmbr0".to_string(),
                vlan_tag: Some(20),
                trunk_vlans: Vec::new(),
            })
        );
    }

    #[test]
    fn snapshot_serializes_new_device_schema_fields() {
        let mut topology = sample_topology();
        if let Some(bridge) = topology.devices.get_mut("proxmox:pve-1:bridge:vmbr0") {
            bridge.identity_keys.mac_addresses = vec!["aa:bb:cc:dd:ee:ff".to_string()];
            bridge.upstream_interface = Some("eno1".to_string());
        }

        let snapshot = build_view_snapshot(
            &topology,
            &DiscoveryTree::default(),
            &DiscoveryStatus::ready(),
        );
        let value = serde_json::to_value(&snapshot).unwrap();

        let bridge = value["devices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|device| device["id"] == "proxmox:pve-1:bridge:vmbr0")
            .unwrap();
        let guest = value["devices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|device| device["id"] == "proxmox:pve-1:qemu:100")
            .unwrap();

        assert_eq!(bridge["device_role"], "bridge");
        assert_eq!(bridge["deployment_type"], "virtual");
        assert_eq!(bridge["upstream_interface"], "eno1");
        assert_eq!(
            bridge["identity_keys"]["mac_addresses"],
            serde_json::json!(["aa:bb:cc:dd:ee:ff"])
        );
        assert_eq!(guest["guest_kind"], "vm");
    }

    #[test]
    fn snapshot_represents_zero_router_candidate_case() {
        let bridge_id = "proxmox:pve-1:bridge:vmbr0";
        let guest_id = "proxmox:pve-1:qemu:100";

        let mut topology = sample_topology();
        topology.devices.insert(
            guest_id.to_string(),
            device(
                guest_id,
                "mc01",
                DeviceRole::Server,
                DeploymentType::Virtual,
                Some(GuestKind::Vm),
                Some("pve-1"),
            ),
        );
        topology.links = vec![Link {
            id: "mc01-access".to_string(),
            local_device_id: bridge_id.to_string(),
            local_interface: "vmbr0".to_string(),
            local_ip: Some("192.0.2.10/24".to_string()),
            remote_device_id: guest_id.to_string(),
            remote_interface: "net0".to_string(),
            remote_ip: None,
            speed_bps: None,
            protocol: LinkProtocol::ProxmoxGuestLink,
            guest_attachment: Some(GuestAttachment {
                bridge_name: "vmbr0".to_string(),
                vlan_tag: Some(20),
                trunk_vlans: Vec::new(),
            }),
        }];

        let snapshot = build_view_snapshot(
            &topology,
            &DiscoveryTree::default(),
            &DiscoveryStatus::ready(),
        );

        assert_eq!(snapshot.links.len(), 1);
        assert_eq!(
            snapshot.links[0].guest_attachment,
            Some(ViewGuestAttachment {
                bridge_name: "vmbr0".to_string(),
                vlan_tag: Some(20),
                trunk_vlans: Vec::new(),
            })
        );
    }

    #[test]
    fn snapshot_represents_ambiguous_router_candidate_case() {
        let bridge_id = "proxmox:pve-1:bridge:vmbr0".to_string();
        let guest_id = "proxmox:pve-1:qemu:100".to_string();
        let router_a_id = "proxmox:pve-1:qemu:200".to_string();
        let router_b_id = "proxmox:pve-1:qemu:300".to_string();

        let mut topology = sample_topology();
        topology.devices.insert(
            guest_id.clone(),
            device(
                &guest_id,
                "mc01",
                DeviceRole::Server,
                DeploymentType::Virtual,
                Some(GuestKind::Vm),
                Some("pve-1"),
            ),
        );
        topology.devices.insert(
            router_a_id.clone(),
            device(
                &router_a_id,
                "vyos01",
                DeviceRole::Router,
                DeploymentType::Virtual,
                Some(GuestKind::Vm),
                Some("pve-1"),
            ),
        );
        topology.devices.insert(
            router_b_id.clone(),
            device(
                &router_b_id,
                "vyos02",
                DeviceRole::Router,
                DeploymentType::Virtual,
                Some(GuestKind::Vm),
                Some("pve-1"),
            ),
        );
        topology.links = vec![
            Link {
                id: "mc01-access".to_string(),
                local_device_id: bridge_id.clone(),
                local_interface: "vmbr0".to_string(),
                local_ip: Some("192.0.2.10/24".to_string()),
                remote_device_id: guest_id,
                remote_interface: "net0".to_string(),
                remote_ip: None,
                speed_bps: None,
                protocol: LinkProtocol::ProxmoxGuestLink,
                guest_attachment: Some(GuestAttachment {
                    bridge_name: "vmbr0".to_string(),
                    vlan_tag: Some(20),
                    trunk_vlans: Vec::new(),
                }),
            },
            Link {
                id: "vyos01-trunk".to_string(),
                local_device_id: bridge_id.clone(),
                local_interface: "vmbr0".to_string(),
                local_ip: Some("192.0.2.10/24".to_string()),
                remote_device_id: router_a_id,
                remote_interface: "net0".to_string(),
                remote_ip: None,
                speed_bps: None,
                protocol: LinkProtocol::ProxmoxGuestLink,
                guest_attachment: Some(GuestAttachment {
                    bridge_name: "vmbr0".to_string(),
                    vlan_tag: None,
                    trunk_vlans: vec![20, 30],
                }),
            },
            Link {
                id: "vyos02-trunk".to_string(),
                local_device_id: bridge_id,
                local_interface: "vmbr0".to_string(),
                local_ip: Some("192.0.2.10/24".to_string()),
                remote_device_id: router_b_id,
                remote_interface: "net0".to_string(),
                remote_ip: None,
                speed_bps: None,
                protocol: LinkProtocol::ProxmoxGuestLink,
                guest_attachment: Some(GuestAttachment {
                    bridge_name: "vmbr0".to_string(),
                    vlan_tag: None,
                    trunk_vlans: vec![20, 30],
                }),
            },
        ];

        let snapshot = build_view_snapshot(
            &topology,
            &DiscoveryTree::default(),
            &DiscoveryStatus::ready(),
        );

        assert_eq!(
            snapshot
                .links
                .iter()
                .filter(|link| {
                    link.guest_attachment.as_ref().is_some_and(|attachment| {
                        attachment.bridge_name == "vmbr0"
                            && attachment.trunk_vlans.as_slice() == [20, 30]
                    })
                })
                .count(),
            2
        );
    }

    #[test]
    fn snapshot_leaves_non_proxmox_guest_attachment_empty() {
        let topology = Topology {
            devices: HashMap::from([
                (
                    "router-1".to_string(),
                    device(
                        "router-1",
                        "core",
                        DeviceRole::Router,
                        DeploymentType::Physical,
                        None,
                        None,
                    ),
                ),
                (
                    "router-2".to_string(),
                    device(
                        "router-2",
                        "edge",
                        DeviceRole::Router,
                        DeploymentType::Physical,
                        None,
                        None,
                    ),
                ),
            ]),
            links: vec![Link {
                id: "lldp-core-edge".to_string(),
                local_device_id: "router-1".to_string(),
                local_interface: "eth0".to_string(),
                local_ip: Some("198.51.100.1/24".to_string()),
                remote_device_id: "router-2".to_string(),
                remote_interface: "eth1".to_string(),
                remote_ip: Some("198.51.100.2/24".to_string()),
                speed_bps: Some(1_000_000_000),
                protocol: LinkProtocol::Lldp,
                guest_attachment: None,
            }],
            updated_at: Utc::now(),
        };

        let snapshot = build_view_snapshot(
            &topology,
            &DiscoveryTree::default(),
            &DiscoveryStatus::ready(),
        );

        assert_eq!(snapshot.links.len(), 1);
        assert_eq!(snapshot.links[0].protocol, "lldp");
        assert_eq!(snapshot.links[0].guest_attachment, None);
    }
}
