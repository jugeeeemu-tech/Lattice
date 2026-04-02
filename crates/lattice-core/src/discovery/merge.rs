use std::collections::{HashMap, HashSet};

use chrono::Utc;

use crate::{
    graph::{GraphStore, LinkProtocol, Topology},
    proxmox::attach_proxmox_uplinks,
};

use super::{DiscoveryResult, DiscoveryTree, DiscoveryTreeNode, SourceResult};

pub fn merge_source_results(results: Vec<SourceResult>) -> DiscoveryResult {
    let mut store = GraphStore::default();
    let mut merged_source_nodes = Vec::new();

    for (source_index, result) in results.into_iter().enumerate() {
        let id_map = store.absorb_topology(&result.topology);
        merged_source_nodes.extend(remap_tree_nodes(&result.tree, &id_map, source_index));
    }

    let mut topology = store.topology();
    attach_proxmox_uplinks(&mut topology);
    let tree = if merged_source_nodes.is_empty() {
        build_internal_tree(&topology)
    } else {
        preserve_source_tree(&topology, merged_source_nodes)
    };

    DiscoveryResult {
        topology,
        tree,
        discovered_at: Utc::now(),
    }
}

fn remap_tree_nodes(
    tree: &DiscoveryTree,
    id_map: &HashMap<String, String>,
    source_index: usize,
) -> Vec<DiscoveryTreeNode> {
    let mut row_id_by_original = HashMap::new();
    let mut occurrence_by_scope_device = HashMap::new();
    let mut nodes = Vec::new();

    for node in &tree.nodes {
        let canonical_device_id = id_map
            .get(&node.device_id)
            .cloned()
            .unwrap_or_else(|| node.device_id.clone());
        let parent_row_id = node
            .parent_row_id
            .as_ref()
            .and_then(|row_id| row_id_by_original.get(row_id))
            .cloned();
        let scope_key = parent_row_id
            .clone()
            .unwrap_or_else(|| format!("source:{source_index}"));
        let occurrence_key = format!("{scope_key}::{canonical_device_id}");
        let occurrence = occurrence_by_scope_device
            .entry(occurrence_key)
            .and_modify(|value| *value += 1)
            .or_insert(1usize);
        let row_id = parent_row_id
            .as_ref()
            .map(|parent| format!("{parent}/{canonical_device_id}#{occurrence}"))
            .unwrap_or_else(|| format!("source:{source_index}/{canonical_device_id}#{occurrence}"));

        row_id_by_original.insert(node.row_id.clone(), row_id.clone());
        nodes.push(DiscoveryTreeNode {
            row_id,
            device_id: canonical_device_id,
            parent_row_id,
            label: node.label.clone(),
            depth: node.depth,
        });
    }

    nodes
}

fn preserve_source_tree(
    topology: &Topology,
    source_nodes: Vec<DiscoveryTreeNode>,
) -> DiscoveryTree {
    let filtered_nodes = source_nodes
        .into_iter()
        .filter(|node| include_in_tree(topology, &node.device_id))
        .collect::<Vec<_>>();

    if filtered_nodes.is_empty() {
        return build_internal_tree(topology);
    }

    let source_node_by_row_id = filtered_nodes
        .iter()
        .map(|node| (node.row_id.clone(), node))
        .collect::<HashMap<_, _>>();
    let mut chosen_node_by_device = HashMap::new();

    for node in &filtered_nodes {
        let parent_device_id = node.parent_row_id.as_ref().and_then(|parent_row_id| {
            source_node_by_row_id
                .get(parent_row_id)
                .map(|parent| parent.device_id.clone())
        });
        let should_replace = chosen_node_by_device
            .get(&node.device_id)
            .map(|current: &(DiscoveryTreeNode, Option<String>)| {
                source_node_sort_key(topology, node, parent_device_id.as_deref())
                    < source_node_sort_key(topology, &current.0, current.1.as_deref())
            })
            .unwrap_or(true);

        if should_replace {
            chosen_node_by_device.insert(node.device_id.clone(), (node.clone(), parent_device_id));
        }
    }

    let mut children_by_parent: HashMap<String, Vec<String>> = HashMap::new();
    let mut covered_device_ids = HashSet::new();

    for (device_id, (node, parent_device_id)) in &chosen_node_by_device {
        covered_device_ids.insert(device_id.clone());
        if let Some(parent_device_id) = parent_device_id {
            if parent_device_id != device_id && chosen_node_by_device.contains_key(parent_device_id)
            {
                children_by_parent
                    .entry(parent_device_id.clone())
                    .or_default()
                    .push(node.device_id.clone());
            }
        }
    }

    for children in children_by_parent.values_mut() {
        children.sort_by(|left, right| {
            device_sort_key(topology, left).cmp(&device_sort_key(topology, right))
        });
    }

    let mut roots = chosen_node_by_device
        .keys()
        .filter(|device_id| {
            !chosen_node_by_device
                .get(*device_id)
                .and_then(|(_, parent_device_id)| parent_device_id.as_ref())
                .is_some_and(|parent_device_id| {
                    parent_device_id != *device_id
                        && chosen_node_by_device.contains_key(parent_device_id)
                })
        })
        .cloned()
        .collect::<Vec<_>>();
    roots.sort_by(|left, right| {
        device_sort_key(topology, left).cmp(&device_sort_key(topology, right))
    });

    let mut visited = HashSet::new();
    let mut nodes = Vec::new();
    for root_id in roots {
        walk_tree(
            topology,
            &root_id,
            None,
            0,
            &children_by_parent,
            &mut visited,
            &mut nodes,
        );
    }

    let fallback_tree = build_internal_tree(topology);
    for node in fallback_tree.nodes {
        if covered_device_ids.contains(&node.device_id) {
            continue;
        }
        nodes.push(node);
    }

    DiscoveryTree { nodes }
}

