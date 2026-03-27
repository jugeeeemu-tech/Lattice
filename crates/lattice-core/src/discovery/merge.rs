use std::collections::HashSet;

use chrono::Utc;

use crate::{graph::GraphStore, proxmox::attach_proxmox_uplinks};

use super::{DiscoveryResult, DiscoveryTree, SourceResult};

pub fn merge_source_results(results: Vec<SourceResult>) -> DiscoveryResult {
    let mut store = GraphStore::default();
    let mut seen_row_ids = HashSet::new();
    let mut nodes = Vec::new();

    for result in results {
        let id_map = store.absorb_topology(&result.topology);
        let mut source_nodes = result.tree.nodes;
        source_nodes.sort_by(|left, right| left.row_id.cmp(&right.row_id));

        for mut node in source_nodes {
            if let Some(mapped_id) = id_map.get(&node.device_id) {
                node.device_id = mapped_id.clone();
            }
            if seen_row_ids.insert(node.row_id.clone()) {
                nodes.push(node);
            }
        }
    }

    nodes.sort_by(|left, right| left.row_id.cmp(&right.row_id));

    let mut topology = store.topology();
    attach_proxmox_uplinks(&mut topology);

    DiscoveryResult {
        topology,
        tree: DiscoveryTree { nodes },
        discovered_at: Utc::now(),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use chrono::{TimeZone, Utc};

    use super::*;
    use crate::graph::{
        Device, DeviceKind, DeviceStatus, IdentityKeys, Interface, LinkProtocol, OperStatus,
        Topology,
    };

    fn device(id: &str, kind: DeviceKind) -> Device {
        Device {
            id: id.to_string(),
            identity_keys: IdentityKeys {
                chassis_id: None,
                sys_name: Some(id.to_string()),
                mgmt_ip: None,
            },
            sys_descr: id.to_string(),
            vendor: "test".to_string(),
            model: None,
            device_kind: kind,
            interfaces: vec![Interface {
                if_index: 1,
                if_name: "eth0".to_string(),
                ip_addresses: Vec::new(),
                speed_bps: None,
                oper_status: OperStatus::Up,
            }],
            status: DeviceStatus::Up,
            host_label: None,
            host_mgmt_ip: None,
            uplink_interface: None,
            last_seen: Utc.with_ymd_and_hms(2026, 3, 27, 0, 0, 0).unwrap(),
        }
    }

    #[test]
    fn merge_keeps_all_tree_nodes() {
        let first = SourceResult {
            topology: Topology {
                devices: HashMap::from([(
                    "router-1".to_string(),
                    device("router-1", DeviceKind::Router),
                )]),
                links: Vec::new(),
                updated_at: Utc::now(),
            },
            tree: DiscoveryTree {
                nodes: vec![crate::discovery::DiscoveryTreeNode {
                    row_id: "seed:192.0.2.1/router-1#1".to_string(),
                    device_id: "router-1".to_string(),
                    parent_row_id: None,
                    label: Some("router-1".to_string()),
                    depth: 0,
                }],
            },
        };
        let second = SourceResult {
            topology: Topology {
                devices: HashMap::from([(
                    "proxmox:pve-1:bridge:vmbr0".to_string(),
                    device("proxmox:pve-1:bridge:vmbr0", DeviceKind::Bridge),
                )]),
                links: Vec::new(),
                updated_at: Utc::now(),
            },
            tree: DiscoveryTree {
                nodes: vec![crate::discovery::DiscoveryTreeNode {
                    row_id: "proxmox:pve-1:bridge:vmbr0".to_string(),
                    device_id: "proxmox:pve-1:bridge:vmbr0".to_string(),
                    parent_row_id: None,
                    label: Some("vmbr0".to_string()),
                    depth: 0,
                }],
            },
        };

        let merged = merge_source_results(vec![first, second]);

        assert_eq!(merged.topology.devices.len(), 2);
        assert_eq!(merged.tree.nodes.len(), 2);
    }

    #[test]
    fn merge_adds_proxmox_uplink_after_absorbing_topologies() {
        let bridge = Device {
            id: "proxmox:pve-1:bridge:vmbr0".to_string(),
            identity_keys: IdentityKeys {
                chassis_id: None,
                sys_name: Some("vmbr0".to_string()),
                mgmt_ip: Some("192.0.2.10".to_string()),
            },
            sys_descr: "Proxmox bridge".to_string(),
            vendor: "proxmox".to_string(),
            model: None,
            device_kind: DeviceKind::Bridge,
            interfaces: vec![
                Interface {
                    if_index: 0,
                    if_name: "vmbr0".to_string(),
                    ip_addresses: vec!["192.0.2.10/24".to_string()],
                    speed_bps: None,
                    oper_status: OperStatus::Up,
                },
                Interface {
                    if_index: 1,
                    if_name: "eno1".to_string(),
                    ip_addresses: Vec::new(),
                    speed_bps: None,
                    oper_status: OperStatus::Up,
                },
            ],
            status: DeviceStatus::Up,
            host_label: Some("pve-1".to_string()),
            host_mgmt_ip: Some("192.0.2.10".to_string()),
            uplink_interface: Some("eno1".to_string()),
            last_seen: Utc::now(),
        };
        let physical = Device {
            id: "host-1".to_string(),
            identity_keys: IdentityKeys {
                chassis_id: None,
                sys_name: Some("pve-1".to_string()),
                mgmt_ip: Some("192.0.2.10".to_string()),
            },
            sys_descr: "Linux host".to_string(),
            vendor: "generic".to_string(),
            model: None,
            device_kind: DeviceKind::PhysicalServer,
            interfaces: vec![Interface {
                if_index: 1,
                if_name: "eno1".to_string(),
                ip_addresses: vec!["192.0.2.11/24".to_string()],
                speed_bps: Some(1_000_000_000),
                oper_status: OperStatus::Up,
            }],
            status: DeviceStatus::Up,
            host_label: None,
            host_mgmt_ip: None,
            uplink_interface: None,
            last_seen: Utc::now(),
        };

        let merged = merge_source_results(vec![
            SourceResult {
                topology: Topology {
                    devices: HashMap::from([(bridge.id.clone(), bridge)]),
                    links: Vec::new(),
                    updated_at: Utc::now(),
                },
                tree: DiscoveryTree::default(),
            },
            SourceResult {
                topology: Topology {
                    devices: HashMap::from([(physical.id.clone(), physical)]),
                    links: Vec::new(),
                    updated_at: Utc::now(),
                },
                tree: DiscoveryTree::default(),
            },
        ]);

        assert!(merged
            .topology
            .links
            .iter()
            .any(|link| link.protocol == LinkProtocol::ProxmoxUplink));
    }
}
