use std::{collections::HashMap, net::Ipv4Addr};

use anyhow::Result;
use async_trait::async_trait;
use chrono::Utc;

use crate::{
    collectors::{Collector, CollectorContext, GraphPatch, ObservedLink},
    snmp::{
        oids::{
            IF_DESCR, IF_NAME, LLDP_LOC_PORT_DESC, LLDP_LOC_PORT_ID, LLDP_REM_CHASSIS_ID,
            LLDP_REM_MGMT_ADDR_IF_SUBTYPE, LLDP_REM_PORT_DESC, LLDP_REM_PORT_ID, LLDP_REM_SYS_DESC,
            LLDP_REM_SYS_NAME,
        },
        SnmpSession, SnmpValue,
    },
    DeploymentType, Device, DeviceRole, DeviceStatus, IdentityKeys, LinkProtocol,
};

#[derive(Debug, Default, Clone)]
pub struct LldpCollector;

impl LldpCollector {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Collector for LldpCollector {
    fn name(&self) -> &'static str {
        "lldp"
    }

    async fn is_available(&self, session: &SnmpSession) -> bool {
        session
            .walk(LLDP_REM_SYS_NAME)
            .await
            .map(|rows| !rows.is_empty())
            .unwrap_or(false)
    }

    async fn collect(&self, session: &SnmpSession, ctx: &CollectorContext) -> Result<GraphPatch> {
        let sys_names =
            table_by_remote_index(session.walk(LLDP_REM_SYS_NAME).await?, LLDP_REM_SYS_NAME);
        let chassis_ids = table_by_remote_index(
            session.walk(LLDP_REM_CHASSIS_ID).await?,
            LLDP_REM_CHASSIS_ID,
        );
        let sys_descs =
            table_by_remote_index(session.walk(LLDP_REM_SYS_DESC).await?, LLDP_REM_SYS_DESC);
        let mgmt_addrs = remote_mgmt_addr_by_index(
            session.walk(LLDP_REM_MGMT_ADDR_IF_SUBTYPE).await?,
            LLDP_REM_MGMT_ADDR_IF_SUBTYPE,
        );
        let remote_ports =
            table_by_remote_index(session.walk(LLDP_REM_PORT_ID).await?, LLDP_REM_PORT_ID);
        let remote_port_descs =
            table_by_remote_index(session.walk(LLDP_REM_PORT_DESC).await?, LLDP_REM_PORT_DESC);
        let local_port_descs =
            table_by_local_index(session.walk(LLDP_LOC_PORT_DESC).await?, LLDP_LOC_PORT_DESC);
        let local_ports =
            table_by_local_index(session.walk(LLDP_LOC_PORT_ID).await?, LLDP_LOC_PORT_ID);
        let if_names = table_by_local_index(session.walk(IF_NAME).await?, IF_NAME);
        let if_descrs = table_by_local_index(session.walk(IF_DESCR).await?, IF_DESCR);

        let mut indices = sys_names
            .keys()
            .chain(chassis_ids.keys())
            .chain(sys_descs.keys())
            .chain(mgmt_addrs.keys())
            .chain(remote_ports.keys())
            .chain(remote_port_descs.keys())
            .cloned()
            .collect::<Vec<_>>();
        indices.sort();
        indices.dedup();

        let mut devices = Vec::new();
        let mut links = Vec::new();

        for index in indices {
            let identity = IdentityKeys {
                chassis_id: chassis_ids.get(&index).and_then(snmp_value_as_chassis_id),
                sys_name: sys_names.get(&index).and_then(snmp_value_as_text),
                mgmt_ip: mgmt_addrs.get(&index).cloned(),
                mac_addresses: Vec::new(),
            };
            let sys_descr = sys_descs
                .get(&index)
                .and_then(snmp_value_as_text)
                .unwrap_or_default();
            let device_role = infer_device_role(identity.sys_name.as_deref(), Some(&sys_descr));

            devices.push(Device {
                id: String::new(),
                identity_keys: identity.clone(),
                sys_descr: sys_descr.clone(),
                vendor: identity
                    .sys_name
                    .as_deref()
                    .map(|name| {
                        name.split_whitespace()
                            .next()
                            .unwrap_or("unknown")
                            .to_string()
                    })
                    .unwrap_or_else(|| "unknown".to_string()),
                model: None,
                device_role,
                deployment_type: DeploymentType::Unknown,
                guest_kind: None,
                interfaces: Vec::new(),
                status: DeviceStatus::Unknown,
                host_label: None,
                host_mgmt_ip: None,
                upstream_interface: None,
                last_seen: Utc::now(),
            });

            let local_interface = if_names
                .get(&index.local_port_num)
                .and_then(snmp_value_as_text)
                .or_else(|| {
                    if_descrs
                        .get(&index.local_port_num)
                        .and_then(snmp_value_as_text)
                })
                .or_else(|| {
                    local_port_descs
                        .get(&index.local_port_num)
                        .and_then(snmp_value_as_text)
                })
                .or_else(|| {
                    local_ports
                        .get(&index.local_port_num)
                        .and_then(snmp_value_as_text)
                })
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "Unknown".to_string());
            let remote_interface = remote_port_descs
                .get(&index)
                .and_then(snmp_value_as_text)
                .or_else(|| remote_ports.get(&index).and_then(snmp_value_as_text))
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "Unknown".to_string());

