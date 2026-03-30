use std::collections::{HashMap, HashSet};

use anyhow::Result;
use async_trait::async_trait;
use chrono::Utc;

use crate::{
    collectors::{Collector, CollectorContext, GraphPatch},
    snmp::{
        cidr_prefix_len,
        oids::{
            IF_DESCR, IF_HIGH_SPEED, IF_NAME, IF_OPER_STATUS, IF_PHYS_ADDRESS, IP_AD_ENT_ADDR,
            IP_AD_ENT_IF_IDX, IP_AD_ENT_NET_MASK,
        },
        SnmpSession, SnmpValue,
    },
    DeploymentType, Device, DeviceRole, DeviceStatus, IdentityKeys, Interface, OperStatus,
};

#[derive(Debug, Default, Clone)]
pub struct InterfaceCollector;

impl InterfaceCollector {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Collector for InterfaceCollector {
    async fn is_available(&self, session: &SnmpSession) -> bool {
        session
            .walk(IF_NAME)
            .await
            .map(|rows| !rows.is_empty())
            .unwrap_or(false)
    }

    async fn collect(&self, session: &SnmpSession, ctx: &CollectorContext) -> Result<GraphPatch> {
        let if_names = table_by_index(session.walk(IF_NAME).await?, IF_NAME);
        let if_descrs = table_by_index(session.walk(IF_DESCR).await?, IF_DESCR);
        let if_statuses = table_by_index(session.walk(IF_OPER_STATUS).await?, IF_OPER_STATUS);
        let if_speeds = table_by_index(session.walk(IF_HIGH_SPEED).await?, IF_HIGH_SPEED);
        let if_macs = table_by_index(session.walk(IF_PHYS_ADDRESS).await?, IF_PHYS_ADDRESS);
        let ip_addrs = table_by_index(session.walk(IP_AD_ENT_ADDR).await?, IP_AD_ENT_ADDR);
        let ip_if_idxs = table_by_index(session.walk(IP_AD_ENT_IF_IDX).await?, IP_AD_ENT_IF_IDX);
        let ip_masks = table_by_index(session.walk(IP_AD_ENT_NET_MASK).await?, IP_AD_ENT_NET_MASK);

        let mut interfaces_by_index: HashMap<u32, Interface> = HashMap::new();
        let mut indices = HashSet::new();
        indices.extend(if_names.keys().cloned());
        indices.extend(if_descrs.keys().cloned());
        indices.extend(if_statuses.keys().cloned());
        indices.extend(if_speeds.keys().cloned());
        indices.extend(
            ip_if_idxs
                .values()
                .filter_map(snmp_value_as_u32)
                .map(|index| index.to_string()),
        );

        let mut indices = indices.into_iter().collect::<Vec<_>>();
        indices.sort();

        for index_text in indices {
            let if_index = match index_text.parse::<u32>() {
                Ok(value) => value,
                Err(_) => continue,
            };
            let if_name = if_names
                .get(&index_text)
                .and_then(snmp_value_as_text)
                .or_else(|| if_descrs.get(&index_text).and_then(snmp_value_as_text))
                .unwrap_or_else(|| "Unknown".to_string());
            let oper_status = if_statuses
                .get(&index_text)
                .and_then(snmp_value_as_u32)
                .map(oper_status_from_snmp)
                .unwrap_or(OperStatus::Unknown);
            let speed_bps = if_speeds
                .get(&index_text)
                .and_then(snmp_value_as_u32)
                .map(|speed| u64::from(speed) * 1_000_000);

            interfaces_by_index.insert(
                if_index,
                Interface {
                    if_index,
                    if_name,
                    ip_addresses: Vec::new(),
                    speed_bps,
                    oper_status,
                },
            );
        }

        for (ip_index, addr_value) in &ip_addrs {
            let if_index = match ip_if_idxs.get(ip_index).and_then(snmp_value_as_u32) {
                Some(index) => index,
                None => continue,
            };
            let mask = ip_masks
                .get(ip_index)
                .and_then(snmp_value_as_octets)
                .and_then(|mask| cidr_prefix_len(&mask))
                .unwrap_or(32);
            let ip = match snmp_value_as_ipv4(addr_value) {
                Some(ip) => ip,
                None => continue,
            };

            interfaces_by_index
                .entry(if_index)
                .or_insert_with(|| Interface {
                    if_index,
                    if_name: format!("if{if_index}"),
                    ip_addresses: Vec::new(),
                    speed_bps: None,
                    oper_status: OperStatus::Unknown,
                })
                .ip_addresses
                .push(format!("{ip}/{mask}"));
        }

        let mut interfaces = interfaces_by_index.into_values().collect::<Vec<_>>();
        interfaces.sort_by_key(|interface| interface.if_index);
        let mac_addresses = collect_mac_addresses(&if_macs);

        Ok(GraphPatch {
            devices: vec![Device {
                id: ctx.local_device_id.clone(),
                identity_keys: IdentityKeys {
                    mac_addresses,
                    ..IdentityKeys::default()
                },
                sys_descr: String::new(),
                vendor: String::new(),
                model: None,
                device_role: DeviceRole::Unknown,
                deployment_type: DeploymentType::Unknown,
                guest_kind: None,
                interfaces,
                status: DeviceStatus::Unknown,
                host_label: None,
                host_mgmt_ip: None,
                upstream_interface: None,
                last_seen: Utc::now(),
            }],
            observed_links: Vec::new(),
        })
    }
}

fn table_by_index(rows: Vec<(String, SnmpValue)>, base: &str) -> HashMap<String, SnmpValue> {
    rows.into_iter()
        .filter_map(|(oid, value)| {
            index_after_prefix(&oid, base).map(|index| (index.to_string(), value))
        })
        .collect()
}

fn index_after_prefix<'a>(oid: &'a str, base: &str) -> Option<&'a str> {
    oid.strip_prefix(base)
        .and_then(|suffix| suffix.strip_prefix('.'))
}

