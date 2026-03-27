use std::collections::HashMap;

use anyhow::{anyhow, Result};
use chrono::Utc;

use crate::{
    collectors::ObservedLink,
    graph::{
        Device, DeviceKind, DeviceStatus, IdentityKeys, Interface, Link, LinkProtocol, Topology,
    },
};

#[derive(Debug, Default)]
pub struct GraphStore {
    devices: HashMap<String, Device>,
    links: HashMap<String, Link>,
    by_chassis_id: HashMap<String, String>,
    by_mgmt_ip: HashMap<String, String>,
    by_sys_name: HashMap<String, String>,
    next_device_number: u64,
}

impl GraphStore {
    pub fn absorb_topology(&mut self, topology: &Topology) -> HashMap<String, String> {
        let mut id_map = HashMap::new();
        let mut device_ids: Vec<String> = topology.devices.keys().cloned().collect();
        device_ids.sort();

        for device_id in device_ids {
            let mut device = topology
                .devices
                .get(&device_id)
                .cloned()
                .unwrap_or_else(Device::empty);
            if device.id.is_empty() {
                device.id = device_id.clone();
            }
            let canonical_id = self.upsert_device(device);
            id_map.insert(device_id, canonical_id);
        }

        let mut links = topology.links.clone();
        links.sort_by(|left, right| left.id.cmp(&right.id));
        for mut link in links {
            if let Some(device_id) = id_map.get(&link.local_device_id) {
                link.local_device_id = device_id.clone();
            }
            if let Some(device_id) = id_map.get(&link.remote_device_id) {
                link.remote_device_id = device_id.clone();
            }
            let _ = self.upsert_link(link);
        }

        id_map
    }

    pub fn upsert_device(&mut self, device: Device) -> String {
        let existing_id = self
            .match_device_id(&device)
            .or_else(|| self.resolve_explicit_id(&device.id));

        match existing_id {
            Some(device_id) => {
                let merged = {
                    let current = self
                        .devices
                        .get(&device_id)
                        .cloned()
                        .unwrap_or_else(Device::empty);
                    self.merge_device(current, device)
                };
                self.devices.insert(device_id.clone(), merged.clone());
                self.index_device(&merged);
                self.refresh_links_for_device(&device_id);
                device_id
            }
            None => {
                let device_id = if device.id.is_empty() {
                    self.allocate_device_id()
                } else {
                    device.id.clone()
                };
                let inserted = Device {
                    id: device_id.clone(),
                    last_seen: if device.last_seen.timestamp() == 0 {
                        Utc::now()
                    } else {
                        device.last_seen
                    },
                    ..device
                };
                self.devices.insert(device_id.clone(), inserted.clone());
                self.index_device(&inserted);
                self.refresh_links_for_device(&device_id);
                device_id
            }
        }
    }

    pub fn upsert_observed_link(&mut self, link: ObservedLink) -> Result<String> {
        let remote_device_id = self
            .match_identity_for_observed_link(&link.remote_identity)
            .ok_or_else(|| anyhow!("remote device not found for {:?}", link.remote_identity))?;

        let local_endpoint = Endpoint {
            device_id: link.local_device_id.clone(),
            interface: link.local_interface.clone(),
        };
        let remote_endpoint = Endpoint {
            device_id: remote_device_id.clone(),
            interface: link.remote_interface.clone(),
        };
        let (left, right) = canonicalize_endpoints(local_endpoint, remote_endpoint);

        let link_id = canonical_link_id(
            &left.device_id,
            &left.interface,
            &right.device_id,
            &right.interface,
            &link.protocol,
        );
        let stored = Link {
            id: link_id.clone(),
            local_device_id: left.device_id.clone(),
            local_interface: left.interface.clone(),
            local_ip: self.lookup_interface_ip(&left.device_id, &left.interface),
            remote_device_id: right.device_id.clone(),
            remote_interface: right.interface.clone(),
            remote_ip: self.lookup_interface_ip(&right.device_id, &right.interface),
            speed_bps: link.speed_bps,
            protocol: link.protocol,
        };

        self.links.insert(link_id.clone(), stored);
        Ok(link_id)
    }

