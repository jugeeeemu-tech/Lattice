use std::{
    cmp::Ordering,
    collections::{BTreeSet, HashMap, HashSet},
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
};

use lattice_core::{
    DeploymentType, Device, DeviceRelations as CoreDeviceRelations, DeviceRole,
    DiscoveryRelations as CoreDiscoveryRelations, DiscoveryTree, DiscoveryTreeNode,
    GuestAttachment as CoreGuestAttachment, GuestKind, IdentityKeys, Link, Topology,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryState {
    Loading,
    Discovering,
    Partial,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct DiscoveryStatus {
    pub state: DiscoveryState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
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

    pub fn partial(message: impl Into<String>) -> Self {
        Self {
            state: DiscoveryState::Partial,
            message: Some(message.into()),
        }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            state: DiscoveryState::Failed,
            message: Some(message.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct ViewDevice {
    pub id: String,
    pub label: String,
    pub depth: u32,
    pub device_role: DeviceRole,
    pub deployment_type: DeploymentType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub guest_kind: Option<GuestKind>,
    pub identity_keys: IdentityKeys,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub host_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub upstream_interface: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub default_upstream_device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct ViewLink {
    pub id: String,
    pub local_device_id: String,
    pub local_interface: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub local_ip: Option<String>,
    pub remote_device_id: String,
    pub remote_interface: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub remote_ip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub speed_bps: Option<u64>,
    pub protocol: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub guest_attachment: Option<ViewGuestAttachment>,
    #[serde(default)]
    pub network_cidrs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct ViewGuestAttachment {
    pub bridge_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub vlan_tag: Option<u16>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub trunk_vlans: Vec<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct TreeRow {
    pub id: String,
    pub device_id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct TreeEdge {
    pub parent_row_id: String,
    pub child_row_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export)]
pub struct ViewDeviceRelations {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parents: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub peers: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export)]
pub struct ViewSnapshot {
    pub devices: Vec<ViewDevice>,
    pub links: Vec<ViewLink>,
    pub tree_rows: Vec<TreeRow>,
    pub tree_edges: Vec<TreeEdge>,
    pub primary_row_by_device: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub root_device_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub device_relations: HashMap<String, ViewDeviceRelations>,
    pub discovery_status: DiscoveryStatus,
    pub auto_discovery_interval_seconds: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next_auto_discovery_at_ms: Option<i64>,
}

const MAX_TRANSPORT_ID_CHARS: usize = 120;
const MAX_TRANSPORT_TEXT_CHARS: usize = 256;
const MAX_TRANSPORT_MESSAGE_CHARS: usize = 512;
const MAX_TRANSPORT_DEVICES: usize = 4096;
const MAX_TRANSPORT_LINKS: usize = 8192;
const MAX_TRANSPORT_TREE_ROWS: usize = 8192;
const MAX_TRANSPORT_TREE_EDGES: usize = 8192;
const MAX_TRANSPORT_RELATION_IDS: usize = 256;

impl ViewSnapshot {
    pub fn empty(
        status: DiscoveryStatus,
        auto_discovery_interval_seconds: u64,
        next_auto_discovery_at_ms: Option<i64>,
    ) -> Self {
        Self {
            devices: Vec::new(),
            links: Vec::new(),
            tree_rows: Vec::new(),
            tree_edges: Vec::new(),
            primary_row_by_device: HashMap::new(),
            root_device_ids: Vec::new(),
            device_relations: HashMap::new(),
            discovery_status: status,
            auto_discovery_interval_seconds,
            next_auto_discovery_at_ms,
        }
    }

    pub fn sanitize_for_transport(self) -> Self {
        let self_ = enforce_transport_budget(self);
        let mut device_ids = StableIdMap::default();
        let mut row_ids = StableIdMap::default();
        let mut link_ids = StableIdMap::default();

        for device in &self_.devices {
            device_ids.id_for(&device.id);
        }
        for row in &self_.tree_rows {
            row_ids.id_for(&row.id);
        }
        for link in &self_.links {
            link_ids.id_for(&link.id);
        }

        let devices = self_
            .devices
            .into_iter()
            .map(|device| ViewDevice {
                id: device_ids.id_for(&device.id),
                label: sanitize_text(&device.label, MAX_TRANSPORT_TEXT_CHARS),
                depth: device.depth,
                device_role: device.device_role,
                deployment_type: device.deployment_type,
                guest_kind: device.guest_kind,
                identity_keys: sanitize_identity_keys(device.identity_keys),
                host_label: device
                    .host_label
                    .map(|value| sanitize_text(&value, MAX_TRANSPORT_TEXT_CHARS)),
                upstream_interface: device
                    .upstream_interface
                    .map(|value| sanitize_text(&value, MAX_TRANSPORT_TEXT_CHARS)),
                default_upstream_device_id: device
                    .default_upstream_device_id
                    .map(|value| device_ids.id_for(&value)),
            })
            .collect();

        let links = self_
            .links
            .into_iter()
            .map(|link| ViewLink {
                id: link_ids.id_for(&link.id),
                local_device_id: device_ids.id_for(&link.local_device_id),
                local_interface: sanitize_text(&link.local_interface, MAX_TRANSPORT_TEXT_CHARS),
                local_ip: link
                    .local_ip
                    .map(|value| sanitize_text(&value, MAX_TRANSPORT_TEXT_CHARS)),
                remote_device_id: device_ids.id_for(&link.remote_device_id),
                remote_interface: sanitize_text(&link.remote_interface, MAX_TRANSPORT_TEXT_CHARS),
                remote_ip: link
                    .remote_ip
                    .map(|value| sanitize_text(&value, MAX_TRANSPORT_TEXT_CHARS)),
                speed_bps: link.speed_bps,
                protocol: sanitize_text(&link.protocol, MAX_TRANSPORT_TEXT_CHARS),
                guest_attachment: link.guest_attachment.map(|attachment| ViewGuestAttachment {
                    bridge_name: sanitize_text(&attachment.bridge_name, MAX_TRANSPORT_TEXT_CHARS),
                    vlan_tag: attachment.vlan_tag,
                    trunk_vlans: attachment.trunk_vlans,
                }),
                network_cidrs: link
                    .network_cidrs
                    .into_iter()
                    .map(|value| sanitize_text(&value, MAX_TRANSPORT_TEXT_CHARS))
                    .collect(),
            })
            .collect();

        let tree_rows = self_
            .tree_rows
            .into_iter()
            .map(|row| TreeRow {
                id: row_ids.id_for(&row.id),
                device_id: device_ids.id_for(&row.device_id),
                label: sanitize_text(&row.label, MAX_TRANSPORT_TEXT_CHARS),
            })
            .collect();

        let tree_edges = self_
            .tree_edges
            .into_iter()
            .map(|edge| TreeEdge {
                parent_row_id: row_ids.id_for(&edge.parent_row_id),
                child_row_id: row_ids.id_for(&edge.child_row_id),
            })
            .collect();

        let primary_row_by_device = self_
            .primary_row_by_device
            .into_iter()
            .map(|(device_id, row_id)| (device_ids.id_for(&device_id), row_ids.id_for(&row_id)))
            .collect();

        let root_device_ids = self_
            .root_device_ids
            .into_iter()
            .map(|device_id| device_ids.id_for(&device_id))
            .collect();

        let device_relations = self_
            .device_relations
            .into_iter()
            .map(|(device_id, relations)| {
                (
                    device_ids.id_for(&device_id),
                    ViewDeviceRelations {
                        parents: relations
                            .parents
                            .into_iter()
                            .take(MAX_TRANSPORT_RELATION_IDS)
                            .map(|value| device_ids.id_for(&value))
                            .collect(),
                        peers: relations
                            .peers
                            .into_iter()
                            .take(MAX_TRANSPORT_RELATION_IDS)
                            .map(|value| device_ids.id_for(&value))
                            .collect(),
                        children: relations
                            .children
                            .into_iter()
                            .take(MAX_TRANSPORT_RELATION_IDS)
                            .map(|value| device_ids.id_for(&value))
                            .collect(),
                    },
                )
            })
            .collect();

        Self {
            devices,
            links,
            tree_rows,
            tree_edges,
            primary_row_by_device,
            root_device_ids,
            device_relations,
            discovery_status: DiscoveryStatus {
                state: self_.discovery_status.state,
                message: self_
                    .discovery_status
                    .message
                    .map(|value| sanitize_text(&value, MAX_TRANSPORT_MESSAGE_CHARS)),
            },
            auto_discovery_interval_seconds: self_.auto_discovery_interval_seconds,
            next_auto_discovery_at_ms: self_.next_auto_discovery_at_ms,
        }
    }
}

pub fn build_view_snapshot(
    topology: &Topology,
    tree: &DiscoveryTree,
    relations: &CoreDiscoveryRelations,
    status: &DiscoveryStatus,
    auto_discovery_interval_seconds: u64,
    next_auto_discovery_at_ms: Option<i64>,
) -> ViewSnapshot {
    let min_depth_by_device = build_min_depths(tree);
    let devices = build_devices(topology, &min_depth_by_device);
    let links = build_links(topology);
    let (tree_rows, tree_edges, primary_row_by_device) = build_tree(topology, tree);

    ViewSnapshot {
        devices,
        links,
        tree_rows,
        tree_edges,
        primary_row_by_device,
        root_device_ids: relations.root_device_ids.clone(),
        device_relations: build_device_relations(relations),
        discovery_status: status.clone(),
        auto_discovery_interval_seconds,
        next_auto_discovery_at_ms,
    }
    .sanitize_for_transport()
}

#[derive(Default)]
struct StableIdMap {
    by_raw: HashMap<String, String>,
    used: HashSet<String>,
}

impl StableIdMap {
    fn id_for(&mut self, raw: &str) -> String {
        if let Some(existing) = self.by_raw.get(raw) {
            return existing.clone();
        }

        let base = sanitize_identifier_candidate(raw);
        let mut candidate = base.clone();
        let mut suffix = 1usize;
        while !self.used.insert(candidate.clone()) {
            suffix += 1;
            candidate = with_suffix(&base, &format!("-{suffix}"), MAX_TRANSPORT_ID_CHARS);
        }

        self.by_raw.insert(raw.to_string(), candidate.clone());
        candidate
    }
}

fn sanitize_identity_keys(identity: IdentityKeys) -> IdentityKeys {
    IdentityKeys {
        chassis_id: identity
            .chassis_id
            .map(|value| sanitize_text(&value, MAX_TRANSPORT_TEXT_CHARS)),
        sys_name: identity
            .sys_name
            .map(|value| sanitize_text(&value, MAX_TRANSPORT_TEXT_CHARS)),
        mgmt_ip: identity
            .mgmt_ip
            .map(|value| sanitize_text(&value, MAX_TRANSPORT_TEXT_CHARS)),
        mac_addresses: identity
            .mac_addresses
            .into_iter()
            .map(|value| sanitize_text(&value, MAX_TRANSPORT_TEXT_CHARS))
            .collect(),
    }
}

fn sanitize_identifier_candidate(raw: &str) -> String {
    let normalized = sanitize_text(raw, MAX_TRANSPORT_ID_CHARS);
    if normalized.chars().count() < raw.chars().count() || contains_control_char(raw) {
        let hash = fnv1a64(raw.as_bytes());
        return with_suffix(
            &normalized,
            &format!("~{hash:016x}"),
            MAX_TRANSPORT_ID_CHARS,
        );
    }
    normalized
}

fn with_suffix(base: &str, suffix: &str, limit: usize) -> String {
    let suffix_chars = suffix.chars().count();
    if suffix_chars >= limit {
        return suffix.chars().take(limit).collect();
    }

    let keep = limit - suffix_chars;
    let prefix = base.chars().take(keep).collect::<String>();
    format!("{prefix}{suffix}")
}

fn sanitize_text(raw: &str, limit: usize) -> String {
    if limit == 0 {
        return String::new();
    }

    let raw_len = raw.chars().count();
    let mut sanitized = String::new();
    let mut count = 0usize;

    for ch in raw.chars() {
        let normalized = if ch.is_control() && !matches!(ch, '\n' | '\r' | '\t') {
            ' '
        } else {
            ch
        };
        if count >= limit {
            break;
        }
        sanitized.push(normalized);
        count += 1;
    }

    if count < raw_len {
        if count == limit {
            sanitized.pop();
        }
        sanitized.push('~');
    }

    sanitized
}

fn contains_control_char(raw: &str) -> bool {
    raw.chars()
        .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
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
            default_upstream_device_id: device.default_upstream_device_id.clone(),
        })
        .collect();

    devices.sort_by(|left, right| {
        left.label
            .cmp(&right.label)
            .then_with(|| left.id.cmp(&right.id))
    });
    devices
}

fn build_links(topology: &Topology) -> Vec<ViewLink> {
    let mut view_links: Vec<ViewLink> = topology
        .links
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
            network_cidrs: link_network_cidrs(topology, link),
        })
        .collect();
    view_links.sort_by(|left, right| left.id.cmp(&right.id));
    view_links
}

fn link_network_cidrs(topology: &Topology, link: &Link) -> Vec<String> {
    if link.protocol.as_str() != "proxmox_guest_link" {
        return point_to_point_network_cidrs(link.local_ip.as_deref(), link.remote_ip.as_deref());
    }

    let Some(attachment) = link.guest_attachment.as_ref() else {
        return point_to_point_network_cidrs(link.local_ip.as_deref(), link.remote_ip.as_deref());
    };

    let Some((guest_device_id, guest_interface_name, bridge_ip)) =
        proxmox_guest_link_endpoints(link, attachment.bridge_name.as_str())
    else {
        return Vec::new();
    };
    let Some(guest_device) = topology.devices.get(guest_device_id) else {
        return Vec::new();
    };
    let guest_candidates = guest_network_candidates(guest_device, guest_interface_name, attachment);
    if guest_candidates.is_empty() {
        return Vec::new();
    }

    if !attachment.trunk_vlans.is_empty() && attachment.vlan_tag.is_none() {
        return guest_candidates;
    }

    let bridge_network = bridge_ip.and_then(normalize_cidr);
    if let Some(bridge_network) = bridge_network {
        let filtered = guest_candidates
            .iter()
            .filter(|candidate| *candidate == &bridge_network)
            .cloned()
            .collect::<Vec<_>>();
        if filtered.len() == 1 {
            return filtered;
        }
        if filtered.len() > 1 {
            return dedup_sorted(filtered);
        }
    }

    if guest_candidates.len() == 1 {
        guest_candidates
    } else {
        Vec::new()
    }
}

fn point_to_point_network_cidrs(local_ip: Option<&str>, remote_ip: Option<&str>) -> Vec<String> {
    match (
        local_ip.and_then(normalize_cidr),
        remote_ip.and_then(normalize_cidr),
    ) {
        (Some(local), Some(remote)) if local == remote => vec![local],
        _ => Vec::new(),
    }
}

fn proxmox_guest_link_endpoints<'a>(
    link: &'a Link,
    bridge_name: &'a str,
) -> Option<(&'a str, &'a str, Option<&'a str>)> {
    let local_is_bridge = link.local_interface == bridge_name;
    let remote_is_bridge = link.remote_interface == bridge_name;

    if local_is_bridge && !remote_is_bridge {
        return Some((
            link.remote_device_id.as_str(),
            link.remote_interface.as_str(),
            link.local_ip.as_deref(),
        ));
    }
    if remote_is_bridge && !local_is_bridge {
        return Some((
            link.local_device_id.as_str(),
            link.local_interface.as_str(),
            link.remote_ip.as_deref(),
        ));
    }

    None
}

fn guest_network_candidates(
    device: &Device,
    base_interface_name: &str,
    attachment: &CoreGuestAttachment,
) -> Vec<String> {
    let include_subinterfaces = !attachment.trunk_vlans.is_empty() && attachment.vlan_tag.is_none();
    let interface_names =
        resolve_guest_interface_names(device, base_interface_name, include_subinterfaces);
    if interface_names.is_empty() {
        return Vec::new();
    }

    if include_subinterfaces {
        let vlan_candidates = attachment
            .trunk_vlans
            .iter()
            .filter_map(|vlan| {
                interface_names.iter().find_map(|interface_name| {
                    network_for_interface(device, &format!("{interface_name}.{vlan}"))
                })
            })
            .collect::<Vec<_>>();
        if !vlan_candidates.is_empty() {
            return dedup_preserving_order(vlan_candidates);
        }
    }

    let mut candidates = Vec::new();
    for interface_name in interface_names {
        for interface in &device.interfaces {
            let matches = interface.if_name == interface_name
                || (include_subinterfaces
                    && interface.if_name.starts_with(&format!("{interface_name}.")));
            if !matches {
                continue;
            }
            for cidr in &interface.ip_addresses {
                if let Some(normalized) = normalize_cidr(cidr) {
                    candidates.push(normalized);
                }
            }
        }
    }

    dedup_preserving_order(candidates)
}

fn resolve_guest_interface_names(
    device: &Device,
    base_interface_name: &str,
    include_subinterfaces: bool,
) -> Vec<String> {
    let mut names = vec![base_interface_name.to_string()];

    let exact_has_network_data = device.interfaces.iter().any(|interface| {
        interface.if_name == base_interface_name && !interface.ip_addresses.is_empty()
            || (include_subinterfaces
                && interface
                    .if_name
                    .starts_with(&format!("{base_interface_name}.")))
                && !interface.ip_addresses.is_empty()
    });
    if exact_has_network_data {
        return names;
    }

    if let Some(alias_name) = interface_alias_from_proxmox_slot(device, base_interface_name) {
        names.push(alias_name);
    }

    dedup_preserving_order(names)
}

fn interface_alias_from_proxmox_slot(device: &Device, interface_name: &str) -> Option<String> {
    let slot_index = interface_name.strip_prefix("net")?.parse::<usize>().ok()?;
    let mut ordered_bases = Vec::new();
    let mut seen = BTreeSet::new();

    for interface in &device.interfaces {
        let base_name = interface
            .if_name
            .split('.')
            .next()
            .unwrap_or(&interface.if_name);
        if base_name == "lo" || base_name.is_empty() || !seen.insert(base_name.to_string()) {
            continue;
        }
        ordered_bases.push((
            interface_base_priority(device, base_name),
            interface.if_index,
            base_name.to_string(),
        ));
    }

    ordered_bases.sort_by(|left, right| left.cmp(right));
    ordered_bases
        .get(slot_index)
        .map(|(_, _, name)| name.clone())
}

fn interface_base_priority(device: &Device, base_name: &str) -> u8 {
    if is_primary_guest_nic_name(base_name) {
        return 0;
    }
    if device.interfaces.iter().any(|interface| {
        interface.if_name.starts_with(&format!("{base_name}."))
            && !interface.ip_addresses.is_empty()
    }) {
        return 1;
    }
    if device
        .interfaces
        .iter()
        .any(|interface| interface.if_name == base_name && !interface.ip_addresses.is_empty())
    {
        return 2;
    }
    3
}

fn is_primary_guest_nic_name(interface_name: &str) -> bool {
    interface_name.starts_with("eth")
        || interface_name.starts_with("ens")
        || interface_name.starts_with("enp")
        || interface_name.starts_with("eno")
        || interface_name.starts_with("em")
        || interface_name.starts_with("bond")
        || interface_name.starts_with("lan")
        || interface_name.starts_with("wan")
}

fn network_for_interface(device: &Device, interface_name: &str) -> Option<String> {
    device
        .interfaces
        .iter()
        .find(|interface| interface.if_name == interface_name)
        .and_then(|interface| {
            interface
                .ip_addresses
                .iter()
                .find_map(|cidr| normalize_cidr(cidr))
        })
}

fn normalize_cidr(value: &str) -> Option<String> {
    let (address, prefix) = value.trim().split_once('/')?;
    let prefix = prefix.parse::<u8>().ok()?;
    let ip = address.parse::<IpAddr>().ok()?;
    if ip.is_loopback() || is_link_local(ip) {
        return None;
    }

    match ip {
        IpAddr::V4(address) if prefix <= 32 => {
            let mask = if prefix == 0 {
                0
            } else {
                u32::MAX << (32 - prefix)
            };
            let network = u32::from(address) & mask;
            Some(format!("{}/{}", Ipv4Addr::from(network), prefix))
        }
        IpAddr::V6(address) if prefix <= 128 => {
            let mask = if prefix == 0 {
                0
            } else {
                u128::MAX << (128 - prefix)
            };
            let network = u128::from(address) & mask;
            Some(format!("{}/{}", Ipv6Addr::from(network), prefix))
        }
        _ => None,
    }
}

fn is_link_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(address) => address.is_link_local(),
        IpAddr::V6(address) => address.is_unicast_link_local(),
    }
}