fn source_node_sort_key(
    topology: &Topology,
    node: &DiscoveryTreeNode,
    parent_device_id: Option<&str>,
) -> (u32, String, String, String) {
    let parent_key = parent_device_id
        .map(|device_id| device_sort_key(topology, device_id).0)
        .unwrap_or_default();
    let device_key = device_sort_key(topology, &node.device_id).0;
    (node.depth, parent_key, device_key, node.row_id.clone())
}

fn build_internal_tree(topology: &Topology) -> DiscoveryTree {
    let mut device_ids = topology
        .devices
        .keys()
        .filter(|device_id| include_in_tree(topology, device_id))
        .cloned()
        .collect::<Vec<_>>();
    device_ids.sort_by(|left, right| {
        device_sort_key(topology, left).cmp(&device_sort_key(topology, right))
    });

    let visible_device_ids = device_ids.iter().cloned().collect::<HashSet<_>>();
    let parent_by_device = device_ids
        .iter()
        .filter_map(|device_id| {
            determine_parent(topology, device_id).and_then(|parent_id| {
                (visible_device_ids.contains(&parent_id) && parent_id != *device_id)
                    .then_some((device_id.clone(), parent_id))
            })
        })
        .collect::<HashMap<_, _>>();

    let mut children_by_parent: HashMap<String, Vec<String>> = HashMap::new();
    for (device_id, parent_id) in &parent_by_device {
        children_by_parent
            .entry(parent_id.clone())
            .or_default()
            .push(device_id.clone());
    }
    for children in children_by_parent.values_mut() {
        children.sort_by(|left, right| {
            device_sort_key(topology, left).cmp(&device_sort_key(topology, right))
        });
    }

    let roots = device_ids
        .iter()
        .filter(|device_id| !parent_by_device.contains_key(*device_id))
        .cloned()
        .collect::<Vec<_>>();

    let mut visited = HashSet::new();
    let mut nodes = Vec::new();
    for root_id in roots {
        walk_tree(
            topology,
            &root_id,
            None,
            0,
            &children_by_parent,
            &mut visited,
            &mut nodes,
        );
    }

    for device_id in device_ids {
        if !visited.contains(&device_id) {
            walk_tree(
                topology,
                &device_id,
                None,
                0,
                &children_by_parent,
                &mut visited,
                &mut nodes,
            );
        }
    }

    DiscoveryTree { nodes }
}

fn walk_tree(
    topology: &Topology,
    device_id: &str,
    parent_row_id: Option<String>,
    depth: u32,
    children_by_parent: &HashMap<String, Vec<String>>,
    visited: &mut HashSet<String>,
    nodes: &mut Vec<DiscoveryTreeNode>,
) {
    if !visited.insert(device_id.to_string()) {
        return;
    }

    nodes.push(DiscoveryTreeNode {
        row_id: device_id.to_string(),
        device_id: device_id.to_string(),
        parent_row_id: parent_row_id.clone(),
        label: topology.devices.get(device_id).map(|device| device.label()),
        depth,
    });

    if let Some(children) = children_by_parent.get(device_id) {
        for child_id in children {
            walk_tree(
                topology,
                child_id,
                Some(device_id.to_string()),
                depth + 1,
                children_by_parent,
                visited,
                nodes,
            );
        }
    }
}