    pub fn upsert_link(&mut self, link: Link) -> String {
        let (left, right) = canonicalize_endpoints(
            Endpoint {
                device_id: link.local_device_id.clone(),
                interface: link.local_interface.clone(),
            },
            Endpoint {
                device_id: link.remote_device_id.clone(),
                interface: link.remote_interface.clone(),
            },
        );
        let link_id = canonical_link_id(
            &left.device_id,
            &left.interface,
            &right.device_id,
            &right.interface,
            &link.protocol,
        );

        let stored = Link {
            id: link_id.clone(),
            local_device_id: left.device_id.clone(),
            local_interface: left.interface.clone(),
            local_ip: self.lookup_interface_ip(&left.device_id, &left.interface),
            remote_device_id: right.device_id.clone(),
            remote_interface: right.interface.clone(),
            remote_ip: self.lookup_interface_ip(&right.device_id, &right.interface),
            speed_bps: link.speed_bps,
            protocol: link.protocol,
        };

        self.links.insert(link_id.clone(), stored);
        link_id
    }

    pub fn topology(&self) -> Topology {
        let mut links: Vec<Link> = self.links.values().cloned().collect();
        links.sort_by(|left, right| left.id.cmp(&right.id));

        Topology {
            devices: self.devices.clone(),
            links,
            updated_at: Utc::now(),
        }
    }

    fn allocate_device_id(&mut self) -> String {
        self.next_device_number += 1;
        format!("device-{}", self.next_device_number)
    }

    fn resolve_explicit_id(&self, device_id: &str) -> Option<String> {
        if device_id.is_empty() || !self.devices.contains_key(device_id) {
            return None;
        }
        Some(device_id.to_string())
    }

    fn match_device_id(&self, device: &Device) -> Option<String> {
        self.resolve_explicit_id(&device.id)
            .or_else(|| self.match_identity(device))
    }

    fn match_identity(&self, device: &Device) -> Option<String> {
        let identity = &device.identity_keys;

        if let Some(chassis_id) = identity.chassis_id.as_ref() {
            if let Some(id) = self.by_chassis_id.get(chassis_id) {
                let existing = self.devices.get(id)?;
                if can_merge_identity(existing, device) {
                    return Some(id.clone());
                }
            }
        }

        if let Some(mgmt_ip) = identity.mgmt_ip.as_ref() {
            if let Some(id) = self.by_mgmt_ip.get(mgmt_ip) {
                let existing = self.devices.get(id)?;
                if can_merge_identity(existing, device) {
                    return Some(id.clone());
                }
            }
        }

        let sys_name = identity.sys_name.as_ref()?;
        let candidate = self.by_sys_name.get(sys_name)?.clone();
        let existing = self.devices.get(&candidate)?;

        if !can_merge_identity(existing, device)
            || conflicts_with_strong_identity(existing, identity)
        {
            return None;
        }

        Some(candidate)
    }

    fn match_identity_for_observed_link(&self, identity: &IdentityKeys) -> Option<String> {
        if let Some(chassis_id) = identity.chassis_id.as_ref() {
            if let Some(id) = self.by_chassis_id.get(chassis_id) {
                return Some(id.clone());
            }
        }

        if let Some(mgmt_ip) = identity.mgmt_ip.as_ref() {
            if let Some(id) = self.by_mgmt_ip.get(mgmt_ip) {
                return Some(id.clone());
            }
        }

        let sys_name = identity.sys_name.as_ref()?;
        let candidate = self.by_sys_name.get(sys_name)?.clone();
        let existing = self.devices.get(&candidate)?;

        if conflicts_with_strong_identity(existing, identity) {
            return None;
        }

        Some(candidate)
    }

    fn merge_device(&self, mut current: Device, incoming: Device) -> Device {
        current.identity_keys =
            merge_identity_keys(&current.identity_keys, &incoming.identity_keys);
        if current.sys_descr.is_empty() && !incoming.sys_descr.is_empty() {
            current.sys_descr = incoming.sys_descr;
        }
        if (current.vendor.is_empty() || current.vendor == "unknown") && !incoming.vendor.is_empty()
        {
            current.vendor = incoming.vendor;
        }
        if current.model.is_none() && incoming.model.is_some() {
            current.model = incoming.model;
        }
        current.device_kind = merge_device_kind(current.device_kind.clone(), incoming.device_kind);
        if !incoming.interfaces.is_empty() {
            current.interfaces = merge_interfaces(&current.interfaces, &incoming.interfaces);
        }
        if incoming.status != DeviceStatus::Unknown {
            current.status = incoming.status;
        }
        current.host_label = merge_optional_stable(&current.host_label, &incoming.host_label);
        current.host_mgmt_ip = merge_optional_stable(&current.host_mgmt_ip, &incoming.host_mgmt_ip);
        current.uplink_interface =
            merge_optional_stable(&current.uplink_interface, &incoming.uplink_interface);
        current.last_seen = incoming.last_seen;
        current
    }