fn snmp_value_as_text(value: &SnmpValue) -> Option<String> {
    match value {
        SnmpValue::Null => None,
        _ => Some(value.as_text()),
    }
}

fn snmp_value_as_u32(value: &SnmpValue) -> Option<u32> {
    match value {
        SnmpValue::Integer(value) if *value >= 0 => Some(*value as u32),
        SnmpValue::Counter32(value) => Some(*value),
        SnmpValue::Unsigned32(value) => Some(*value),
        SnmpValue::Timeticks(value) => Some(*value),
        _ => None,
    }
}

fn snmp_value_as_octets(value: &SnmpValue) -> Option<Vec<u8>> {
    match value {
        SnmpValue::OctetString(value) => Some(value.clone()),
        SnmpValue::Opaque(value) => Some(value.clone()),
        SnmpValue::IpAddress(value) => Some(value.octets().to_vec()),
        _ => None,
    }
}

fn snmp_value_as_ipv4(value: &SnmpValue) -> Option<std::net::Ipv4Addr> {
    value.as_ipv4()
}

fn collect_mac_addresses(entries: &HashMap<String, SnmpValue>) -> Vec<String> {
    let mut mac_addresses = entries
        .values()
        .filter_map(snmp_value_as_octets)
        .filter_map(|value| normalize_mac_address(&value))
        .collect::<Vec<_>>();
    mac_addresses.sort();
    mac_addresses.dedup();
    mac_addresses
}

fn normalize_mac_address(value: &[u8]) -> Option<String> {
    if value.len() != 6 || value.iter().all(|octet| *octet == 0) {
        return None;
    }

    Some(
        value
            .iter()
            .map(|octet| format!("{octet:02x}"))
            .collect::<Vec<_>>()
            .join(":"),
    )
}

fn oper_status_from_snmp(value: u32) -> OperStatus {
    match value {
        1 => OperStatus::Up,
        2 => OperStatus::Down,
        _ => OperStatus::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oper_status_maps_known_values() {
        assert_eq!(oper_status_from_snmp(1), OperStatus::Up);
        assert_eq!(oper_status_from_snmp(2), OperStatus::Down);
        assert_eq!(oper_status_from_snmp(99), OperStatus::Unknown);
    }

    #[test]
    fn prefix_extraction_requires_matching_base() {
        assert_eq!(
            index_after_prefix("1.3.6.1.2.1.31.1.1.1.1.7", IF_NAME),
            Some("7")
        );
        assert_eq!(index_after_prefix("1.2.3", IF_NAME), None);
    }

    #[test]
    fn normalizes_and_filters_mac_addresses() {
        let entries = HashMap::from([
            (
                "1".to_string(),
                SnmpValue::OctetString(vec![0, 0, 0, 0, 0, 0]),
            ),
            (
                "2".to_string(),
                SnmpValue::OctetString(vec![0, 26, 43, 60, 77, 94]),
            ),
            (
                "3".to_string(),
                SnmpValue::OctetString(vec![0, 26, 43, 60, 77, 94]),
            ),
            ("4".to_string(), SnmpValue::OctetString(vec![])),
        ]);

        assert_eq!(collect_mac_addresses(&entries), vec!["00:1a:2b:3c:4d:5e"]);
    }
}
