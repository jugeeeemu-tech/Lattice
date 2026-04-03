use std::collections::{BTreeSet, HashMap, HashSet};

use chrono::Utc;

use crate::{
    graph::{GraphStore, LinkProtocol, Topology},
    proxmox::attach_proxmox_uplinks,
};

use super::{
    DeviceRelations, DiscoveryRelations, DiscoveryResult, DiscoveryTree, DiscoveryTreeNode,
    SourceResult,
};

pub fn merge_source_results(results: Vec<SourceResult>) -> DiscoveryResult {
    let mut store = GraphStore::default();
    let mut merged_source_nodes = Vec::new();

    for (source_index, result) in results.into_iter().enumerate() {
        let id_map = store.absorb_topology(&result.topology);
        merged_source_nodes.extend(remap_tree_nodes(&result.tree, &id_map, source_index));
    }

    let mut topology = store.topology();
    attach_proxmox_uplinks(&mut topology);
    let base_tree = if merged_source_nodes.is_empty() {
        build_internal_tree_base(&topology)
    } else {
        preserve_source_tree_base(&topology, merged_source_nodes)
    };
    let (tree, relations) = infer_display_tree(&topology, base_tree);

    DiscoveryResult {
        topology,
        tree,
        relations,
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

fn preserve_source_tree_base(
    topology: &Topology,
    source_nodes: Vec<DiscoveryTreeNode>,
) -> DiscoveryTree {
    let filtered_nodes = source_nodes
        .into_iter()
        .filter(|node| include_in_tree(topology, &node.device_id))
        .collect::<Vec<_>>();

    if filtered_nodes.is_empty() {
        return build_internal_tree_base(topology);
    }

    let source_node_by_row_id = filtered_nodes
        .iter()
        .map(|node| (node.row_id.clone(), node))
        .collect::<HashMap<_, _>>();
    let mut chosen_node_by_device = HashMap::new();
    let mut source_children_by_device: HashMap<String, Vec<String>> = HashMap::new();

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

    for (device_id, (_, parent_device_id)) in &chosen_node_by_device {
        if let Some(parent_device_id) = parent_device_id {
            if parent_device_id != device_id {
                source_children_by_device
                    .entry(parent_device_id.clone())
                    .or_default()
                    .push(device_id.clone());
            }
        }
    }

    let visible_device_ids = chosen_node_by_device
        .keys()
        .cloned()
        .collect::<HashSet<_>>();
    let resolved_parent_by_device = chosen_node_by_device
        .iter()
        .filter_map(|(device_id, (_, parent_device_id))| {
            let source_parent = parent_device_id
                .as_ref()
                .filter(|parent_id| {
                    *parent_id != device_id && visible_device_ids.contains(*parent_id)
                })
                .cloned();
            let inferred_parent = source_parent.or_else(|| {
                if source_children_by_device.contains_key(device_id) {
                    None
                } else {
                    unique_visible_lldp_parent(topology, device_id, &visible_device_ids)
                }
            });

            inferred_parent.map(|parent_id| (device_id.clone(), parent_id))
        })
        .collect::<HashMap<_, _>>();

    let mut children_by_parent: HashMap<String, Vec<String>> = HashMap::new();
    let mut covered_device_ids = HashSet::new();

    for (device_id, (node, _)) in &chosen_node_by_device {
        covered_device_ids.insert(device_id.clone());
        if let Some(parent_device_id) = resolved_parent_by_device.get(device_id) {
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
        .filter(|device_id| !resolved_parent_by_device.contains_key(*device_id))
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

    let fallback_tree = build_internal_tree_base(topology);
    let depth_by_device = nodes
        .iter()
        .map(|node| (node.device_id.clone(), node.depth))
        .collect::<HashMap<_, _>>();

    for mut node in fallback_tree.nodes {
        if covered_device_ids.contains(&node.device_id) {
            continue;
        }
        if node.parent_row_id.is_none() {
            if let Some(parent_device_id) =
                unique_visible_lldp_parent(topology, &node.device_id, &covered_device_ids)
            {
                node.parent_row_id = Some(parent_device_id.clone());
                node.row_id = format!("{parent_device_id}/{}", node.device_id);
                node.depth = depth_by_device.get(&parent_device_id).copied().unwrap_or(0) + 1;
            }
        }
        nodes.push(node);
    }

    DiscoveryTree { nodes }
}

fn infer_display_tree(
    topology: &Topology,
    base_tree: DiscoveryTree,
) -> (DiscoveryTree, DiscoveryRelations) {
    if base_tree.nodes.is_empty() {
        return (base_tree, DiscoveryRelations::default());
    }

    let visible_device_ids = base_tree
        .nodes
        .iter()
        .map(|node| node.device_id.clone())
        .collect::<HashSet<_>>();
    let node_by_device = base_tree
        .nodes
        .iter()
        .map(|node| (node.device_id.clone(), node.clone()))
        .collect::<HashMap<_, _>>();
    let device_id_by_row = base_tree
        .nodes
        .iter()
        .map(|node| (node.row_id.clone(), node.device_id.clone()))
        .collect::<HashMap<_, _>>();
    let base_parent_by_device = base_tree
        .nodes
        .iter()
        .filter_map(|node| {
            device_id_by_row
                .get(node.parent_row_id.as_ref()?)
                .map(|parent_id| (node.device_id.clone(), parent_id.clone()))
        })
        .collect::<HashMap<_, _>>();
    let forced_root_ids =
        infer_additional_root_routers(topology, &visible_device_ids, &base_parent_by_device);
    let parent_by_device = base_parent_by_device
        .into_iter()
        .filter(|(device_id, _)| !forced_root_ids.contains(device_id))
        .collect::<HashMap<_, _>>();

    let root_router_ids = visible_device_ids
        .iter()
        .filter(|device_id| !parent_by_device.contains_key(*device_id))
        .filter(|device_id| {
            topology
                .devices
                .get(*device_id)
                .is_some_and(|device| device.device_role == crate::DeviceRole::Router)
        })
        .cloned()
        .collect::<HashSet<_>>();
    let shared_children_by_root =
        infer_shared_children_by_root(topology, &visible_device_ids, &root_router_ids);

    let mut children_by_parent = HashMap::<String, Vec<String>>::new();
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

    let mut roots = visible_device_ids
        .iter()
        .filter(|device_id| !parent_by_device.contains_key(*device_id))
        .cloned()
        .collect::<Vec<_>>();
    roots.sort_by(|left, right| {
        device_sort_key(topology, left).cmp(&device_sort_key(topology, right))
    });

    let mut emitted_nodes = Vec::new();
    for root_id in &roots {
        emit_display_tree(root_id, &node_by_device, &children_by_parent, None, 0, &mut emitted_nodes);
    }

    let mut duplicate_scope_counts = HashMap::<String, usize>::new();
    for root_id in &roots {
        for child_id in shared_children_by_root.get(root_id).into_iter().flatten() {
            if parent_by_device
                .get(child_id)
                .is_some_and(|parent_id| parent_id == root_id)
            {
                continue;
            }
            emit_duplicate_subtree(
                child_id,
                root_id,
                &node_by_device,
                &children_by_parent,
                &mut duplicate_scope_counts,
                &mut emitted_nodes,
            );
        }
    }

    emitted_nodes.sort_by(|left, right| {
        left.depth
            .cmp(&right.depth)
            .then_with(|| left.row_id.cmp(&right.row_id))
    });
    let relations = build_display_relations(
        topology,
        &visible_device_ids,
        &roots,
        &parent_by_device,
        &shared_children_by_root,
    );
    (
        DiscoveryTree {
            nodes: emitted_nodes,
        },
        relations,
    )
}

fn build_display_relations(
    topology: &Topology,
    visible_device_ids: &HashSet<String>,
    root_ids: &[String],
    parent_by_device: &HashMap<String, String>,
    shared_children_by_root: &HashMap<String, Vec<String>>,
) -> DiscoveryRelations {
    let mut by_device = visible_device_ids
        .iter()
        .cloned()
        .map(|device_id| (device_id, DeviceRelations::default()))
        .collect::<HashMap<_, _>>();

    let mut add_parent_child = |parent_id: &str, child_id: &str| {
        if !visible_device_ids.contains(parent_id) || !visible_device_ids.contains(child_id) {
            return;
        }
        if parent_id == child_id {
            return;
        }

        by_device
            .entry(child_id.to_string())
            .or_default()
            .parents
            .push(parent_id.to_string());
        by_device
            .entry(parent_id.to_string())
            .or_default()
            .children
            .push(child_id.to_string());
    };

    for (device_id, parent_id) in parent_by_device {
        add_parent_child(parent_id, device_id);
    }

    for (root_id, child_ids) in shared_children_by_root {
        for child_id in child_ids {
            add_parent_child(root_id, child_id);
        }
    }

    let root_id_set = root_ids.iter().cloned().collect::<HashSet<_>>();
    for link in topology
        .links
        .iter()
        .filter(|link| link.protocol == LinkProtocol::Lldp)
    {
        if !root_id_set.contains(&link.local_device_id) || !root_id_set.contains(&link.remote_device_id)
        {
            continue;
        }
        if link.local_device_id == link.remote_device_id {
            continue;
        }

        by_device
            .entry(link.local_device_id.clone())
            .or_default()
            .peers
            .push(link.remote_device_id.clone());
        by_device
            .entry(link.remote_device_id.clone())
            .or_default()
            .peers
            .push(link.local_device_id.clone());
    }

    for relations in by_device.values_mut() {
        relations.parents = sort_relation_ids(topology, std::mem::take(&mut relations.parents));
        relations.children = sort_relation_ids(topology, std::mem::take(&mut relations.children));
        relations.peers = sort_relation_ids(topology, std::mem::take(&mut relations.peers));
    }

    DiscoveryRelations {
        root_device_ids: sort_relation_ids(topology, root_ids.to_vec()),
        by_device,
    }
}

fn sort_relation_ids(topology: &Topology, device_ids: Vec<String>) -> Vec<String> {
    let mut deduped = device_ids.into_iter().collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>();
    deduped.sort_by(|left, right| device_sort_key(topology, left).cmp(&device_sort_key(topology, right)));
    deduped
}

fn infer_additional_root_routers(
    topology: &Topology,
    visible_device_ids: &HashSet<String>,
    base_parent_by_device: &HashMap<String, String>,
) -> HashSet<String> {
    let router_ids = visible_device_ids
        .iter()
        .filter(|device_id| {
            topology
                .devices
                .get(*device_id)
                .is_some_and(|device| device.device_role == crate::DeviceRole::Router)
        })
        .cloned()
        .collect::<HashSet<_>>();

    let mut promoted = infer_router_cycle_roots(topology, &router_ids);
    promoted.extend(infer_shared_downstream_roots(topology, visible_device_ids, &router_ids));
    promoted.extend(infer_router_backbone_pair_roots(
        topology,
        &router_ids,
        base_parent_by_device,
    ));

    promoted.retain(|device_id| {
        visible_device_ids.contains(device_id)
            && router_ids.contains(device_id)
            && !proxmox_bridge_parent(topology, device_id).is_some()
            && base_parent_by_device.contains_key(device_id)
    });

    promoted
}

fn infer_router_backbone_pair_roots(
    topology: &Topology,
    router_ids: &HashSet<String>,
    base_parent_by_device: &HashMap<String, String>,
) -> HashSet<String> {
    let router_child_counts = router_ids
        .iter()
        .map(|router_id| {
            let count = base_parent_by_device
                .iter()
                .filter(|(device_id, parent_id)| {
                    *parent_id == router_id
                        && topology
                            .devices
                            .get(*device_id)
                            .is_some_and(|device| device.device_role == crate::DeviceRole::Router)
                })
                .count();
            (router_id.clone(), count)
        })
        .collect::<HashMap<_, _>>();

    let mut promoted = HashSet::new();
    for link in topology
        .links
        .iter()
        .filter(|link| link.protocol == LinkProtocol::Lldp)
    {
        if !router_ids.contains(&link.local_device_id) || !router_ids.contains(&link.remote_device_id) {
            continue;
        }

        let left_children = router_child_counts.get(&link.local_device_id).copied().unwrap_or(0);
        let right_children = router_child_counts.get(&link.remote_device_id).copied().unwrap_or(0);
        if left_children >= 2 && right_children >= 2 {
            promoted.insert(link.local_device_id.clone());
            promoted.insert(link.remote_device_id.clone());
        }
    }

    promoted
}

fn infer_router_cycle_roots(topology: &Topology, router_ids: &HashSet<String>) -> HashSet<String> {
    let mut router_neighbors = HashMap::<String, Vec<String>>::new();
    for link in topology
        .links
        .iter()
        .filter(|link| link.protocol == LinkProtocol::Lldp)
    {
        if router_ids.contains(&link.local_device_id) && router_ids.contains(&link.remote_device_id) {
            router_neighbors
                .entry(link.local_device_id.clone())
                .or_default()
                .push(link.remote_device_id.clone());
            router_neighbors
                .entry(link.remote_device_id.clone())
                .or_default()
                .push(link.local_device_id.clone());
        }
    }

    let mut visited = HashSet::new();
    let mut promoted = HashSet::new();

    for router_id in router_ids {
        if !visited.insert(router_id.clone()) {
            continue;
        }

        let mut stack = vec![router_id.clone()];
        let mut component = Vec::new();
        let mut edge_count_twice = 0usize;

        while let Some(current) = stack.pop() {
            component.push(current.clone());
            for neighbor in router_neighbors.get(&current).into_iter().flatten() {
                edge_count_twice += 1;
                if visited.insert(neighbor.clone()) {
                    stack.push(neighbor.clone());
                }
            }
        }

        let node_count = component.len();
        let edge_count = edge_count_twice / 2;
        if node_count >= 2 && edge_count >= node_count {
            promoted.extend(component);
        }
    }

    promoted
}

fn infer_shared_downstream_roots(
    topology: &Topology,
    visible_device_ids: &HashSet<String>,
    router_ids: &HashSet<String>,
) -> HashSet<String> {
    let mut shared_counts = HashMap::<(String, String), usize>::new();

    for device_id in visible_device_ids {
        let Some(device) = topology.devices.get(device_id) else {
            continue;
        };
        if device.device_role == crate::DeviceRole::Router {
            continue;
        }

        let mut router_neighbors = topology
            .links
            .iter()
            .filter(|link| link.protocol == LinkProtocol::Lldp)
            .filter_map(|link| {
                if link.local_device_id == *device_id && router_ids.contains(&link.remote_device_id) {
                    return Some(link.remote_device_id.clone());
                }
                if link.remote_device_id == *device_id && router_ids.contains(&link.local_device_id) {
                    return Some(link.local_device_id.clone());
                }
                None
            })
            .collect::<Vec<_>>();

        router_neighbors.sort();
        router_neighbors.dedup();
        if router_neighbors.len() < 2 {
            continue;
        }

        for index in 0..router_neighbors.len() {
            for other_index in (index + 1)..router_neighbors.len() {
                let pair = (
                    router_neighbors[index].clone(),
                    router_neighbors[other_index].clone(),
                );
                shared_counts
                    .entry(pair)
                    .and_modify(|count| *count += 1)
                    .or_insert(1);
            }
        }
    }

    let mut promoted = HashSet::new();
    for ((left, right), count) in shared_counts {
        if count >= 2 {
            promoted.insert(left);
            promoted.insert(right);
        }
    }

    promoted
}

fn infer_shared_children_by_root(
    topology: &Topology,
    visible_device_ids: &HashSet<String>,
    root_router_ids: &HashSet<String>,
) -> HashMap<String, Vec<String>> {
    let mut roots_by_child = HashMap::<String, Vec<String>>::new();

    for link in topology
        .links
        .iter()
        .filter(|link| link.protocol == LinkProtocol::Lldp)
    {
        let (root_id, child_id) = if root_router_ids.contains(&link.local_device_id) {
            (&link.local_device_id, &link.remote_device_id)
        } else if root_router_ids.contains(&link.remote_device_id) {
            (&link.remote_device_id, &link.local_device_id)
        } else {
            continue;
        };

        if !visible_device_ids.contains(child_id) {
            continue;
        }
        let Some(child_device) = topology.devices.get(child_id) else {
            continue;
        };
        if child_device.device_role == crate::DeviceRole::Router {
            continue;
        }

        roots_by_child
            .entry(child_id.clone())
            .or_default()
            .push(root_id.clone());
    }

    let mut shared_children_by_root = HashMap::<String, Vec<String>>::new();
    for (child_id, mut root_ids) in roots_by_child {
        root_ids.sort_by(|left, right| {
            device_sort_key(topology, left).cmp(&device_sort_key(topology, right))
        });
        root_ids.dedup();
        if root_ids.len() < 2 {
            continue;
        }

        for root_id in root_ids {
            shared_children_by_root
                .entry(root_id)
                .or_default()
                .push(child_id.clone());
        }
    }

    for child_ids in shared_children_by_root.values_mut() {
        child_ids.sort_by(|left, right| {
            device_sort_key(topology, left).cmp(&device_sort_key(topology, right))
        });
        child_ids.dedup();
    }

    shared_children_by_root
}

fn emit_display_tree(
    device_id: &str,
    node_by_device: &HashMap<String, DiscoveryTreeNode>,
    children_by_parent: &HashMap<String, Vec<String>>,
    parent_row_id: Option<String>,
    depth: u32,
    nodes: &mut Vec<DiscoveryTreeNode>,
) {
    let Some(base_node) = node_by_device.get(device_id) else {
        return;
    };

    nodes.push(DiscoveryTreeNode {
        row_id: base_node.row_id.clone(),
        device_id: device_id.to_string(),
        parent_row_id: parent_row_id.clone(),
        label: base_node.label.clone(),
        depth,
    });

    for child_id in children_by_parent.get(device_id).into_iter().flatten() {
        emit_display_tree(
            child_id,
            node_by_device,
            children_by_parent,
            Some(base_node.row_id.clone()),
            depth + 1,
            nodes,
        );
    }
}

fn emit_duplicate_subtree(
    device_id: &str,
    parent_device_id: &str,
    node_by_device: &HashMap<String, DiscoveryTreeNode>,
    children_by_parent: &HashMap<String, Vec<String>>,
    duplicate_scope_counts: &mut HashMap<String, usize>,
    nodes: &mut Vec<DiscoveryTreeNode>,
) {
    let Some(parent_node) = node_by_device.get(parent_device_id) else {
        return;
    };
    if !node_by_device.contains_key(device_id) {
        return;
    }
    let parent_depth = nodes
        .iter()
        .rev()
        .find(|node| node.row_id == parent_node.row_id)
        .map(|node| node.depth)
        .unwrap_or(0);

    emit_duplicate_subtree_with_parent_row(
        device_id,
        &parent_node.row_id,
        parent_depth,
        node_by_device,
        children_by_parent,
        duplicate_scope_counts,
        nodes,
    );
}

fn emit_duplicate_subtree_with_parent_row(
    device_id: &str,
    parent_row_id: &str,
    parent_depth: u32,
    node_by_device: &HashMap<String, DiscoveryTreeNode>,
    children_by_parent: &HashMap<String, Vec<String>>,
    duplicate_scope_counts: &mut HashMap<String, usize>,
    nodes: &mut Vec<DiscoveryTreeNode>,
) {
    let Some(base_node) = node_by_device.get(device_id) else {
        return;
    };

    let scope_key = format!("{parent_row_id}::{device_id}");
    let occurrence = duplicate_scope_counts
        .entry(scope_key)
        .and_modify(|value| *value += 1)
        .or_insert(1usize);
    let row_id = format!("{parent_row_id}/{device_id}#{occurrence}");
    let depth = parent_depth + 1;

    nodes.push(DiscoveryTreeNode {
        row_id: row_id.clone(),
        device_id: device_id.to_string(),
        parent_row_id: Some(parent_row_id.to_string()),
        label: base_node.label.clone(),
        depth,
    });

    for child_id in children_by_parent.get(device_id).into_iter().flatten() {
        emit_duplicate_subtree_with_parent_row(
            child_id,
            &row_id,
            depth,
            node_by_device,
            children_by_parent,
            duplicate_scope_counts,
            nodes,
        );
    }
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

fn unique_visible_lldp_parent(
    topology: &Topology,
    device_id: &str,
    visible_device_ids: &HashSet<String>,
) -> Option<String> {
    let candidates = topology
        .links
        .iter()
        .filter(|link| link.protocol == LinkProtocol::Lldp)
        .filter_map(|link| {
            if link.local_device_id == device_id {
                Some(link.remote_device_id.clone())
            } else if link.remote_device_id == device_id {
                Some(link.local_device_id.clone())
            } else {
                None
            }
        })
        .filter(|candidate_id| {
            candidate_id != device_id
                && visible_device_ids.contains(candidate_id)
                && include_in_tree(topology, candidate_id)
        })
        .collect::<HashSet<_>>();

    if candidates.len() == 1 {
        candidates.into_iter().next()
    } else {
        None
    }
}

fn build_internal_tree_base(topology: &Topology) -> DiscoveryTree {
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

        assert!(core_router_2.parent_row_id.is_none());
        assert_eq!(core_router_2.depth, 0);
    }

    #[test]
    fn merge_keeps_single_shared_child_router_below_distribution() {
        let mut core_router_1 =
            device("core-router-1", DeviceRole::Router, DeploymentType::Unknown);
        core_router_1.upstream_interface = Some("eth0".to_string());
        let mut core_router_2 =
            device("core-router-2", DeviceRole::Router, DeploymentType::Unknown);
        core_router_2.upstream_interface = Some("eth0".to_string());

        let result = SourceResult {
            topology: Topology {
                devices: HashMap::from([
                    (core_router_1.id.clone(), core_router_1),
                    (core_router_2.id.clone(), core_router_2),
                    (
                        "dist-switch-a".to_string(),
                        device("dist-switch-a", DeviceRole::Switch, DeploymentType::Unknown),
                    ),
                    (
                        "access-switch-a1".to_string(),
                        device(
                            "access-switch-a1",
                            DeviceRole::Switch,
                            DeploymentType::Unknown,
                        ),
                    ),
                ]),
                links: vec![
                    Link {
                        id: "core-1-dist-a".to_string(),
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
                        id: "core-2-dist-a".to_string(),
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
                        id: "dist-a-access-a1".to_string(),
                        local_device_id: "dist-switch-a".to_string(),
                        local_interface: "eth3".to_string(),
                        local_ip: None,
                        remote_device_id: "access-switch-a1".to_string(),
                        remote_interface: "eth1".to_string(),
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
                    DiscoveryTreeNode {
                        row_id: "seed:192.0.2.1/core-router-1#1".to_string(),
                        device_id: "core-router-1".to_string(),
                        parent_row_id: None,
                        label: Some("core-router-1".to_string()),
                        depth: 0,
                    },
                    DiscoveryTreeNode {
                        row_id: "seed:192.0.2.1/core-router-1#1/dist-switch-a#1".to_string(),
                        device_id: "dist-switch-a".to_string(),
                        parent_row_id: Some("seed:192.0.2.1/core-router-1#1".to_string()),
                        label: Some("dist-switch-a".to_string()),
                        depth: 1,
                    },
                    DiscoveryTreeNode {
                        row_id: "seed:192.0.2.1/core-router-1#1/dist-switch-a#1/core-router-2#1"
                            .to_string(),
                        device_id: "core-router-2".to_string(),
                        parent_row_id: Some(
                            "seed:192.0.2.1/core-router-1#1/dist-switch-a#1".to_string(),
                        ),
                        label: Some("core-router-2".to_string()),
                        depth: 2,
                    },
                    DiscoveryTreeNode {
                        row_id: "seed:192.0.2.1/core-router-1#1/dist-switch-a#1/access-switch-a1#1"
                            .to_string(),
                        device_id: "access-switch-a1".to_string(),
                        parent_row_id: Some(
                            "seed:192.0.2.1/core-router-1#1/dist-switch-a#1".to_string(),
                        ),
                        label: Some("access-switch-a1".to_string()),
                        depth: 2,
                    },
                ],
            },
        };

        let merged = merge_source_results(vec![result]);
        let core_router_2_rows = merged
            .tree
            .nodes
            .iter()
            .filter(|node| node.device_id == "core-router-2")
            .collect::<Vec<_>>();
        assert_eq!(core_router_2_rows.len(), 1);
        assert_eq!(
            core_router_2_rows[0].parent_row_id.as_deref(),
            Some("dist-switch-a")
        );
        assert_eq!(core_router_2_rows[0].depth, 2);

        let dist_rows = merged
            .tree
            .nodes
            .iter()
            .filter(|node| node.device_id == "dist-switch-a")
            .collect::<Vec<_>>();
        assert_eq!(dist_rows.len(), 1);
        assert_eq!(dist_rows[0].parent_row_id.as_deref(), Some("core-router-1"));

        let access_rows = merged
            .tree
            .nodes
            .iter()
            .filter(|node| node.device_id == "access-switch-a1")
            .collect::<Vec<_>>();
        assert_eq!(access_rows.len(), 1);
        assert_eq!(access_rows[0].parent_row_id.as_deref(), Some("dist-switch-a"));
    }

    #[test]
    fn merge_reparents_lldp_only_leaf_when_source_parent_is_missing() {
        let result = SourceResult {
            topology: Topology {
                devices: HashMap::from([
                    (
                        "hub-router-1".to_string(),
                        device("hub-router-1", DeviceRole::Router, DeploymentType::Unknown),
                    ),
                    (
                        "hub-router-2".to_string(),
                        device("hub-router-2", DeviceRole::Router, DeploymentType::Unknown),
                    ),
                    (
                        "branch-router-07".to_string(),
                        device(
                            "branch-router-07",
                            DeviceRole::Router,
                            DeploymentType::Unknown,
                        ),
                    ),
                ]),
                links: vec![
                    Link {
                        id: "hub-1-to-hub-2".to_string(),
                        local_device_id: "hub-router-1".to_string(),
                        local_interface: "eth1".to_string(),
                        local_ip: None,
                        remote_device_id: "hub-router-2".to_string(),
                        remote_interface: "eth1".to_string(),
                        remote_ip: None,
                        speed_bps: None,
                        protocol: LinkProtocol::Lldp,
                        guest_attachment: None,
                    },
                    Link {
                        id: "hub-2-to-branch-07".to_string(),
                        local_device_id: "hub-router-2".to_string(),
                        local_interface: "eth3".to_string(),
                        local_ip: None,
                        remote_device_id: "branch-router-07".to_string(),
                        remote_interface: "eth1".to_string(),
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
                        row_id: "seed:192.0.2.1/hub-router-1#1".to_string(),
                        device_id: "hub-router-1".to_string(),
                        parent_row_id: None,
                        label: Some("hub-router-1".to_string()),
                        depth: 0,
                    },
                    crate::discovery::DiscoveryTreeNode {
                        row_id: "seed:192.0.2.1/hub-router-1#1/hub-router-2#1".to_string(),
                        device_id: "hub-router-2".to_string(),
                        parent_row_id: Some("seed:192.0.2.1/hub-router-1#1".to_string()),
                        label: Some("hub-router-2".to_string()),
                        depth: 1,
                    },
                ],
            },
        };

        let merged = merge_source_results(vec![result]);
        let branch_router_07 = merged
            .tree
            .nodes
            .iter()
            .find(|node| node.device_id == "branch-router-07")
            .expect("branch-router-07 should exist");

        assert_eq!(
            branch_router_07.parent_row_id.as_deref(),
            Some("hub-router-2")
        );
        assert_eq!(branch_router_07.depth, 2);
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