    fn index_device(&mut self, device: &Device) {
        if let Some(chassis_id) = device.identity_keys.chassis_id.as_ref() {
            self.by_chassis_id
                .insert(chassis_id.clone(), device.id.clone());
        }
        if let Some(mgmt_ip) = device.identity_keys.mgmt_ip.as_ref() {
            self.by_mgmt_ip.insert(mgmt_ip.clone(), device.id.clone());
        }
        if let Some(sys_name) = device.identity_keys.sys_name.as_ref() {
            self.by_sys_name.insert(sys_name.clone(), device.id.clone());
        }
    }

    fn refresh_links_for_device(&mut self, device_id: &str) {
        let link_ids: Vec<String> = self
            .links
            .values()
            .filter(|link| link.local_device_id == device_id || link.remote_device_id == device_id)
            .map(|link| link.id.clone())
            .collect();

        for link_id in link_ids {
            let endpoints = self.links.get(&link_id).map(|link| {
                (
                    link.local_device_id.clone(),
                    link.local_interface.clone(),
                    link.remote_device_id.clone(),
                    link.remote_interface.clone(),
                )
            });

            if let Some((local_device_id, local_interface, remote_device_id, remote_interface)) =
                endpoints
            {
                let local_ip = self.lookup_interface_ip(&local_device_id, &local_interface);
                let remote_ip = self.lookup_interface_ip(&remote_device_id, &remote_interface);
                if let Some(link) = self.links.get_mut(&link_id) {
                    link.local_ip = local_ip;
                    link.remote_ip = remote_ip;
                }
            }
        }
    }