            links.push(ObservedLink {
                local_device_id: ctx.local_device_id.clone(),
                local_interface,
                remote_identity: identity,
                remote_interface,
                remote_sys_descr: sys_descs.get(&index).and_then(snmp_value_as_text),
                speed_bps: None,
                protocol: LinkProtocol::Lldp,
            });
        }

        Ok(GraphPatch {
            devices,
            observed_links: links,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct RemoteIndex {
    local_port_num: u32,
    rem_index: u32,
    time_mark: u32,
}

fn table_by_remote_index(
    rows: Vec<(String, SnmpValue)>,
    base: &str,
) -> HashMap<RemoteIndex, SnmpValue> {
    rows.into_iter()
        .filter_map(|(oid, value)| {
            remote_index_after_prefix(&oid, base).map(|index| (index, value))
        })
        .collect()
}

fn table_by_local_index(rows: Vec<(String, SnmpValue)>, base: &str) -> HashMap<u32, SnmpValue> {
    rows.into_iter()
        .filter_map(|(oid, value)| local_index_after_prefix(&oid, base).map(|index| (index, value)))
        .collect()
}

fn remote_mgmt_addr_by_index(
    rows: Vec<(String, SnmpValue)>,
    base: &str,
) -> HashMap<RemoteIndex, String> {
    rows.into_iter()
        .filter_map(|(oid, _value)| remote_mgmt_addr_after_prefix(&oid, base))
        .collect()
}

fn remote_index_after_prefix(oid: &str, base: &str) -> Option<RemoteIndex> {
    let suffix = index_after_prefix(oid, base)?;
    let mut parts = suffix
        .split('.')
        .filter(|part| !part.is_empty())
        .map(|part| part.parse::<u32>().ok());

    Some(RemoteIndex {
        time_mark: parts.next()??,
        local_port_num: parts.next()??,
        rem_index: parts.next()??,
    })
}

fn remote_mgmt_addr_after_prefix(oid: &str, base: &str) -> Option<(RemoteIndex, String)> {
    let suffix = index_after_prefix(oid, base)?;
    let parts = suffix
        .split('.')
        .filter(|part| !part.is_empty())
        .map(|part| part.parse::<u32>().ok())
        .collect::<Option<Vec<_>>>()?;

    if parts.len() < 5 {
        return None;
    }

    let index = RemoteIndex {
        time_mark: parts[0],
        local_port_num: parts[1],
        rem_index: parts[2],
    };
    let subtype = parts[3];
    let addr_len = usize::try_from(parts[4]).ok()?;
    let addr_end = 5usize.checked_add(addr_len)?;
    if subtype != 1 || addr_len != 4 || parts.len() < addr_end {
        return None;
    }

    let octets = [
        u8::try_from(parts[5]).ok()?,
        u8::try_from(parts[6]).ok()?,
        u8::try_from(parts[7]).ok()?,
        u8::try_from(parts[8]).ok()?,
    ];

    Some((index, Ipv4Addr::from(octets).to_string()))
}

fn local_index_after_prefix(oid: &str, base: &str) -> Option<u32> {
    index_after_prefix(oid, base)?
        .split('.')
        .find(|part| !part.is_empty())?
        .parse()
        .ok()
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

fn snmp_value_as_chassis_id(value: &SnmpValue) -> Option<String> {
    match value {
        SnmpValue::Null => None,
        SnmpValue::OctetString(bytes) => {
            if bytes.is_empty() {
                return None;
            }

            if bytes
                .iter()
                .all(|byte| byte.is_ascii_graphic() || *byte == b' ')
            {
                return String::from_utf8(bytes.clone())
                    .ok()
                    .filter(|text| !text.trim().is_empty());
            }

            Some(
                bytes
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<Vec<_>>()
                    .join(":"),
            )
        }
        _ => snmp_value_as_text(value),
    }
}

fn infer_device_role(sys_name: Option<&str>, sys_descr: Option<&str>) -> DeviceRole {
    let mut combined = String::new();
    if let Some(value) = sys_name {
        combined.push_str(value);
        combined.push(' ');
    }
    if let Some(value) = sys_descr {
        combined.push_str(value);
    }

    let lowered = combined.to_lowercase();
    if contains_any(
        &lowered,
        &[
            "router",
            "gateway",
            "firewall",
            "vyos",
            "junos",
            "routeros",
            "edgeos",
            "fortios",
            "pfsense",
            "opnsense",
            "internetwork",
            "ix series",
            "rtx",
        ],
    ) {
        DeviceRole::Router
    } else if lowered.contains("switch") {
        DeviceRole::Switch
    } else if lowered.contains("proxmox") || lowered.contains("linux") || lowered.contains("server")
    {
        DeviceRole::Server
    } else {
        DeviceRole::Unknown
    }
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snmp::{oids::LLDP_REM_MGMT_ADDR, SnmpValue};

    #[test]
    fn remote_indexes_are_extracted_from_walk_oids() {
        assert_eq!(
            remote_index_after_prefix("1.0.8802.1.1.2.1.4.1.1.9.0.7.42", LLDP_REM_SYS_NAME),
            Some(RemoteIndex {
                time_mark: 0,
                local_port_num: 7,
                rem_index: 42,
            })
        );
        assert_eq!(remote_index_after_prefix("1.2.3", LLDP_REM_SYS_NAME), None);
        assert_eq!(
            remote_index_after_prefix(
                "1.0.8802.1.1.2.1.4.2.1.2.0.7.42.1.4.172.31.10.42",
                LLDP_REM_MGMT_ADDR
            ),
            Some(RemoteIndex {
                time_mark: 0,
                local_port_num: 7,
                rem_index: 42,
            })
        );
    }

    #[test]
    fn remote_management_address_is_extracted_from_index_suffix() {
        assert_eq!(
            remote_mgmt_addr_after_prefix(
                "1.0.8802.1.1.2.1.4.2.1.3.200.62.1.1.4.172.31.13.19",
                LLDP_REM_MGMT_ADDR_IF_SUBTYPE
            ),
            Some((
                RemoteIndex {
                    time_mark: 200,
                    local_port_num: 62,
                    rem_index: 1,
                },
                "172.31.13.19".to_string(),
            ))
        );
        assert_eq!(
            remote_mgmt_addr_after_prefix(
                "1.0.8802.1.1.2.1.4.2.1.3.200.62.1.2.16.32.1.13.184.0.0.0.0.0.0.0.0.0.0.0.1",
                LLDP_REM_MGMT_ADDR_IF_SUBTYPE
            ),
            None
        );
    }

    #[test]
    fn local_indexes_are_extracted_from_walk_oids() {
        assert_eq!(
            local_index_after_prefix("1.3.6.1.2.1.31.1.1.1.1.7", IF_NAME),
            Some(7)
        );
        assert_eq!(local_index_after_prefix("1.2.3", IF_NAME), None);
    }

    #[test]
    fn device_role_defaults_to_unknown_when_no_keywords_are_present() {
        assert_eq!(
            infer_device_role(Some("core"), Some("edge"),),
            DeviceRole::Unknown
        );
        assert_eq!(
            infer_device_role(Some("vyos"), Some("router os")),
            DeviceRole::Router
        );
        assert_eq!(
            infer_device_role(Some("Router"), Some("NEC Portable Internetwork Core OS")),
            DeviceRole::Router
        );
        assert_eq!(
            infer_device_role(Some("dist-switch-a"), Some("Linux dist-switch-a")),
            DeviceRole::Switch
        );
    }

    #[test]
    fn text_helpers_accept_empty_values() {
        assert_eq!(snmp_value_as_text(&SnmpValue::Null), None);
        assert_eq!(
            SnmpValue::IpAddress(std::net::Ipv4Addr::new(192, 0, 2, 1))
                .as_ipv4()
                .map(|ip| ip.to_string()),
            Some("192.0.2.1".to_string())
        );
    }

    #[test]
    fn chassis_id_helper_preserves_binary_identity() {
        assert_eq!(
            snmp_value_as_chassis_id(&SnmpValue::OctetString(vec![0x02, 0xf7, 0x44, 0x0b])),
            Some("02:f7:44:0b".to_string())
        );
        assert_eq!(
            snmp_value_as_chassis_id(&SnmpValue::OctetString(b"branch-router-2".to_vec())),
            Some("branch-router-2".to_string())
        );
    }
}