fn dedup_sorted(values: Vec<String>) -> Vec<String> {
    let mut deduped = values
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    deduped.sort();
    deduped
}

fn dedup_preserving_order(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut deduped = Vec::new();
    for value in values {
        if seen.insert(value.clone()) {
            deduped.push(value);
        }
    }
    deduped
}

fn build_tree(
    topology: &Topology,
    tree: &DiscoveryTree,
) -> (Vec<TreeRow>, Vec<TreeEdge>, HashMap<String, String>) {
    let mut nodes = tree.nodes.clone();
    nodes.sort_by(node_order);
    let node_by_row_id = nodes
        .iter()
        .map(|node| (node.row_id.clone(), node.clone()))
        .collect::<HashMap<_, _>>();

    let parent_row_by_row = nodes
        .iter()
        .filter_map(|node| {
            node.parent_row_id
                .as_ref()
                .map(|parent| (node.row_id.clone(), parent.clone()))
        })
        .collect::<HashMap<_, _>>();

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
    let mut primary_rank_by_device = HashMap::new();
    for node in &nodes {
        let node_rank =
            primary_row_rank(topology, &node.row_id, &parent_row_by_row, &node_by_row_id);
        match primary_depth_by_device.get(&node.device_id).copied() {
            Some(existing_depth) if existing_depth < node.depth => {}
            Some(existing_depth)
                if existing_depth == node.depth
                    && primary_rank_by_device
                        .get(&node.device_id)
                        .is_some_and(|existing| existing <= &node_rank) => {}
            _ => {
                primary_depth_by_device.insert(node.device_id.clone(), node.depth);
                primary_rank_by_device.insert(node.device_id.clone(), node_rank);
                primary_row_by_device.insert(node.device_id.clone(), node.row_id.clone());
            }
        }
    }

    (tree_rows, tree_edges, primary_row_by_device)
}