fn determine_parent(topology: &Topology, device_id: &str) -> Option<String> {
    let device = topology.devices.get(device_id)?;
    if is_proxmox_node(device_id) || device.device_role == crate::DeviceRole::Bridge {
        return None;
    }

    if let Some(parent_id) = proxmox_bridge_parent(topology, device_id) {
        return Some(parent_id);
    }

    let upstream_interface = device.upstream_interface.as_deref()?.trim();
    if upstream_interface.is_empty() {
        return None;
    }

    unique_parent_from_links(
        topology,
        device_id,
        |link| link.protocol == LinkProtocol::Lldp,
        |link, is_local| {
            if is_local {
                (link.local_interface == upstream_interface).then(|| link.remote_device_id.clone())
            } else {
                (link.remote_interface == upstream_interface).then(|| link.local_device_id.clone())
            }
        },
    )
}

fn proxmox_bridge_parent(topology: &Topology, device_id: &str) -> Option<String> {
    unique_parent_from_links(
        topology,
        device_id,
        |link| link.protocol == LinkProtocol::ProxmoxGuestLink,
        |link, is_local| {
            let candidate_id = if is_local {
                link.remote_device_id.clone()
            } else {
                link.local_device_id.clone()
            };
            topology
                .devices
                .get(&candidate_id)
                .filter(|device| device.device_role == crate::DeviceRole::Bridge)
                .map(|_| candidate_id)
        },
    )
}

fn unique_parent_from_links<F, G>(
    topology: &Topology,
    device_id: &str,
    protocol_filter: F,
    candidate_for_link: G,
) -> Option<String>
where
    F: Fn(&crate::Link) -> bool,
    G: Fn(&crate::Link, bool) -> Option<String>,
{
    let candidates = topology
        .links
        .iter()
        .filter(|link| protocol_filter(link))
        .filter_map(|link| {
            if link.local_device_id == device_id {
                candidate_for_link(link, true)
            } else if link.remote_device_id == device_id {
                candidate_for_link(link, false)
            } else {
                None
            }
        })
        .filter(|candidate_id| include_in_tree(topology, candidate_id))
        .collect::<HashSet<_>>();

    if candidates.len() == 1 {
        candidates.into_iter().next()
    } else {
        None
    }
}

fn include_in_tree(topology: &Topology, device_id: &str) -> bool {
    topology
        .devices
        .get(device_id)
        .is_some_and(|_| !is_proxmox_node(device_id))
}

fn is_proxmox_node(device_id: &str) -> bool {
    device_id.starts_with("proxmox:") && device_id.ends_with(":node")
}