    fn lookup_interface_ip(&self, device_id: &str, interface_name: &str) -> Option<String> {
        self.devices.get(device_id).and_then(|device| {
            device
                .interfaces
                .iter()
                .find(|interface| interface.if_name == interface_name)
                .and_then(|interface| interface.ip_addresses.first().cloned())
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Endpoint {
    device_id: String,
    interface: String,
}

fn endpoint_key(device_id: &str, interface: &str) -> String {
    format!("{device_id}::{interface}")
}

fn canonicalize_endpoints(left: Endpoint, right: Endpoint) -> (Endpoint, Endpoint) {
    let left_key = endpoint_key(&left.device_id, &left.interface);
    let right_key = endpoint_key(&right.device_id, &right.interface);
    if left_key <= right_key {
        (left, right)
    } else {
        (right, left)
    }
}

fn canonical_link_id(
    left_device_id: &str,
    left_interface: &str,
    right_device_id: &str,
    right_interface: &str,
    protocol: &LinkProtocol,
) -> String {
    format!(
        "{}::{}--{}::{}::{}",
        left_device_id,
        left_interface,
        right_device_id,
        right_interface,
        protocol.as_str()
    )
}

fn conflicts_with_strong_identity(existing: &Device, incoming: &IdentityKeys) -> bool {
    if let (Some(existing_chassis), Some(incoming_chassis)) = (
        existing.identity_keys.chassis_id.as_ref(),
        incoming.chassis_id.as_ref(),
    ) {
        if existing_chassis != incoming_chassis {
            return true;
        }
    }

    if let (Some(existing_ip), Some(incoming_ip)) = (
        existing.identity_keys.mgmt_ip.as_ref(),
        incoming.mgmt_ip.as_ref(),
    ) {
        if existing_ip != incoming_ip {
            return true;
        }
    }

    false
}

fn can_merge_identity(existing: &Device, incoming: &Device) -> bool {
    !((existing.device_kind.is_virtual() && incoming.device_kind.is_physical())
        || (existing.device_kind.is_physical() && incoming.device_kind.is_virtual()))
}

fn merge_identity_keys(current: &IdentityKeys, incoming: &IdentityKeys) -> IdentityKeys {
    IdentityKeys {
        chassis_id: incoming
            .chassis_id
            .clone()
            .or_else(|| current.chassis_id.clone()),
        sys_name: incoming
            .sys_name
            .clone()
            .or_else(|| current.sys_name.clone()),
        mgmt_ip: incoming.mgmt_ip.clone().or_else(|| current.mgmt_ip.clone()),
    }
}

fn merge_device_kind(current: DeviceKind, incoming: DeviceKind) -> DeviceKind {
    match (current, incoming) {
        (DeviceKind::Unknown, next) => next,
        (current, DeviceKind::Unknown) => current,
        (current, incoming) if current == incoming => current,
        (current, _) => current,
    }
}

fn merge_optional_stable(current: &Option<String>, incoming: &Option<String>) -> Option<String> {
    match (
        current
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty()),
        incoming
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty()),
    ) {
        (None, Some(value)) => Some(value.to_string()),
        (Some(current), Some(incoming)) if current == incoming => Some(current.to_string()),
        (Some(current), Some(_)) => Some(current.to_string()),
        (Some(current), None) => Some(current.to_string()),
        (None, None) => None,
    }
}

fn merge_interfaces(current: &[Interface], incoming: &[Interface]) -> Vec<Interface> {
    let mut by_index: HashMap<u32, Interface> = current
        .iter()
        .cloned()
        .map(|interface| (interface.if_index, interface))
        .collect();

    for interface in incoming {
        by_index.insert(interface.if_index, interface.clone());
    }

    let mut merged: Vec<Interface> = by_index.into_values().collect();
    merged.sort_by_key(|interface| interface.if_index);
    merged
}

pub fn synthesize_proxmox_uplinks(topology: &Topology) -> Vec<Link> {
    let physical_interfaces = collect_physical_interfaces(topology);
    let mut links = Vec::new();

    for bridge in topology
        .devices
        .values()
        .filter(|device| device.device_kind == DeviceKind::Bridge)
    {
        let already_connected = topology.links.iter().any(|link| {
            link.protocol == LinkProtocol::ProxmoxUplink
                && (link.local_device_id == bridge.id || link.remote_device_id == bridge.id)
        });
        if already_connected {
            continue;
        }

        let Some(candidate) = choose_uplink_candidate(bridge, &physical_interfaces) else {
            continue;
        };

        links.push(Link {
            id: String::new(),
            local_device_id: bridge.id.clone(),
            local_interface: bridge
                .uplink_interface
                .clone()
                .unwrap_or_else(|| bridge.label()),
            local_ip: None,
            remote_device_id: candidate.device_id.clone(),
            remote_interface: candidate.interface.if_name.clone(),
            remote_ip: None,
            speed_bps: candidate.interface.speed_bps,
            protocol: LinkProtocol::ProxmoxUplink,
        });
    }

    let mut store = GraphStore::default();
    store.absorb_topology(topology);
    for link in links {
        let _ = store.upsert_link(link);
    }
    store
        .topology()
        .links
        .into_iter()
        .filter(|link| link.protocol == LinkProtocol::ProxmoxUplink)
        .collect()
}

#[derive(Debug, Clone)]
struct PhysicalInterfaceCandidate {
    device_id: String,
    device_mgmt_ip: Option<String>,
    interface: Interface,
}

fn collect_physical_interfaces(topology: &Topology) -> Vec<PhysicalInterfaceCandidate> {
    topology
        .devices
        .values()
        .filter(|device| device.device_kind.is_physical())
        .flat_map(|device| {
            device
                .interfaces
                .iter()
                .cloned()
                .map(|interface| PhysicalInterfaceCandidate {
                    device_id: device.id.clone(),
                    device_mgmt_ip: device.identity_keys.mgmt_ip.clone(),
                    interface,
                })
        })
        .collect()
}

fn choose_uplink_candidate<'a>(
    bridge: &Device,
    physical_interfaces: &'a [PhysicalInterfaceCandidate],
) -> Option<&'a PhysicalInterfaceCandidate> {
    if let Some(uplink) = bridge
        .uplink_interface
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        if let Some(candidate) = single_candidate(
            physical_interfaces
                .iter()
                .filter(|candidate| candidate.interface.if_name == uplink),
        ) {
            return Some(candidate);
        }
    }

    let bridge_management_ips = bridge_management_ips(bridge);
    if let Some(candidate) = single_candidate(physical_interfaces.iter().filter(|candidate| {
        bridge_management_ips.iter().any(|bridge_ip| {
            candidate.device_mgmt_ip.as_deref() == Some(bridge_ip.as_str())
                || candidate
                    .interface
                    .ip_addresses
                    .iter()
                    .filter_map(|value| split_cidr(value).map(|(ip, _)| ip))
                    .any(|candidate_ip| candidate_ip == *bridge_ip)
        })
    })) {
        return Some(candidate);
    }

    let bridge_names: Vec<&str> = bridge
        .interfaces
        .iter()
        .map(|interface| interface.if_name.as_str())
        .collect();
    if let Some(candidate) = single_candidate(physical_interfaces.iter().filter(|candidate| {
        bridge_names
            .iter()
            .any(|bridge_name| candidate.interface.if_name == *bridge_name)
    })) {
        return Some(candidate);
    }

    let bridge_networks = bridge_networks(bridge);
    single_candidate(physical_interfaces.iter().filter(|candidate| {
        candidate.interface.ip_addresses.iter().any(|value| {
            let Some((candidate_ip, prefix)) = split_cidr(value) else {
                return false;
            };
            bridge_networks
                .iter()
                .any(|(bridge_network, bridge_prefix)| {
                    *bridge_prefix == prefix
                        && network_of(candidate_ip.clone(), prefix) == *bridge_network
                })
        })
    }))
}

