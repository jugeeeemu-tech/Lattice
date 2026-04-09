use crate::{
    config::{TopologyHintEndpoint, TopologyHintsConfig},
    graph::{Link, LinkProtocol, Topology},
    GraphStore,
};

pub fn attach_topology_hints(topology: &mut Topology, hints: &TopologyHintsConfig) {
    if hints.links.is_empty() {
        return;
    }

    let mut store = GraphStore::default();
    store.absorb_topology(topology);

    for hint in &hints.links {
        if hint.endpoints.len() != 2 {
            continue;
        }

        let Some(left) = resolve_endpoint(topology, &hint.endpoints[0]) else {
            continue;
        };
        let Some(right) = resolve_endpoint(topology, &hint.endpoints[1]) else {
            continue;
        };

        if has_equivalent_link(topology, &left.0, &left.1, &right.0, &right.1) {
            continue;
        }

        store.upsert_link(Link {
            id: String::new(),
            local_device_id: left.0,
            local_interface: left.1,
            local_ip: None,
            remote_device_id: right.0,
            remote_interface: right.1,
            remote_ip: None,
            speed_bps: None,
            protocol: LinkProtocol::TopologyHint,
            guest_attachment: None,
        });
    }

    *topology = store.topology();
}

fn resolve_endpoint(
    topology: &Topology,
    endpoint: &TopologyHintEndpoint,
) -> Option<(String, String)> {
    let candidate_ids = topology
        .devices
        .values()
        .filter(|device| endpoint_matches_device(device, endpoint))
        .map(|device| device.id.clone())
        .collect::<Vec<_>>();

    if candidate_ids.len() != 1 {
        return None;
    }

    let device = topology.devices.get(&candidate_ids[0])?;
    let interface = resolve_interface_name(device, endpoint)?;
    Some((device.id.clone(), interface))
}

fn endpoint_matches_device(
    device: &crate::Device,
    endpoint: &TopologyHintEndpoint,
) -> bool {
    let device_name = endpoint.device.trim();
    if device_name.is_empty() {
        return false;
    }

    let matches_device_name = device.id == device_name
        || device.identity_keys.sys_name.as_deref() == Some(device_name)
        || device.host_label.as_deref() == Some(device_name)
        || device.label() == device_name;

    if !matches_device_name {
        return false;
    }

    endpoint
        .sys_descr_contains
        .as_ref()
        .map(|needle| {
            device
                .sys_descr
                .to_ascii_lowercase()
                .contains(&needle.to_ascii_lowercase())
        })
        .unwrap_or(true)
}

fn resolve_interface_name(
    device: &crate::Device,
    endpoint: &TopologyHintEndpoint,
) -> Option<String> {
    match (&endpoint.interface, &endpoint.interface_pattern) {
        (Some(interface), _) => device
            .interfaces
            .iter()
            .find(|candidate| interface_matches_exact(&candidate.if_name, interface))
            .map(|candidate| candidate.if_name.clone()),
        (None, Some(pattern)) => {
            let matches = device
                .interfaces
                .iter()
                .filter(|candidate| interface_matches_pattern(&candidate.if_name, pattern))
                .map(|candidate| candidate.if_name.clone())
                .collect::<Vec<_>>();
            if matches.len() == 1 {
                matches.into_iter().next()
            } else {
                None
            }
        }
        (None, None) => device
            .upstream_interface
            .clone()
            .or_else(|| device.interfaces.first().map(|interface| interface.if_name.clone())),
    }
}

fn has_equivalent_link(
    topology: &Topology,
    left_device_id: &str,
    left_interface: &str,
    right_device_id: &str,
    right_interface: &str,
) -> bool {
    topology.links.iter().any(|link| {
        (link.local_device_id == left_device_id
            && link.local_interface == left_interface
            && link.remote_device_id == right_device_id
            && link.remote_interface == right_interface)
            || (link.local_device_id == right_device_id
                && link.local_interface == right_interface
                && link.remote_device_id == left_device_id
                && link.remote_interface == left_interface)
    })
}

fn interface_matches_exact(actual: &str, expected: &str) -> bool {
    normalize_interface_name(actual) == normalize_interface_name(expected)
}

fn interface_matches_pattern(actual: &str, pattern: &str) -> bool {
    wildcard_matches(
        &normalize_interface_name(pattern),
        &normalize_interface_name(actual),
    )
}

fn normalize_interface_name(value: &str) -> String {
    value.to_ascii_lowercase()
        .replace(' ', "")
        .replace("gigabitethernet", "ge")
        .replace("gigaethernet", "ge")
}