fn device_sort_key(topology: &Topology, device_id: &str) -> (String, String) {
    let label = topology
        .devices
        .get(device_id)
        .map(|device| device.label().to_ascii_lowercase())
        .unwrap_or_else(|| device_id.to_ascii_lowercase());
    (label, device_id.to_string())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use chrono::{TimeZone, Utc};

    use super::*;
    use crate::graph::{
        DeploymentType, Device, DeviceRole, DeviceStatus, IdentityKeys, Interface, Link,
        LinkProtocol, OperStatus, Topology,
    };

    fn device(id: &str, role: DeviceRole, deployment_type: DeploymentType) -> Device {
        Device {
            id: id.to_string(),
            identity_keys: IdentityKeys {
                chassis_id: None,
                sys_name: Some(id.to_string()),
                mgmt_ip: None,
                mac_addresses: Vec::new(),
            },
            sys_descr: id.to_string(),
            vendor: "test".to_string(),
            model: None,
            device_role: role,
            deployment_type,
            guest_kind: None,
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
            upstream_interface: None,
            last_seen: Utc.with_ymd_and_hms(2026, 3, 27, 0, 0, 0).unwrap(),
        }
    }

    fn source_result(topology: Topology) -> SourceResult {
        SourceResult {
            topology,
            tree: DiscoveryTree::default(),
        }
    }

    #[test]
    fn merge_preserves_source_tree_structure() {
        let first = SourceResult {
            topology: Topology {
                devices: HashMap::from([(
                    "router-1".to_string(),
                    device("router-1", DeviceRole::Router, DeploymentType::Unknown),
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
                    device(
                        "proxmox:pve-1:bridge:vmbr0",
                        DeviceRole::Bridge,
                        DeploymentType::Virtual,
                    ),
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
        let router = merged
            .tree
            .nodes
            .iter()
            .find(|node| node.device_id == "router-1")
            .expect("router-1 should exist");
        let bridge = merged
            .tree
            .nodes
            .iter()
            .find(|node| node.device_id == "proxmox:pve-1:bridge:vmbr0")
            .expect("bridge should exist");
        assert_eq!(router.row_id, "router-1");
        assert_eq!(router.parent_row_id, None);
        assert_eq!(bridge.row_id, "proxmox:pve-1:bridge:vmbr0");
        assert_eq!(bridge.parent_row_id, None);
    }

    #[test]
    fn merge_deduplicates_revisited_devices_in_source_tree() {
        let result = SourceResult {
            topology: Topology {
                devices: HashMap::from([
                    (
                        "seed-router".to_string(),
                        device("seed-router", DeviceRole::Router, DeploymentType::Unknown),
                    ),
                    (
                        "child-switch".to_string(),
                        device("child-switch", DeviceRole::Switch, DeploymentType::Unknown),
                    ),
                ]),
                links: vec![Link {
                    id: "seed-router:eth1->child-switch:eth1:lldp".to_string(),
                    local_device_id: "seed-router".to_string(),
                    local_interface: "eth1".to_string(),
                    local_ip: None,
                    remote_device_id: "child-switch".to_string(),
                    remote_interface: "eth1".to_string(),
                    remote_ip: None,
                    speed_bps: None,
                    protocol: LinkProtocol::Lldp,
                    guest_attachment: None,
                }],
                updated_at: Utc::now(),
            },
            tree: DiscoveryTree {
                nodes: vec![
                    crate::discovery::DiscoveryTreeNode {
                        row_id: "seed:192.0.2.1/seed-router#1".to_string(),
                        device_id: "seed-router".to_string(),
                        parent_row_id: None,
                        label: Some("seed-router".to_string()),
                        depth: 0,
                    },
                    crate::discovery::DiscoveryTreeNode {
                        row_id: "seed:192.0.2.1/seed-router#1/child-switch#1".to_string(),
                        device_id: "child-switch".to_string(),
                        parent_row_id: Some("seed:192.0.2.1/seed-router#1".to_string()),
                        label: Some("child-switch".to_string()),
                        depth: 1,
                    },
                    crate::discovery::DiscoveryTreeNode {
                        row_id: "seed:192.0.2.1/seed-router#1/child-switch#1/seed-router#1"
                            .to_string(),
                        device_id: "seed-router".to_string(),
                        parent_row_id: Some(
                            "seed:192.0.2.1/seed-router#1/child-switch#1".to_string(),
                        ),
                        label: Some("seed-router".to_string()),
                        depth: 2,
                    },
                ],
            },
        };

        let merged = merge_source_results(vec![result]);

        assert_eq!(merged.tree.nodes.len(), 2);
        assert_eq!(
            merged
                .tree
                .nodes
                .iter()
                .map(|node| node.device_id.as_str())
                .collect::<Vec<_>>(),
            vec!["seed-router", "child-switch"]
        );
    }

    #[test]
    fn merge_prefers_stable_parent_for_redundant_source_paths() {
        let result = SourceResult {
            topology: Topology {
                devices: HashMap::from([
                    (
                        "core-router-1".to_string(),
                        device("core-router-1", DeviceRole::Router, DeploymentType::Unknown),
                    ),
                    (
                        "dist-switch-a".to_string(),
                        device("dist-switch-a", DeviceRole::Switch, DeploymentType::Unknown),
                    ),
                    (
                        "dist-switch-b".to_string(),
                        device("dist-switch-b", DeviceRole::Switch, DeploymentType::Unknown),
                    ),
                    (
                        "core-router-2".to_string(),
                        device("core-router-2", DeviceRole::Router, DeploymentType::Unknown),
                    ),
                ]),
                links: vec![
                    Link {
                        id: "core-router-1:eth1->dist-switch-a:eth1:lldp".to_string(),
                        local_device_id: "core-router-1".to_string(),
                        local_interface: "eth1".to_string(),
                        local_ip: None,
                        remote_device_id: "dist-switch-a".to_string(),
                        remote_interface: "eth1".to_string(),
                        remote_ip: None,
                        speed_bps: None,
                        protocol: LinkProtocol::Lldp,
                        guest_attachment: None,
                    },
                    Link {
                        id: "core-router-1:eth2->dist-switch-b:eth1:lldp".to_string(),
                        local_device_id: "core-router-1".to_string(),
                        local_interface: "eth2".to_string(),
                        local_ip: None,
                        remote_device_id: "dist-switch-b".to_string(),
                        remote_interface: "eth1".to_string(),
                        remote_ip: None,
                        speed_bps: None,
                        protocol: LinkProtocol::Lldp,
                        guest_attachment: None,
                    },
                    Link {
                        id: "core-router-2:eth1->dist-switch-a:eth2:lldp".to_string(),
                        local_device_id: "core-router-2".to_string(),
                        local_interface: "eth1".to_string(),
                        local_ip: None,
                        remote_device_id: "dist-switch-a".to_string(),
                        remote_interface: "eth2".to_string(),
                        remote_ip: None,
                        speed_bps: None,
                        protocol: LinkProtocol::Lldp,
                        guest_attachment: None,
                    },
                    Link {
                        id: "core-router-2:eth2->dist-switch-b:eth2:lldp".to_string(),
                        local_device_id: "core-router-2".to_string(),
                        local_interface: "eth2".to_string(),
                        local_ip: None,
                        remote_device_id: "dist-switch-b".to_string(),
                        remote_interface: "eth2".to_string(),
                        remote_ip: None,
                        speed_bps: None,
                        protocol: LinkProtocol::Lldp,
                        guest_attachment: None,
                    },
                ],
                updated_at: Utc::now(),
            },
            tree: DiscoveryTree {
                nodes: vec![
                    crate::discovery::DiscoveryTreeNode {
                        row_id: "seed:192.0.2.1/core-router-1#1".to_string(),
                        device_id: "core-router-1".to_string(),
                        parent_row_id: None,
                        label: Some("core-router-1".to_string()),
                        depth: 0,
                    },
                    crate::discovery::DiscoveryTreeNode {
                        row_id: "seed:192.0.2.1/core-router-1#1/dist-switch-b#1".to_string(),
                        device_id: "dist-switch-b".to_string(),
                        parent_row_id: Some("seed:192.0.2.1/core-router-1#1".to_string()),
                        label: Some("dist-switch-b".to_string()),
                        depth: 1,
                    },
                    crate::discovery::DiscoveryTreeNode {
                        row_id: "seed:192.0.2.1/core-router-1#1/dist-switch-b#1/core-router-2#1"
                            .to_string(),
                        device_id: "core-router-2".to_string(),
                        parent_row_id: Some(
                            "seed:192.0.2.1/core-router-1#1/dist-switch-b#1".to_string(),
                        ),
                        label: Some("core-router-2".to_string()),
                        depth: 2,
                    },
                    crate::discovery::DiscoveryTreeNode {
                        row_id: "seed:192.0.2.1/core-router-1#1/dist-switch-a#1".to_string(),
                        device_id: "dist-switch-a".to_string(),
                        parent_row_id: Some("seed:192.0.2.1/core-router-1#1".to_string()),
                        label: Some("dist-switch-a".to_string()),
                        depth: 1,
                    },
                    crate::discovery::DiscoveryTreeNode {
                        row_id: "seed:192.0.2.1/core-router-1#1/dist-switch-a#1/core-router-2#1"
                            .to_string(),
                        device_id: "core-router-2".to_string(),
                        parent_row_id: Some(
                            "seed:192.0.2.1/core-router-1#1/dist-switch-a#1".to_string(),
                        ),
                        label: Some("core-router-2".to_string()),
                        depth: 2,
                    },
                ],
            },
        };

        let merged = merge_source_results(vec![result]);
        let core_router_2 = merged
            .tree
            .nodes
            .iter()
            .find(|node| node.device_id == "core-router-2")
            .expect("core-router-2 should exist");

        assert_eq!(
            core_router_2.parent_row_id.as_deref(),
            Some("dist-switch-a")
        );
    }

    #[test]
    fn merge_remaps_child_rows_using_canonical_ids() {
        let source = SourceResult {
            topology: Topology {
                devices: HashMap::from([
                    (
                        "seed-router".to_string(),
                        device("seed-router", DeviceRole::Router, DeploymentType::Unknown),
                    ),
                    (
                        "child-switch".to_string(),
                        device("child-switch", DeviceRole::Switch, DeploymentType::Unknown),
                    ),
                ]),
                links: Vec::new(),
                updated_at: Utc::now(),
            },
            tree: DiscoveryTree {
                nodes: vec![
                    crate::discovery::DiscoveryTreeNode {
                        row_id: "seed:192.0.2.1/seed-router#1".to_string(),
                        device_id: "seed-router".to_string(),
                        parent_row_id: None,
                        label: Some("seed-router".to_string()),
                        depth: 0,
                    },
                    crate::discovery::DiscoveryTreeNode {
                        row_id: "seed:192.0.2.1/seed-router#1/child-switch#1".to_string(),
                        device_id: "child-switch".to_string(),
                        parent_row_id: Some("seed:192.0.2.1/seed-router#1".to_string()),
                        label: Some("child-switch".to_string()),
                        depth: 1,
                    },
                ],
            },
        };

        let merged = merge_source_results(vec![source]);

        assert_eq!(merged.tree.nodes.len(), 2);
        assert_eq!(merged.tree.nodes[0].row_id, "seed-router");
        assert_eq!(
            merged.tree.nodes[1].parent_row_id.as_deref(),
            Some("seed-router")
        );
        assert_eq!(merged.tree.nodes[1].row_id, "child-switch");
    }

    #[test]
    fn merge_adds_proxmox_uplink_after_absorbing_topologies() {
        let bridge = Device {
            id: "proxmox:pve-1:bridge:vmbr0".to_string(),
            identity_keys: IdentityKeys {
                chassis_id: None,
                sys_name: Some("vmbr0".to_string()),
                mgmt_ip: Some("192.0.2.10".to_string()),
                mac_addresses: Vec::new(),
            },
            sys_descr: "Proxmox bridge".to_string(),
            vendor: "proxmox".to_string(),
            model: None,
            device_role: DeviceRole::Bridge,
            deployment_type: DeploymentType::Virtual,
            guest_kind: None,
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
            upstream_interface: Some("eno1".to_string()),
            last_seen: Utc::now(),
        };
        let physical = Device {
            id: "host-1".to_string(),
            identity_keys: IdentityKeys {
                chassis_id: None,
                sys_name: Some("pve-1".to_string()),
                mgmt_ip: Some("192.0.2.10".to_string()),
                mac_addresses: Vec::new(),
            },
            sys_descr: "Linux host".to_string(),
            vendor: "generic".to_string(),
            model: None,
            device_role: DeviceRole::Server,
            deployment_type: DeploymentType::Physical,
            guest_kind: None,
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
            upstream_interface: None,
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

    #[test]
    fn route_based_tree_uses_unique_lldp_neighbor_on_upstream_interface() {
        let mut core = device("router-1", DeviceRole::Router, DeploymentType::Unknown);
        core.identity_keys.sys_name = Some("core".to_string());
        core.interfaces = vec![Interface {
            if_index: 1,
            if_name: "eth0".to_string(),
            ip_addresses: Vec::new(),
            speed_bps: None,
            oper_status: OperStatus::Up,
        }];

        let mut edge = device("router-2", DeviceRole::Router, DeploymentType::Unknown);
        edge.identity_keys.sys_name = Some("edge".to_string());
        edge.upstream_interface = Some("eth1".to_string());
        edge.interfaces = vec![Interface {
            if_index: 1,
            if_name: "eth1".to_string(),
            ip_addresses: Vec::new(),
            speed_bps: None,
            oper_status: OperStatus::Up,
        }];

        let merged = merge_source_results(vec![source_result(Topology {
            devices: HashMap::from([
                (core.id.clone(), core.clone()),
                (edge.id.clone(), edge.clone()),
            ]),
            links: vec![Link {
                id: "lldp-core-edge".to_string(),
                local_device_id: edge.id.clone(),
                local_interface: "eth1".to_string(),
                local_ip: None,
                remote_device_id: core.id.clone(),
                remote_interface: "eth0".to_string(),
                remote_ip: None,
                speed_bps: None,
                protocol: LinkProtocol::Lldp,
                guest_attachment: None,
            }],
            updated_at: Utc::now(),
        })]);

        let edge_node = merged
            .tree
            .nodes
            .iter()
            .find(|node| node.device_id == "router-2")
            .unwrap();

        assert_eq!(edge_node.parent_row_id.as_deref(), Some("router-1"));
        assert_eq!(edge_node.depth, 1);
    }

    #[test]
    fn upstream_interface_without_unique_lldp_parent_stays_root() {
        let mut edge = device("router-2", DeviceRole::Router, DeploymentType::Unknown);
        edge.upstream_interface = Some("eth1".to_string());
        edge.interfaces = vec![Interface {
            if_index: 1,
            if_name: "eth1".to_string(),
            ip_addresses: Vec::new(),
            speed_bps: None,
            oper_status: OperStatus::Up,
        }];
        let mut core_a = device("router-a", DeviceRole::Router, DeploymentType::Unknown);
        core_a.interfaces = vec![Interface {
            if_index: 1,
            if_name: "eth0".to_string(),
            ip_addresses: Vec::new(),
            speed_bps: None,
            oper_status: OperStatus::Up,
        }];
        let mut core_b = device("router-b", DeviceRole::Router, DeploymentType::Unknown);
        core_b.interfaces = vec![Interface {
            if_index: 1,
            if_name: "eth0".to_string(),
            ip_addresses: Vec::new(),
            speed_bps: None,
            oper_status: OperStatus::Up,
        }];

        let merged = merge_source_results(vec![source_result(Topology {
            devices: HashMap::from([
                (edge.id.clone(), edge.clone()),
                (core_a.id.clone(), core_a.clone()),
                (core_b.id.clone(), core_b.clone()),
            ]),
            links: vec![
                Link {
                    id: "lldp-a".to_string(),
                    local_device_id: edge.id.clone(),
                    local_interface: "eth1".to_string(),
                    local_ip: None,
                    remote_device_id: core_a.id.clone(),
                    remote_interface: "eth0".to_string(),
                    remote_ip: None,
                    speed_bps: None,
                    protocol: LinkProtocol::Lldp,
                    guest_attachment: None,
                },
                Link {
                    id: "lldp-b".to_string(),
                    local_device_id: edge.id.clone(),
                    local_interface: "eth1".to_string(),
                    local_ip: None,
                    remote_device_id: core_b.id.clone(),
                    remote_interface: "eth0".to_string(),
                    remote_ip: None,
                    speed_bps: None,
                    protocol: LinkProtocol::Lldp,
                    guest_attachment: None,
                },
            ],
            updated_at: Utc::now(),
        })]);

        let edge_node = merged
            .tree
            .nodes
            .iter()
            .find(|node| node.device_id == "router-2")
            .unwrap();

        assert!(edge_node.parent_row_id.is_none());
        assert_eq!(edge_node.depth, 0);
    }

    #[test]
    fn merged_virtual_router_prefers_unique_bridge_parent_over_route_parent() {
        let bridge = device(
            "proxmox:pve-1:bridge:vmbr0",
            DeviceRole::Bridge,
            DeploymentType::Virtual,
        );
        let upstream = device("router-1", DeviceRole::Router, DeploymentType::Physical);
        let mut guest = device("device-1", DeviceRole::Router, DeploymentType::Virtual);
        guest.host_label = Some("pve-1".to_string());
        guest.upstream_interface = Some("eth1".to_string());
        guest.interfaces = vec![
            Interface {
                if_index: 1,
                if_name: "eth1".to_string(),
                ip_addresses: Vec::new(),
                speed_bps: None,
                oper_status: OperStatus::Up,
            },
            Interface {
                if_index: 2,
                if_name: "net0".to_string(),
                ip_addresses: Vec::new(),
                speed_bps: None,
                oper_status: OperStatus::Up,
            },
            Interface {
                if_index: 3,
                if_name: "net1".to_string(),
                ip_addresses: Vec::new(),
                speed_bps: None,
                oper_status: OperStatus::Up,
            },
        ];

        let merged = merge_source_results(vec![source_result(Topology {
            devices: HashMap::from([
                (bridge.id.clone(), bridge.clone()),
                (upstream.id.clone(), upstream.clone()),
                (guest.id.clone(), guest.clone()),
            ]),
            links: vec![
                Link {
                    id: "guest-link-a".to_string(),
                    local_device_id: bridge.id.clone(),
                    local_interface: "vmbr0".to_string(),
                    local_ip: None,
                    remote_device_id: guest.id.clone(),
                    remote_interface: "net0".to_string(),
                    remote_ip: None,
                    speed_bps: None,
                    protocol: LinkProtocol::ProxmoxGuestLink,
                    guest_attachment: None,
                },
                Link {
                    id: "guest-link-b".to_string(),
                    local_device_id: bridge.id.clone(),
                    local_interface: "vmbr0".to_string(),
                    local_ip: None,
                    remote_device_id: guest.id.clone(),
                    remote_interface: "net1".to_string(),
                    remote_ip: None,
                    speed_bps: None,
                    protocol: LinkProtocol::ProxmoxGuestLink,
                    guest_attachment: None,
                },
                Link {
                    id: "lldp-upstream".to_string(),
                    local_device_id: guest.id.clone(),
                    local_interface: "eth1".to_string(),
                    local_ip: None,
                    remote_device_id: upstream.id.clone(),
                    remote_interface: "eth0".to_string(),
                    remote_ip: None,
                    speed_bps: None,
                    protocol: LinkProtocol::Lldp,
                    guest_attachment: None,
                },
            ],
            updated_at: Utc::now(),
        })]);

        let guest_node = merged
            .tree
            .nodes
            .iter()
            .find(|node| node.device_id == guest.id)
            .unwrap();

        assert_eq!(
            guest_node.parent_row_id.as_deref(),
            Some(bridge.id.as_str())
        );
        assert_eq!(guest_node.depth, 1);
    }

    #[test]
    fn guest_becomes_bridge_child_only_when_guest_link_exists() {
        let bridge = device(
            "proxmox:pve-1:bridge:vmbr0",
            DeviceRole::Bridge,
            DeploymentType::Virtual,
        );
        let guest = device(
            "proxmox:pve-1:qemu:100",
            DeviceRole::Server,
            DeploymentType::Virtual,
        );

        let with_link = merge_source_results(vec![source_result(Topology {
            devices: HashMap::from([
                (bridge.id.clone(), bridge.clone()),
                (guest.id.clone(), guest.clone()),
            ]),
            links: vec![Link {
                id: "guest-link".to_string(),
                local_device_id: bridge.id.clone(),
                local_interface: "vmbr0".to_string(),
                local_ip: None,
                remote_device_id: guest.id.clone(),
                remote_interface: "net0".to_string(),
                remote_ip: None,
                speed_bps: None,
                protocol: LinkProtocol::ProxmoxGuestLink,
                guest_attachment: None,
            }],
            updated_at: Utc::now(),
        })]);
        let without_link = merge_source_results(vec![source_result(Topology {
            devices: HashMap::from([
                (bridge.id.clone(), bridge.clone()),
                (guest.id.clone(), guest.clone()),
            ]),
            links: Vec::new(),
            updated_at: Utc::now(),
        })]);

        assert_eq!(
            with_link
                .tree
                .nodes
                .iter()
                .find(|node| node.device_id == "proxmox:pve-1:qemu:100")
                .and_then(|node| node.parent_row_id.as_deref()),
            Some("proxmox:pve-1:bridge:vmbr0")
        );
        assert!(without_link
            .tree
            .nodes
            .iter()
            .find(|node| node.device_id == "proxmox:pve-1:qemu:100")
            .unwrap()
            .parent_row_id
            .is_none());
    }

    #[test]
    fn tree_skips_proxmox_node_devices_and_keeps_devices_unique() {
        let bridge = device(
            "proxmox:pve-1:bridge:vmbr0",
            DeviceRole::Bridge,
            DeploymentType::Virtual,
        );
        let guest = device(
            "proxmox:pve-1:qemu:100",
            DeviceRole::Server,
            DeploymentType::Virtual,
        );
        let node = device(
            "proxmox:pve-1:node",
            DeviceRole::Server,
            DeploymentType::Physical,
        );

        let merged = merge_source_results(vec![source_result(Topology {
            devices: HashMap::from([
                (bridge.id.clone(), bridge.clone()),
                (guest.id.clone(), guest.clone()),
                (node.id.clone(), node.clone()),
            ]),
            links: vec![Link {
                id: "guest-link".to_string(),
                local_device_id: bridge.id.clone(),
                local_interface: "vmbr0".to_string(),
                local_ip: None,
                remote_device_id: guest.id.clone(),
                remote_interface: "net0".to_string(),
                remote_ip: None,
                speed_bps: None,
                protocol: LinkProtocol::ProxmoxGuestLink,
                guest_attachment: None,
            }],
            updated_at: Utc::now(),
        })]);

        assert_eq!(merged.tree.nodes.len(), 2);
        assert!(merged
            .tree
            .nodes
            .iter()
            .all(|node| node.device_id != "proxmox:pve-1:node"));
        assert_eq!(
            merged
                .tree
                .nodes
                .iter()
                .filter(|node| node.device_id == "proxmox:pve-1:qemu:100")
                .count(),
            1
        );
    }
}