fn single_candidate<'a, I>(iter: I) -> Option<&'a PhysicalInterfaceCandidate>
where
    I: Iterator<Item = &'a PhysicalInterfaceCandidate>,
{
    let candidates: Vec<&PhysicalInterfaceCandidate> = iter.collect();
    if candidates.len() == 1 {
        candidates.into_iter().next()
    } else {
        None
    }
}

fn bridge_ip_addrs(bridge: &Device) -> Vec<String> {
    bridge
        .interfaces
        .iter()
        .flat_map(|interface| interface.ip_addresses.iter())
        .filter_map(|value| split_cidr(value).map(|(ip, _)| ip))
        .collect()
}

fn bridge_management_ips(bridge: &Device) -> Vec<String> {
    let mut values = bridge_ip_addrs(bridge);
    if let Some(host_mgmt_ip) = bridge
        .host_mgmt_ip
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        values.push(host_mgmt_ip.to_string());
    }
    values.sort();
    values.dedup();
    values
}

fn bridge_networks(bridge: &Device) -> Vec<(u32, u8)> {
    bridge
        .interfaces
        .iter()
        .flat_map(|interface| interface.ip_addresses.iter())
        .filter_map(|value| split_cidr(value).map(|(ip, prefix)| (network_of(ip, prefix), prefix)))
        .collect()
}

fn split_cidr(value: &str) -> Option<(String, u8)> {
    let (ip, prefix) = value.split_once('/')?;
    let prefix = prefix.parse().ok()?;
    Some((ip.to_string(), prefix))
}