fn wildcard_matches(pattern: &str, candidate: &str) -> bool {
    if pattern.is_empty() {
        return candidate.is_empty();
    }

    let pattern_chars: Vec<char> = pattern.chars().collect();
    let candidate_chars: Vec<char> = candidate.chars().collect();
    let (mut pattern_index, mut candidate_index) = (0usize, 0usize);
    let mut star_index: Option<usize> = None;
    let mut star_match_index = 0usize;

    while candidate_index < candidate_chars.len() {
        if pattern_index < pattern_chars.len()
            && (pattern_chars[pattern_index] == candidate_chars[candidate_index]
                || pattern_chars[pattern_index] == '?')
        {
            pattern_index += 1;
            candidate_index += 1;
        } else if pattern_index < pattern_chars.len() && pattern_chars[pattern_index] == '*' {
            star_index = Some(pattern_index);
            pattern_index += 1;
            star_match_index = candidate_index;
        } else if let Some(saved_star_index) = star_index {
            pattern_index = saved_star_index + 1;
            star_match_index += 1;
            candidate_index = star_match_index;
        } else {
            return false;
        }
    }

    while pattern_index < pattern_chars.len() && pattern_chars[pattern_index] == '*' {
        pattern_index += 1;
    }

    pattern_index == pattern_chars.len()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use chrono::Utc;

    use crate::{
        config::{TopologyHintEndpoint, TopologyHintLink, TopologyHintsConfig},
        Device, DeviceRole, DeviceStatus, IdentityKeys, Interface, LinkProtocol, OperStatus,
        Topology,
    };

    use super::attach_topology_hints;

    fn device(
        id: &str,
        sys_name: &str,
        sys_descr: &str,
        interfaces: &[&str],
        upstream_interface: Option<&str>,
    ) -> Device {
        Device {
            id: id.to_string(),
            identity_keys: IdentityKeys {
                chassis_id: None,
                sys_name: Some(sys_name.to_string()),
                mgmt_ip: None,
                mac_addresses: Vec::new(),
            },
            sys_descr: sys_descr.to_string(),
            vendor: "test".to_string(),
            model: None,
            device_role: DeviceRole::Unknown,
            deployment_type: crate::DeploymentType::Physical,
            guest_kind: None,
            interfaces: interfaces
                .iter()
                .enumerate()
                .map(|(index, if_name)| Interface {
                    if_index: index as u32,
                    if_name: (*if_name).to_string(),
                    ip_addresses: Vec::new(),
                    speed_bps: None,
                    oper_status: OperStatus::Up,
                })
                .collect(),
            status: DeviceStatus::Up,
            host_label: None,
            host_mgmt_ip: None,
            upstream_interface: upstream_interface.map(|value| value.to_string()),
            last_seen: Utc::now(),
        }
    }

    #[test]
    fn attaches_topology_hint_link_using_interface_pattern() {
        let mut topology = Topology {
            devices: HashMap::from([
                (
                    "router-1".to_string(),
                    device(
                        "router-1",
                        "Router",
                        "NEC IX2215",
                        &["GigaEthernet0.0", "GigaEthernet2.0"],
                        None,
                    ),
                ),
                (
                    "bridge-1".to_string(),
                    device("bridge-1", "vmbr0", "Proxmox bridge vmbr0", &["vmbr0", "enp3s0"], None),
                ),
            ]),
            links: Vec::new(),
            updated_at: Utc::now(),
        };

        attach_topology_hints(
            &mut topology,
            &TopologyHintsConfig {
                links: vec![TopologyHintLink {
                    endpoints: vec![
                        TopologyHintEndpoint {
                            device: "Router".to_string(),
                            interface: None,
                            interface_pattern: Some("GE2.*".to_string()),
                            sys_descr_contains: Some("IX2215".to_string()),
                        },
                        TopologyHintEndpoint {
                            device: "vmbr0".to_string(),
                            interface: Some("enp3s0".to_string()),
                            interface_pattern: None,
                            sys_descr_contains: None,
                        },
                    ],
                }],
            },
        );

        assert_eq!(topology.links.len(), 1);
        let link = &topology.links[0];
        assert_eq!(link.protocol, LinkProtocol::TopologyHint);
        let interfaces = [link.local_interface.as_str(), link.remote_interface.as_str()];
        assert!(interfaces.contains(&"GigaEthernet2.0"));
        assert!(interfaces.contains(&"enp3s0"));
    }

    #[test]
    fn skips_hint_when_equivalent_link_already_exists() {
        let mut topology = Topology {
            devices: HashMap::from([
                (
                    "router-1".to_string(),
                    device(
                        "router-1",
                        "Router",
                        "NEC IX2215",
                        &["GigaEthernet2.0"],
                        None,
                    ),
                ),
                (
                    "bridge-1".to_string(),
                    device("bridge-1", "vmbr0", "Proxmox bridge vmbr0", &["enp3s0"], None),
                ),
            ]),
            links: vec![crate::Link {
                id: "existing".to_string(),
                local_device_id: "router-1".to_string(),
                local_interface: "GigaEthernet2.0".to_string(),
                local_ip: None,
                remote_device_id: "bridge-1".to_string(),
                remote_interface: "enp3s0".to_string(),
                remote_ip: None,
                speed_bps: None,
                protocol: LinkProtocol::Lldp,
                guest_attachment: None,
            }],
            updated_at: Utc::now(),
        };

        attach_topology_hints(
            &mut topology,
            &TopologyHintsConfig {
                links: vec![TopologyHintLink {
                    endpoints: vec![
                        TopologyHintEndpoint {
                            device: "Router".to_string(),
                            interface: None,
                            interface_pattern: Some("GE2.*".to_string()),
                            sys_descr_contains: Some("IX2215".to_string()),
                        },
                        TopologyHintEndpoint {
                            device: "vmbr0".to_string(),
                            interface: Some("enp3s0".to_string()),
                            interface_pattern: None,
                            sys_descr_contains: None,
                        },
                    ],
                }],
            },
        );

        assert_eq!(topology.links.len(), 1);
        assert_eq!(topology.links[0].protocol, LinkProtocol::Lldp);
    }
}
