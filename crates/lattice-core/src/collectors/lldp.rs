use std::collections::HashMap;

use anyhow::Result;
use async_trait::async_trait;
use chrono::Utc;

use crate::{
    collectors::{Collector, CollectorContext, GraphPatch, ObservedLink},
    snmp::{
        oids::{
            LLDP_LOC_PORT_ID, LLDP_REM_CHASSIS_ID, LLDP_REM_MGMT_ADDR, LLDP_REM_PORT_DESC,
            LLDP_REM_PORT_ID, LLDP_REM_SYS_DESC, LLDP_REM_SYS_NAME,
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
    async fn is_available(&self, session: &SnmpSession) -> bool {
        session
            .walk(LLDP_REM_SYS_NAME)
            .await
            .map(|rows| !rows.is_empty())
            .unwrap_or(false)
    }

    async fn collect(&self, session: &SnmpSession, ctx: &CollectorContext) -> Result<GraphPatch> {
        let sys_names = table_by_index(session.walk(LLDP_REM_SYS_NAME).await?, LLDP_REM_SYS_NAME);
        let chassis_ids = table_by_index(
            session.walk(LLDP_REM_CHASSIS_ID).await?,
            LLDP_REM_CHASSIS_ID,
        );
        let sys_descs = table_by_index(session.walk(LLDP_REM_SYS_DESC).await?, LLDP_REM_SYS_DESC);
        let mgmt_addrs =
            table_by_index(session.walk(LLDP_REM_MGMT_ADDR).await?, LLDP_REM_MGMT_ADDR);
        let remote_ports = table_by_index(session.walk(LLDP_REM_PORT_ID).await?, LLDP_REM_PORT_ID);
        let remote_port_descs =
            table_by_index(session.walk(LLDP_REM_PORT_DESC).await?, LLDP_REM_PORT_DESC);
        let local_ports = table_by_index(session.walk(LLDP_LOC_PORT_ID).await?, LLDP_LOC_PORT_ID);

        let mut indices = sys_names
            .keys()
            .chain(chassis_ids.keys())
            .chain(sys_descs.keys())
            .chain(mgmt_addrs.keys())
            .chain(remote_ports.keys())
            .chain(remote_port_descs.keys())
            .chain(local_ports.keys())
            .cloned()
            .collect::<Vec<_>>();
        indices.sort();
        indices.dedup();

        let mut devices = Vec::new();
        let mut links = Vec::new();

        for index in indices {
            let identity = IdentityKeys {
                chassis_id: chassis_ids.get(&index).and_then(snmp_value_as_text),
                sys_name: sys_names.get(&index).and_then(snmp_value_as_text),
                mgmt_ip: mgmt_addrs.get(&index).and_then(snmp_value_as_ipv4_text),
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
                interfaces: Vec::new(),
                status: DeviceStatus::Unknown,
                host_label: None,
                host_mgmt_ip: None,
                upstream_interface: None,
                last_seen: Utc::now(),
            });

            let local_interface = local_ports
                .get(&index)
                .and_then(snmp_value_as_text)
                .unwrap_or_else(|| "Unknown".to_string());
            let remote_interface = remote_ports
                .get(&index)
                .and_then(snmp_value_as_text)
                .or_else(|| remote_port_descs.get(&index).and_then(snmp_value_as_text))
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

fn snmp_value_as_ipv4_text(value: &SnmpValue) -> Option<String> {
    value.as_ipv4().map(|ip| ip.to_string())
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
    if lowered.contains("router") || lowered.contains("vyos") {
        DeviceRole::Router
    } else if lowered.contains("proxmox") || lowered.contains("linux") || lowered.contains("server")
    {
        DeviceRole::Server
    } else if lowered.contains("switch") {
        DeviceRole::Switch
    } else {
        DeviceRole::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snmp::SnmpValue;

    #[test]
    fn indexes_are_extracted_from_walk_oids() {
        assert_eq!(
            index_after_prefix("1.0.8802.1.1.2.1.4.1.1.9.42", LLDP_REM_SYS_NAME),
            Some("42")
        );
        assert_eq!(index_after_prefix("1.2.3", LLDP_REM_SYS_NAME), None);
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
    }

    #[test]
    fn text_helpers_accept_empty_values() {
        assert_eq!(snmp_value_as_text(&SnmpValue::Null), None);
        assert_eq!(
            snmp_value_as_ipv4_text(&SnmpValue::IpAddress(std::net::Ipv4Addr::new(192, 0, 2, 1))),
            Some("192.0.2.1".to_string())
        );
    }
}