fn network_of(ip: String, prefix: u8) -> u32 {
    let Ok(address) = ip.parse::<std::net::Ipv4Addr>() else {
        return 0;
    };
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - u32::from(prefix))
    };
    u32::from(address) & mask
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use super::*;
    use crate::OperStatus;

    fn sample_device(
        id: &str,
        chassis_id: Option<&str>,
        sys_name: Option<&str>,
        mgmt_ip: Option<&str>,
    ) -> Device {
        Device {
            id: id.to_string(),
            identity_keys: IdentityKeys {
                chassis_id: chassis_id.map(str::to_string),
                sys_name: sys_name.map(str::to_string),
                mgmt_ip: mgmt_ip.map(str::to_string),
            },
            sys_descr: "Generic device".to_string(),
            vendor: "vendor".to_string(),
            model: None,
            device_kind: DeviceKind::Unknown,
            interfaces: Vec::new(),
            status: DeviceStatus::Up,
            host_label: None,
            host_mgmt_ip: None,
            uplink_interface: None,
            last_seen: Utc.with_ymd_and_hms(2026, 3, 27, 0, 0, 0).unwrap(),
        }
    }

    #[test]
    fn deduplicates_by_chassis_id() {
        let mut store = GraphStore::default();
        let first = sample_device(
            "device-a",
            Some("aa:bb"),
            Some("core-a"),
            Some("192.0.2.10"),
        );
        let second = sample_device(
            "device-b",
            Some("aa:bb"),
            Some("core-b"),
            Some("192.0.2.11"),
        );

        let first_id = store.upsert_device(first);
        let second_id = store.upsert_device(second);

        assert_eq!(first_id, second_id);
        assert_eq!(store.topology().devices.len(), 1);
    }

    #[test]
    fn avoids_sys_name_false_match_when_strong_identity_conflicts() {
        let mut store = GraphStore::default();
        let first = sample_device("device-a", Some("aa:bb"), Some("core"), Some("192.0.2.10"));
        let second = sample_device("device-b", Some("cc:dd"), Some("core"), Some("192.0.2.20"));

        let first_id = store.upsert_device(first);
        let second_id = store.upsert_device(second);

        assert_ne!(first_id, second_id);
        assert_eq!(store.topology().devices.len(), 2);
    }

    #[test]
    fn keeps_internal_id_when_mgmt_ip_is_added_later() {
        let mut store = GraphStore::default();
        let first = sample_device("device-a", Some("aa:bb"), Some("core"), None);
        let first_id = store.upsert_device(first);

        let second = sample_device("device-z", Some("aa:bb"), Some("core"), Some("192.0.2.10"));
        let second_id = store.upsert_device(second);

        assert_eq!(first_id, second_id);
        assert_eq!(
            store.topology().devices[&first_id]
                .identity_keys
                .mgmt_ip
                .as_deref(),
            Some("192.0.2.10")
        );
    }

    #[test]
    fn canonicalizes_reverse_link_observations() {
        let mut store = GraphStore::default();
        let left_id = store.upsert_device(sample_device("device-1", None, Some("left"), None));
        let right_id = store.upsert_device(sample_device("device-2", None, Some("right"), None));

        let first = ObservedLink {
            local_device_id: right_id.clone(),
            local_interface: "ge-0/0/1".to_string(),
            remote_identity: IdentityKeys {
                chassis_id: None,
                sys_name: Some("left".to_string()),
                mgmt_ip: None,
            },
            remote_interface: "ge-0/0/0".to_string(),
            remote_sys_descr: None,
            speed_bps: Some(1_000_000_000),
            protocol: LinkProtocol::Lldp,
        };

        let second = ObservedLink {
            local_device_id: left_id.clone(),
            local_interface: "ge-0/0/0".to_string(),
            remote_identity: IdentityKeys {
                chassis_id: None,
                sys_name: Some("right".to_string()),
                mgmt_ip: None,
            },
            remote_interface: "ge-0/0/1".to_string(),
            remote_sys_descr: None,
            speed_bps: Some(1_000_000_000),
            protocol: LinkProtocol::Lldp,
        };

        let first_id = store.upsert_observed_link(first).unwrap();
        let second_id = store.upsert_observed_link(second).unwrap();

        assert_eq!(first_id, second_id);
        assert_eq!(store.topology().links.len(), 1);
    }

    #[test]
    fn host_label_prefers_existing_non_empty_value() {
        let mut store = GraphStore::default();
        let mut first = sample_device("device-1", None, Some("vm-101"), None);
        first.device_kind = DeviceKind::VirtualMachine;
        first.host_label = Some("pve-a".to_string());
        let id = store.upsert_device(first);

        let mut second = sample_device(&id, None, Some("vm-101"), None);
        second.device_kind = DeviceKind::VirtualMachine;
        second.host_label = Some("pve-b".to_string());
        store.upsert_device(second);

        assert_eq!(
            store.topology().devices[&id].host_label.as_deref(),
            Some("pve-a")
        );
    }

    #[test]
    fn synthesize_proxmox_uplink_prefers_single_uplink_name_match() {
        let bridge = Device {
            id: "bridge-1".to_string(),
            identity_keys: IdentityKeys::default(),
            sys_descr: "Proxmox bridge".to_string(),
            vendor: "proxmox".to_string(),
            model: None,
            device_kind: DeviceKind::Bridge,
            interfaces: vec![Interface {
                if_index: 1,
                if_name: "vmbr0".to_string(),
                ip_addresses: vec!["192.0.2.10/24".to_string()],
                speed_bps: None,
                oper_status: OperStatus::Up,
            }],
            status: DeviceStatus::Up,
            host_label: Some("pve-a".to_string()),
            host_mgmt_ip: Some("192.0.2.10".to_string()),
            uplink_interface: Some("eno1".to_string()),
            last_seen: Utc::now(),
        };
        let physical = Device {
            id: "device-1".to_string(),
            identity_keys: IdentityKeys {
                chassis_id: None,
                sys_name: Some("host-a".to_string()),
                mgmt_ip: Some("192.0.2.10".to_string()),
            },
            sys_descr: "Linux host".to_string(),
            vendor: "generic".to_string(),
            model: None,
            device_kind: DeviceKind::PhysicalServer,
            interfaces: vec![Interface {
                if_index: 2,
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

        let topology = Topology {
            devices: HashMap::from([(bridge.id.clone(), bridge), (physical.id.clone(), physical)]),
            links: Vec::new(),
            updated_at: Utc::now(),
        };

        let links = synthesize_proxmox_uplinks(&topology);

        assert_eq!(links.len(), 1);
        assert_eq!(links[0].protocol, LinkProtocol::ProxmoxUplink);
        assert_eq!(links[0].remote_interface, "eno1");
    }

    #[test]
    fn synthesize_proxmox_uplink_matches_same_host_management_ip() {
        let bridge = Device {
            id: "bridge-1".to_string(),
            identity_keys: IdentityKeys::default(),
            sys_descr: "Proxmox bridge".to_string(),
            vendor: "proxmox".to_string(),
            model: None,
            device_kind: DeviceKind::Bridge,
            interfaces: vec![Interface {
                if_index: 1,
                if_name: "vmbr0".to_string(),
                ip_addresses: Vec::new(),
                speed_bps: None,
                oper_status: OperStatus::Up,
            }],
            status: DeviceStatus::Up,
            host_label: Some("pve-a".to_string()),
            host_mgmt_ip: Some("192.0.2.10".to_string()),
            uplink_interface: None,
            last_seen: Utc::now(),
        };
        let physical = Device {
            id: "device-1".to_string(),
            identity_keys: IdentityKeys {
                chassis_id: None,
                sys_name: Some("host-a".to_string()),
                mgmt_ip: Some("192.0.2.10".to_string()),
            },
            sys_descr: "Linux host".to_string(),
            vendor: "generic".to_string(),
            model: None,
            device_kind: DeviceKind::PhysicalServer,
            interfaces: vec![Interface {
                if_index: 2,
                if_name: "eno9".to_string(),
                ip_addresses: vec!["198.51.100.2/24".to_string()],
                speed_bps: Some(1_000_000_000),
                oper_status: OperStatus::Up,
            }],
            status: DeviceStatus::Up,
            host_label: None,
            host_mgmt_ip: None,
            uplink_interface: None,
            last_seen: Utc::now(),
        };

        let topology = Topology {
            devices: HashMap::from([(bridge.id.clone(), bridge), (physical.id.clone(), physical)]),
            links: Vec::new(),
            updated_at: Utc::now(),
        };

        let links = synthesize_proxmox_uplinks(&topology);

        assert_eq!(links.len(), 1);
        assert_eq!(links[0].remote_device_id, "device-1");
        assert_eq!(links[0].remote_interface, "eno9");
    }

    #[test]
    fn synthesize_proxmox_uplink_matches_single_interface_name_candidate() {
        let bridge = Device {
            id: "bridge-1".to_string(),
            identity_keys: IdentityKeys::default(),
            sys_descr: "Proxmox bridge".to_string(),
            vendor: "proxmox".to_string(),
            model: None,
            device_kind: DeviceKind::Bridge,
            interfaces: vec![
                Interface {
                    if_index: 1,
                    if_name: "vmbr0".to_string(),
                    ip_addresses: Vec::new(),
                    speed_bps: None,
                    oper_status: OperStatus::Up,
                },
                Interface {
                    if_index: 2,
                    if_name: "enp3s0".to_string(),
                    ip_addresses: Vec::new(),
                    speed_bps: None,
                    oper_status: OperStatus::Up,
                },
            ],
            status: DeviceStatus::Up,
            host_label: Some("pve-a".to_string()),
            host_mgmt_ip: None,
            uplink_interface: None,
            last_seen: Utc::now(),
        };
        let physical = Device {
            id: "device-1".to_string(),
            identity_keys: IdentityKeys {
                chassis_id: None,
                sys_name: Some("host-a".to_string()),
                mgmt_ip: Some("198.51.100.10".to_string()),
            },
            sys_descr: "Linux host".to_string(),
            vendor: "generic".to_string(),
            model: None,
            device_kind: DeviceKind::PhysicalServer,
            interfaces: vec![Interface {
                if_index: 2,
                if_name: "enp3s0".to_string(),
                ip_addresses: Vec::new(),
                speed_bps: Some(1_000_000_000),
                oper_status: OperStatus::Up,
            }],
            status: DeviceStatus::Up,
            host_label: None,
            host_mgmt_ip: None,
            uplink_interface: None,
            last_seen: Utc::now(),
        };

        let topology = Topology {
            devices: HashMap::from([(bridge.id.clone(), bridge), (physical.id.clone(), physical)]),
            links: Vec::new(),
            updated_at: Utc::now(),
        };

        let links = synthesize_proxmox_uplinks(&topology);

        assert_eq!(links.len(), 1);
        assert_eq!(links[0].remote_interface, "enp3s0");
    }

    #[test]
    fn synthesize_proxmox_uplink_matches_single_subnet_candidate() {
        let bridge = Device {
            id: "bridge-1".to_string(),
            identity_keys: IdentityKeys::default(),
            sys_descr: "Proxmox bridge".to_string(),
            vendor: "proxmox".to_string(),
            model: None,
            device_kind: DeviceKind::Bridge,
            interfaces: vec![Interface {
                if_index: 1,
                if_name: "vmbr0".to_string(),
                ip_addresses: vec!["10.0.0.1/24".to_string()],
                speed_bps: None,
                oper_status: OperStatus::Up,
            }],
            status: DeviceStatus::Up,
            host_label: Some("pve-a".to_string()),
            host_mgmt_ip: None,
            uplink_interface: None,
            last_seen: Utc::now(),
        };
        let physical = Device {
            id: "device-1".to_string(),
            identity_keys: IdentityKeys {
                chassis_id: None,
                sys_name: Some("host-a".to_string()),
                mgmt_ip: Some("198.51.100.10".to_string()),
            },
            sys_descr: "Linux host".to_string(),
            vendor: "generic".to_string(),
            model: None,
            device_kind: DeviceKind::PhysicalServer,
            interfaces: vec![Interface {
                if_index: 2,
                if_name: "eno7".to_string(),
                ip_addresses: vec!["10.0.0.2/24".to_string()],
                speed_bps: Some(1_000_000_000),
                oper_status: OperStatus::Up,
            }],
            status: DeviceStatus::Up,
            host_label: None,
            host_mgmt_ip: None,
            uplink_interface: None,
            last_seen: Utc::now(),
        };

        let topology = Topology {
            devices: HashMap::from([(bridge.id.clone(), bridge), (physical.id.clone(), physical)]),
            links: Vec::new(),
            updated_at: Utc::now(),
        };

        let links = synthesize_proxmox_uplinks(&topology);

        assert_eq!(links.len(), 1);
        assert_eq!(links[0].remote_interface, "eno7");
    }

    #[test]
    fn synthesize_proxmox_uplink_skips_ambiguous_candidates() {
        let bridge = Device {
            id: "bridge-1".to_string(),
            identity_keys: IdentityKeys::default(),
            sys_descr: "Proxmox bridge".to_string(),
            vendor: "proxmox".to_string(),
            model: None,
            device_kind: DeviceKind::Bridge,
            interfaces: vec![Interface {
                if_index: 1,
                if_name: "vmbr0".to_string(),
                ip_addresses: Vec::new(),
                speed_bps: None,
                oper_status: OperStatus::Up,
            }],
            status: DeviceStatus::Up,
            host_label: Some("pve-a".to_string()),
            host_mgmt_ip: None,
            uplink_interface: Some("eno1".to_string()),
            last_seen: Utc::now(),
        };
        let left = Device {
            id: "device-1".to_string(),
            identity_keys: IdentityKeys {
                chassis_id: None,
                sys_name: Some("host-a".to_string()),
                mgmt_ip: Some("198.51.100.10".to_string()),
            },
            sys_descr: "Linux host".to_string(),
            vendor: "generic".to_string(),
            model: None,
            device_kind: DeviceKind::PhysicalServer,
            interfaces: vec![Interface {
                if_index: 2,
                if_name: "eno1".to_string(),
                ip_addresses: Vec::new(),
                speed_bps: Some(1_000_000_000),
                oper_status: OperStatus::Up,
            }],
            status: DeviceStatus::Up,
            host_label: None,
            host_mgmt_ip: None,
            uplink_interface: None,
            last_seen: Utc::now(),
        };
        let right = Device {
            id: "device-2".to_string(),
            identity_keys: IdentityKeys {
                chassis_id: None,
                sys_name: Some("host-b".to_string()),
                mgmt_ip: Some("198.51.100.11".to_string()),
            },
            sys_descr: "Linux host".to_string(),
            vendor: "generic".to_string(),
            model: None,
            device_kind: DeviceKind::PhysicalServer,
            interfaces: vec![Interface {
                if_index: 3,
                if_name: "eno1".to_string(),
                ip_addresses: Vec::new(),
                speed_bps: Some(1_000_000_000),
                oper_status: OperStatus::Up,
            }],
            status: DeviceStatus::Up,
            host_label: None,
            host_mgmt_ip: None,
            uplink_interface: None,
            last_seen: Utc::now(),
        };

        let topology = Topology {
            devices: HashMap::from([
                (bridge.id.clone(), bridge),
                (left.id.clone(), left),
                (right.id.clone(), right),
            ]),
            links: Vec::new(),
            updated_at: Utc::now(),
        };

        let links = synthesize_proxmox_uplinks(&topology);

        assert!(links.is_empty());
    }
}