fn primary_row_rank(
    topology: &Topology,
    row_id: &str,
    parent_row_by_row: &HashMap<String, String>,
    node_by_row_id: &HashMap<String, DiscoveryTreeNode>,
) -> (String, String) {
    let label_path = normalized_label_path(topology, row_id, parent_row_by_row, node_by_row_id);
    let root_label = label_path
        .split('/')
        .nth(1)
        .map(str::to_string)
        .unwrap_or_else(|| label_path.clone());
    (root_label, label_path)
}

fn normalized_label_path(
    topology: &Topology,
    row_id: &str,
    parent_row_by_row: &HashMap<String, String>,
    node_by_row_id: &HashMap<String, DiscoveryTreeNode>,
) -> String {
    normalized_label_path_inner(
        topology,
        row_id,
        parent_row_by_row,
        node_by_row_id,
        &mut HashSet::new(),
    )
}

fn normalized_label_path_inner(
    topology: &Topology,
    row_id: &str,
    parent_row_by_row: &HashMap<String, String>,
    node_by_row_id: &HashMap<String, DiscoveryTreeNode>,
    visited: &mut HashSet<String>,
) -> String {
    if !visited.insert(row_id.to_string()) {
        return format!("cycle/{row_id}");
    }

    let Some(node) = node_by_row_id.get(row_id) else {
        return row_id.to_string();
    };
    let label = node
        .label
        .clone()
        .unwrap_or_else(|| device_label_by_id(topology, &node.device_id));

    match parent_row_by_row.get(row_id) {
        Some(parent_row_id) => format!(
            "{}/{}",
            normalized_label_path_inner(
                topology,
                parent_row_id,
                parent_row_by_row,
                node_by_row_id,
                visited,
            ),
            label
        ),
        None => format!("seed/{label}"),
    }
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

fn build_device_relations(
    relations: &CoreDiscoveryRelations,
) -> HashMap<String, ViewDeviceRelations> {
    relations
        .by_device
        .iter()
        .map(|(device_id, relation)| (device_id.clone(), view_device_relations(relation)))
        .collect()
}

fn enforce_transport_budget(mut snapshot: ViewSnapshot) -> ViewSnapshot {
    let original_device_count = snapshot.devices.len();
    snapshot.devices.truncate(MAX_TRANSPORT_DEVICES);
    let kept_device_ids = snapshot
        .devices
        .iter()
        .map(|device| device.id.clone())
        .collect::<HashSet<_>>();
    let omitted_devices = original_device_count.saturating_sub(snapshot.devices.len());

    let original_link_count = snapshot.links.len();
    snapshot.links = snapshot
        .links
        .into_iter()
        .filter(|link| {
            kept_device_ids.contains(&link.local_device_id)
                && kept_device_ids.contains(&link.remote_device_id)
        })
        .take(MAX_TRANSPORT_LINKS)
        .collect();
    let omitted_links = original_link_count.saturating_sub(snapshot.links.len());

    let original_tree_row_count = snapshot.tree_rows.len();
    snapshot.tree_rows = snapshot
        .tree_rows
        .into_iter()
        .filter(|row| kept_device_ids.contains(&row.device_id))
        .take(MAX_TRANSPORT_TREE_ROWS)
        .collect();
    let kept_row_ids = snapshot
        .tree_rows
        .iter()
        .map(|row| row.id.clone())
        .collect::<HashSet<_>>();
    let omitted_tree_rows = original_tree_row_count.saturating_sub(snapshot.tree_rows.len());

    let original_tree_edge_count = snapshot.tree_edges.len();
    snapshot.tree_edges = snapshot
        .tree_edges
        .into_iter()
        .filter(|edge| {
            kept_row_ids.contains(&edge.parent_row_id) && kept_row_ids.contains(&edge.child_row_id)
        })
        .take(MAX_TRANSPORT_TREE_EDGES)
        .collect();
    let omitted_tree_edges = original_tree_edge_count.saturating_sub(snapshot.tree_edges.len());

    snapshot.primary_row_by_device = snapshot
        .primary_row_by_device
        .into_iter()
        .filter(|(device_id, row_id)| {
            kept_device_ids.contains(device_id) && kept_row_ids.contains(row_id)
        })
        .collect();
    snapshot.root_device_ids = snapshot
        .root_device_ids
        .into_iter()
        .filter(|device_id| kept_device_ids.contains(device_id))
        .collect();
    snapshot.device_relations = snapshot
        .device_relations
        .into_iter()
        .filter(|(device_id, _)| kept_device_ids.contains(device_id))
        .map(|(device_id, relations)| {
            (
                device_id,
                ViewDeviceRelations {
                    parents: relations
                        .parents
                        .into_iter()
                        .filter(|value| kept_device_ids.contains(value))
                        .take(MAX_TRANSPORT_RELATION_IDS)
                        .collect(),
                    peers: relations
                        .peers
                        .into_iter()
                        .filter(|value| kept_device_ids.contains(value))
                        .take(MAX_TRANSPORT_RELATION_IDS)
                        .collect(),
                    children: relations
                        .children
                        .into_iter()
                        .filter(|value| kept_device_ids.contains(value))
                        .take(MAX_TRANSPORT_RELATION_IDS)
                        .collect(),
                },
            )
        })
        .collect();

    let mut notes = Vec::new();
    if omitted_devices > 0 {
        notes.push(format!("{omitted_devices} 台の機器"));
    }
    if omitted_links > 0 {
        notes.push(format!("{omitted_links} 本の接続"));
    }
    if omitted_tree_rows > 0 {
        notes.push(format!("{omitted_tree_rows} 件のツリー項目"));
    }
    if omitted_tree_edges > 0 {
        notes.push(format!("{omitted_tree_edges} 件のツリー接続"));
    }

    if !notes.is_empty() {
        let budget_note = format!(
            "表示を安定させるため、一部のデータを省略しました: {}",
            notes.join("、")
        );
        snapshot.discovery_status.message = Some(match snapshot.discovery_status.message {
            Some(existing) => format!("{existing} / {budget_note}"),
            None => budget_note,
        });
    }

    snapshot
}

fn view_device_relations(relations: &CoreDeviceRelations) -> ViewDeviceRelations {
    ViewDeviceRelations {
        parents: relations.parents.clone(),
        peers: relations.peers.clone(),
        children: relations.children.clone(),
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
            default_gateway_ip: None,
            default_upstream_device_id: None,
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

        let snapshot = build_view_snapshot(
            &topology,
            &tree,
            &CoreDiscoveryRelations::default(),
            &DiscoveryStatus::ready(),
            60,
            Some(1_744_000_000_000),
        );

        assert_eq!(snapshot.devices.len(), 3);
        assert_eq!(snapshot.tree_rows.len(), 4);
        assert_eq!(snapshot.auto_discovery_interval_seconds, 60);
        assert_eq!(snapshot.next_auto_discovery_at_ms, Some(1_744_000_000_000));
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

        let first = build_view_snapshot(
            &topology,
            &tree,
            &CoreDiscoveryRelations::default(),
            &DiscoveryStatus::ready(),
            60,
            None,
        );
        let second = build_view_snapshot(
            &topology,
            &tree,
            &CoreDiscoveryRelations::default(),
            &DiscoveryStatus::ready(),
            60,
            None,
        );

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

        let snapshot = build_view_snapshot(
            &topology,
            &tree,
            &CoreDiscoveryRelations::default(),
            &DiscoveryStatus::ready(),
            60,
            None,
        );

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
    fn snapshot_prefers_stable_root_branch_for_duplicated_rows() {
        let mut topology = sample_topology();
        topology.devices.insert(
            "router-2".to_string(),
            device(
                "router-2",
                "core-2",
                DeviceRole::Router,
                DeploymentType::Unknown,
                None,
                None,
            ),
        );
        topology.devices.insert(
            "switch-1".to_string(),
            device(
                "switch-1",
                "dist-a",
                DeviceRole::Switch,
                DeploymentType::Unknown,
                None,
                None,
            ),
        );
        topology.devices.insert(
            "switch-2".to_string(),
            device(
                "switch-2",
                "access-a1",
                DeviceRole::Switch,
                DeploymentType::Unknown,
                None,
                None,
            ),
        );

        let tree = DiscoveryTree {
            nodes: vec![
                DiscoveryTreeNode {
                    row_id: "router-1".to_string(),
                    device_id: "router-1".to_string(),
                    parent_row_id: None,
                    label: Some("core".to_string()),
                    depth: 0,
                },
                DiscoveryTreeNode {
                    row_id: "router-2".to_string(),
                    device_id: "router-2".to_string(),
                    parent_row_id: None,
                    label: Some("core-2".to_string()),
                    depth: 0,
                },
                DiscoveryTreeNode {
                    row_id: "switch-1".to_string(),
                    device_id: "switch-1".to_string(),
                    parent_row_id: Some("router-1".to_string()),
                    label: Some("dist-a".to_string()),
                    depth: 1,
                },
                DiscoveryTreeNode {
                    row_id: "router-2/switch-1#1".to_string(),
                    device_id: "switch-1".to_string(),
                    parent_row_id: Some("router-2".to_string()),
                    label: Some("dist-a".to_string()),
                    depth: 1,
                },
                DiscoveryTreeNode {
                    row_id: "switch-2".to_string(),
                    device_id: "switch-2".to_string(),
                    parent_row_id: Some("switch-1".to_string()),
                    label: Some("access-a1".to_string()),
                    depth: 2,
                },
                DiscoveryTreeNode {
                    row_id: "router-2/switch-1#1/switch-2#1".to_string(),
                    device_id: "switch-2".to_string(),
                    parent_row_id: Some("router-2/switch-1#1".to_string()),
                    label: Some("access-a1".to_string()),
                    depth: 2,
                },
            ],
        };

        let snapshot = build_view_snapshot(
            &topology,
            &tree,
            &CoreDiscoveryRelations::default(),
            &DiscoveryStatus::ready(),
            60,
            None,
        );

        assert_eq!(snapshot.primary_row_by_device["switch-1"], "switch-1");
        assert_eq!(snapshot.primary_row_by_device["switch-2"], "switch-2");
    }

    #[test]
    fn snapshot_handles_cyclic_tree_rows_without_recursing_forever() {
        let topology = Topology {
            devices: HashMap::from([
                (
                    "device-a".to_string(),
                    device(
                        "device-a",
                        "device-a",
                        DeviceRole::Router,
                        DeploymentType::Unknown,
                        None,
                        None,
                    ),
                ),
                (
                    "device-b".to_string(),
                    device(
                        "device-b",
                        "device-b",
                        DeviceRole::Switch,
                        DeploymentType::Unknown,
                        None,
                        None,
                    ),
                ),
            ]),
            links: Vec::new(),
            updated_at: Utc::now(),
        };
        let tree = DiscoveryTree {
            nodes: vec![
                DiscoveryTreeNode {
                    row_id: "row-a".to_string(),
                    device_id: "device-a".to_string(),
                    parent_row_id: Some("row-b".to_string()),
                    label: Some("device-a".to_string()),
                    depth: 0,
                },
                DiscoveryTreeNode {
                    row_id: "row-b".to_string(),
                    device_id: "device-b".to_string(),
                    parent_row_id: Some("row-a".to_string()),
                    label: Some("device-b".to_string()),
                    depth: 0,
                },
            ],
        };

        let snapshot = build_view_snapshot(
            &topology,
            &tree,
            &CoreDiscoveryRelations::default(),
            &DiscoveryStatus::ready(),
            60,
            None,
        );

        assert_eq!(snapshot.tree_rows.len(), 2);
        assert_eq!(snapshot.primary_row_by_device["device-a"], "row-a");
        assert_eq!(snapshot.primary_row_by_device["device-b"], "row-b");
    }

    #[test]
    fn primary_row_selection_uses_stable_label_paths_instead_of_row_ids() {
        let mut topology = Topology::default();
        topology.devices.insert(
            "router-3".to_string(),
            device(
                "router-3",
                "core-router-3",
                DeviceRole::Router,
                DeploymentType::Unknown,
                None,
                None,
            ),
        );
        topology.devices.insert(
            "router-4".to_string(),
            device(
                "router-4",
                "core-router-4",
                DeviceRole::Router,
                DeploymentType::Unknown,
                None,
                None,
            ),
        );
        topology.devices.insert(
            "switch-e".to_string(),
            device(
                "switch-e",
                "dist-switch-e",
                DeviceRole::Switch,
                DeploymentType::Unknown,
                None,
                None,
            ),
        );

        let tree = DiscoveryTree {
            nodes: vec![
                DiscoveryTreeNode {
                    row_id: "device-7".to_string(),
                    device_id: "router-3".to_string(),
                    parent_row_id: None,
                    label: Some("core-router-3".to_string()),
                    depth: 0,
                },
                DiscoveryTreeNode {
                    row_id: "device-4".to_string(),
                    device_id: "router-4".to_string(),
                    parent_row_id: None,
                    label: Some("core-router-4".to_string()),
                    depth: 0,
                },
                DiscoveryTreeNode {
                    row_id: "device-7/device-13#1".to_string(),
                    device_id: "switch-e".to_string(),
                    parent_row_id: Some("device-7".to_string()),
                    label: Some("dist-switch-e".to_string()),
                    depth: 1,
                },
                DiscoveryTreeNode {
                    row_id: "device-4/device-13#1".to_string(),
                    device_id: "switch-e".to_string(),
                    parent_row_id: Some("device-4".to_string()),
                    label: Some("dist-switch-e".to_string()),
                    depth: 1,
                },
            ],
        };

        let snapshot = build_view_snapshot(
            &topology,
            &tree,
            &CoreDiscoveryRelations::default(),
            &DiscoveryStatus::ready(),
            60,
            None,
        );

        assert_eq!(
            snapshot.primary_row_by_device["switch-e"],
            "device-7/device-13#1"
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
            &CoreDiscoveryRelations::default(),
            &DiscoveryStatus::ready(),
            60,
            None,
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
        assert!(bridge["identity_keys"].get("chassis_id").is_none());
        assert!(bridge["identity_keys"].get("mgmt_ip").is_some());
        assert!(bridge.get("host_label").is_some());
        assert!(value.get("next_auto_discovery_at_ms").is_none());
    }

    #[test]
    fn snapshot_omits_none_option_fields_in_json() {
        let snapshot = ViewSnapshot::empty(DiscoveryStatus::ready(), 60, None);
        let value = serde_json::to_value(&snapshot).unwrap();

        assert!(value["discovery_status"].get("message").is_none());
        assert!(value.get("next_auto_discovery_at_ms").is_none());
        assert_eq!(value["devices"], serde_json::json!([]));

        let link = serde_json::to_value(ViewLink {
            id: "link-1".to_string(),
            local_device_id: "device-a".to_string(),
            local_interface: "eth0".to_string(),
            local_ip: None,
            remote_device_id: "device-b".to_string(),
            remote_interface: "eth1".to_string(),
            remote_ip: None,
            speed_bps: None,
            protocol: "lldp".to_string(),
            guest_attachment: None,
            network_cidrs: Vec::new(),
        })
        .unwrap();
        assert!(link.get("local_ip").is_none());
        assert!(link.get("remote_ip").is_none());
        assert!(link.get("speed_bps").is_none());
        assert!(link.get("guest_attachment").is_none());
        assert_eq!(link["network_cidrs"], serde_json::json!([]));

        let attachment = serde_json::to_value(ViewGuestAttachment {
            bridge_name: "vmbr0".to_string(),
            vlan_tag: None,
            trunk_vlans: Vec::new(),
        })
        .unwrap();
        assert!(attachment.get("vlan_tag").is_none());
        assert!(attachment.get("trunk_vlans").is_none());
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
            &CoreDiscoveryRelations::default(),
            &DiscoveryStatus::ready(),
            60,
            None,
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
            &CoreDiscoveryRelations::default(),
            &DiscoveryStatus::ready(),
            60,
            None,
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
            &CoreDiscoveryRelations::default(),
            &DiscoveryStatus::ready(),
            60,
            None,
        );

        assert_eq!(snapshot.links.len(), 1);
        assert_eq!(snapshot.links[0].protocol, "lldp");
        assert_eq!(snapshot.links[0].guest_attachment, None);
        assert_eq!(snapshot.links[0].network_cidrs, vec!["198.51.100.0/24"]);
    }

    #[test]
    fn snapshot_maps_proxmox_net_slot_to_guest_subinterface_networks() {
        let bridge_id = "proxmox:pve-1:bridge:vmbr0".to_string();
        let router_id = "router-1".to_string();

        let topology = Topology {
            devices: HashMap::from([
                (
                    bridge_id.clone(),
                    device(
                        &bridge_id,
                        "vmbr0",
                        DeviceRole::Bridge,
                        DeploymentType::Virtual,
                        None,
                        Some("pve-1"),
                    ),
                ),
                (
                    router_id.clone(),
                    Device {
                        id: router_id.clone(),
                        identity_keys: IdentityKeys {
                            chassis_id: None,
                            sys_name: Some("vyos01".to_string()),
                            mgmt_ip: Some("192.168.10.72".to_string()),
                            mac_addresses: Vec::new(),
                        },
                        sys_descr: "VyOS".to_string(),
                        vendor: "vyos".to_string(),
                        model: None,
                        device_role: DeviceRole::Router,
                        deployment_type: DeploymentType::Virtual,
                        guest_kind: Some(GuestKind::Vm),
                        interfaces: vec![
                            Interface {
                                if_index: 1,
                                if_name: "eth0".to_string(),
                                ip_addresses: vec!["192.168.10.72/24".to_string()],
                                speed_bps: None,
                                oper_status: OperStatus::Up,
                            },
                            Interface {
                                if_index: 2,
                                if_name: "eth1.20".to_string(),
                                ip_addresses: vec!["10.20.20.1/24".to_string()],
                                speed_bps: None,
                                oper_status: OperStatus::Up,
                            },
                            Interface {
                                if_index: 3,
                                if_name: "eth1.30".to_string(),
                                ip_addresses: vec!["10.20.30.1/24".to_string()],
                                speed_bps: None,
                                oper_status: OperStatus::Up,
                            },
                        ],
                        status: DeviceStatus::Up,
                        host_label: Some("pve-1".to_string()),
                        host_mgmt_ip: Some("192.168.10.50".to_string()),
                        upstream_interface: None,
                        default_gateway_ip: None,
                        default_upstream_device_id: None,
                        last_seen: Utc::now(),
                    },
                ),
            ]),
            links: vec![Link {
                id: "vyos-trunk".to_string(),
                local_device_id: bridge_id,
                local_interface: "vmbr0".to_string(),
                local_ip: Some("192.168.10.50/24".to_string()),
                remote_device_id: router_id,
                remote_interface: "net1".to_string(),
                remote_ip: None,
                speed_bps: None,
                protocol: LinkProtocol::ProxmoxGuestLink,
                guest_attachment: Some(GuestAttachment {
                    bridge_name: "vmbr0".to_string(),
                    vlan_tag: None,
                    trunk_vlans: vec![20, 30],
                }),
            }],
            updated_at: Utc::now(),
        };

        let snapshot = build_view_snapshot(
            &topology,
            &DiscoveryTree::default(),
            &CoreDiscoveryRelations::default(),
            &DiscoveryStatus::ready(),
            60,
            None,
        );

        assert_eq!(
            snapshot.links[0].network_cidrs,
            vec!["10.20.20.0/24", "10.20.30.0/24"]
        );
    }

    #[test]
    fn snapshot_ignores_link_local_guest_addresses_for_access_network_color() {
        let bridge_id = "proxmox:pve-1:bridge:vmbr0".to_string();
        let guest_id = "proxmox:pve-1:qemu:171".to_string();

        let topology = Topology {
            devices: HashMap::from([
                (
                    bridge_id.clone(),
                    device(
                        &bridge_id,
                        "vmbr0",
                        DeviceRole::Bridge,
                        DeploymentType::Virtual,
                        None,
                        Some("pve-1"),
                    ),
                ),
                (
                    guest_id.clone(),
                    Device {
                        id: guest_id.clone(),
                        identity_keys: IdentityKeys {
                            chassis_id: None,
                            sys_name: Some("mc01".to_string()),
                            mgmt_ip: Some("192.168.20.71".to_string()),
                            mac_addresses: Vec::new(),
                        },
                        sys_descr: "Ubuntu VM".to_string(),
                        vendor: "canonical".to_string(),
                        model: None,
                        device_role: DeviceRole::Server,
                        deployment_type: DeploymentType::Virtual,
                        guest_kind: Some(GuestKind::Vm),
                        interfaces: vec![Interface {
                            if_index: 1,
                            if_name: "eth0".to_string(),
                            ip_addresses: vec![
                                "192.168.20.71/24".to_string(),
                                "fe80::be24:11ff:fe32:8045/64".to_string(),
                            ],
                            speed_bps: None,
                            oper_status: OperStatus::Up,
                        }],
                        status: DeviceStatus::Up,
                        host_label: Some("pve-1".to_string()),
                        host_mgmt_ip: Some("192.168.10.50".to_string()),
                        upstream_interface: None,
                        default_gateway_ip: None,
                        default_upstream_device_id: None,
                        last_seen: Utc::now(),
                    },
                ),
            ]),
            links: vec![Link {
                id: "mc01-access".to_string(),
                local_device_id: bridge_id,
                local_interface: "vmbr0".to_string(),
                local_ip: Some("192.168.10.50/24".to_string()),
                remote_device_id: guest_id,
                remote_interface: "eth0".to_string(),
                remote_ip: Some("192.168.20.71/24".to_string()),
                speed_bps: None,
                protocol: LinkProtocol::ProxmoxGuestLink,
                guest_attachment: Some(GuestAttachment {
                    bridge_name: "vmbr0".to_string(),
                    vlan_tag: Some(20),
                    trunk_vlans: Vec::new(),
                }),
            }],
            updated_at: Utc::now(),
        };

        let snapshot = build_view_snapshot(
            &topology,
            &DiscoveryTree::default(),
            &CoreDiscoveryRelations::default(),
            &DiscoveryStatus::ready(),
            60,
            None,
        );

        assert_eq!(snapshot.links[0].network_cidrs, vec!["192.168.20.0/24"]);
    }

    #[test]
    fn sanitize_for_transport_truncates_large_strings_and_keeps_references_consistent() {
        let huge = "node-".repeat(400);
        let snapshot = ViewSnapshot {
            devices: vec![ViewDevice {
                id: huge.clone(),
                label: huge.clone(),
                depth: 0,
                device_role: DeviceRole::Unknown,
                deployment_type: DeploymentType::Unknown,
                guest_kind: None,
                identity_keys: IdentityKeys {
                    chassis_id: Some(huge.clone()),
                    sys_name: Some(huge.clone()),
                    mgmt_ip: Some(huge.clone()),
                    mac_addresses: vec![huge.clone()],
                },
                host_label: Some(huge.clone()),
                upstream_interface: Some(huge.clone()),
                default_upstream_device_id: Some(huge.clone()),
            }],
            links: vec![ViewLink {
                id: huge.clone(),
                local_device_id: huge.clone(),
                local_interface: huge.clone(),
                local_ip: Some(huge.clone()),
                remote_device_id: huge.clone(),
                remote_interface: huge.clone(),
                remote_ip: Some(huge.clone()),
                speed_bps: None,
                protocol: huge.clone(),
                guest_attachment: Some(ViewGuestAttachment {
                    bridge_name: huge.clone(),
                    vlan_tag: None,
                    trunk_vlans: vec![10, 20],
                }),
                network_cidrs: vec![huge.clone()],
            }],
            tree_rows: vec![TreeRow {
                id: huge.clone(),
                device_id: huge.clone(),
                label: huge.clone(),
            }],
            tree_edges: vec![TreeEdge {
                parent_row_id: huge.clone(),
                child_row_id: huge.clone(),
            }],
            primary_row_by_device: HashMap::from([(huge.clone(), huge.clone())]),
            root_device_ids: vec![huge.clone()],
            device_relations: HashMap::from([(
                huge.clone(),
                ViewDeviceRelations {
                    parents: vec![huge.clone()],
                    peers: vec![huge.clone()],
                    children: vec![huge.clone()],
                },
            )]),
            discovery_status: DiscoveryStatus::failed(huge.clone()),
            auto_discovery_interval_seconds: 60,
            next_auto_discovery_at_ms: None,
        };

        let sanitized = snapshot.sanitize_for_transport();
        let device_id = sanitized.devices[0].id.clone();
        let row_id = sanitized.tree_rows[0].id.clone();

        assert!(device_id.len() <= MAX_TRANSPORT_ID_CHARS + 8);
        assert!(row_id.len() <= MAX_TRANSPORT_ID_CHARS + 8);
        assert!(sanitized.devices[0].label.chars().count() <= MAX_TRANSPORT_TEXT_CHARS);
        assert!(sanitized.devices[0]
            .identity_keys
            .sys_name
            .as_ref()
            .is_some_and(|value| value.chars().count() <= MAX_TRANSPORT_TEXT_CHARS));
        assert!(sanitized
            .discovery_status
            .message
            .is_some_and(|value| { value.chars().count() <= MAX_TRANSPORT_MESSAGE_CHARS }));
        assert_eq!(sanitized.links[0].local_device_id, device_id);
        assert_eq!(sanitized.links[0].remote_device_id, device_id);
        assert_eq!(sanitized.tree_rows[0].device_id, device_id);
        assert_eq!(sanitized.tree_edges[0].parent_row_id, row_id);
        assert_eq!(sanitized.tree_edges[0].child_row_id, row_id);
        assert_eq!(sanitized.primary_row_by_device[&device_id], row_id);
        assert_eq!(sanitized.root_device_ids, vec![device_id.clone()]);
        assert_eq!(
            sanitized.device_relations[&device_id].parents,
            vec![device_id.clone()]
        );
        assert_eq!(
            sanitized.device_relations[&device_id].peers,
            vec![device_id.clone()]
        );
        assert_eq!(
            sanitized.device_relations[&device_id].children,
            vec![device_id.clone()]
        );
    }

    #[test]
    fn sanitize_for_transport_caps_collection_sizes_and_reports_truncation() {
        let make_device = |index: usize| ViewDevice {
            id: format!("device-{index}"),
            label: format!("device-{index}"),
            depth: 0,
            device_role: DeviceRole::Unknown,
            deployment_type: DeploymentType::Unknown,
            guest_kind: None,
            identity_keys: IdentityKeys {
                chassis_id: None,
                sys_name: Some(format!("device-{index}")),
                mgmt_ip: None,
                mac_addresses: Vec::new(),
            },
            host_label: None,
            upstream_interface: None,
            default_upstream_device_id: None,
        };
        let snapshot = ViewSnapshot {
            devices: (0..(MAX_TRANSPORT_DEVICES + 10)).map(make_device).collect(),
            links: (0..(MAX_TRANSPORT_LINKS + 10))
                .map(|index| ViewLink {
                    id: format!("link-{index}"),
                    local_device_id: "device-0".to_string(),
                    local_interface: "eth0".to_string(),
                    local_ip: None,
                    remote_device_id: "device-1".to_string(),
                    remote_interface: "eth1".to_string(),
                    remote_ip: None,
                    speed_bps: None,
                    protocol: "lldp".to_string(),
                    guest_attachment: None,
                    network_cidrs: Vec::new(),
                })
                .collect(),
            tree_rows: (0..(MAX_TRANSPORT_TREE_ROWS + 10))
                .map(|index| TreeRow {
                    id: format!("row-{index}"),
                    device_id: "device-0".to_string(),
                    label: format!("row-{index}"),
                })
                .collect(),
            tree_edges: (0..(MAX_TRANSPORT_TREE_EDGES + 10))
                .map(|index| TreeEdge {
                    parent_row_id: "row-0".to_string(),
                    child_row_id: format!("row-{index}"),
                })
                .collect(),
            primary_row_by_device: HashMap::from([("device-0".to_string(), "row-0".to_string())]),
            root_device_ids: (0..(MAX_TRANSPORT_DEVICES + 10))
                .map(|index| format!("device-{index}"))
                .collect(),
            device_relations: HashMap::new(),
            discovery_status: DiscoveryStatus::ready(),
            auto_discovery_interval_seconds: 60,
            next_auto_discovery_at_ms: None,
        };

        let sanitized = snapshot.sanitize_for_transport();

        assert_eq!(sanitized.devices.len(), MAX_TRANSPORT_DEVICES);
        assert_eq!(sanitized.links.len(), MAX_TRANSPORT_LINKS);
        assert_eq!(sanitized.tree_rows.len(), MAX_TRANSPORT_TREE_ROWS);
        assert_eq!(sanitized.tree_edges.len(), MAX_TRANSPORT_TREE_EDGES);
        assert_eq!(sanitized.root_device_ids.len(), MAX_TRANSPORT_DEVICES);
        assert!(sanitized
            .discovery_status
            .message
            .is_some_and(|message| message.contains("表示を安定させるため")));
    }
}
