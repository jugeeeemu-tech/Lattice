use std::collections::{BTreeSet, HashMap};

use anyhow::Result;
use async_trait::async_trait;

use crate::{
    collectors::{Collector, CollectorContext, GraphPatch},
    graph::{Device, DeviceRole},
    snmp::{
        oids::{
            IF_DESCR, IF_NAME, IP_AD_ENT_ADDR, IP_AD_ENT_IF_IDX, IP_CIDR_ROUTE_IF_INDEX,
            IP_ROUTE_IF_INDEX, IP_ROUTE_NEXT_HOP, SYS_DESCR, SYS_NAME,
        },
        SnmpSession, SnmpValue,
    },
};

#[derive(Debug, Default, Clone)]
pub struct RouteCollector;

impl RouteCollector {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Collector for RouteCollector {
    fn name(&self) -> &'static str {
        "routes"
    }

    async fn is_available(&self, session: &SnmpSession) -> bool {
        session
            .bulk_walk(IP_CIDR_ROUTE_IF_INDEX)
            .await
            .map(|rows| !rows.is_empty())
            .unwrap_or(false)
            || session
                .walk(IP_ROUTE_IF_INDEX)
                .await
                .map(|rows| !rows.is_empty())
                .unwrap_or(false)
    }

    async fn collect(&self, session: &SnmpSession, ctx: &CollectorContext) -> Result<GraphPatch> {
        let sys_descr = session
            .get(SYS_DESCR)
            .await
            .map(|value| value.as_text())
            .unwrap_or_default();
        let sys_name = session
            .get(SYS_NAME)
            .await
            .ok()
            .map(|value| value.as_text())
            .filter(|value| !value.is_empty());

        let if_names = table_by_index(session.walk(IF_NAME).await?, IF_NAME);
        let if_descrs = table_by_index(session.walk(IF_DESCR).await?, IF_DESCR);
        let ip_addrs = table_by_index(session.walk(IP_AD_ENT_ADDR).await?, IP_AD_ENT_ADDR);
        let ip_if_idxs = table_by_index(session.walk(IP_AD_ENT_IF_IDX).await?, IP_AD_ENT_IF_IDX);

        let default_route = match resolve_cidr_default_route(session, &if_names, &if_descrs).await?
        {
            RouteResolution::Resolved(route) => Some(route),
            RouteResolution::Ambiguous => None,
            RouteResolution::RetryLegacy => {
                resolve_legacy_default_route(session, &if_names, &if_descrs).await?
            }
        };
        let upstream_interface = default_route
            .as_ref()
            .map(|route| route.interface_name.clone());
        let routed_interfaces =
            routed_interface_names(&ip_addrs, &ip_if_idxs, &if_names, &if_descrs);
        let inferred_role = infer_device_role(sys_name.as_deref(), Some(&sys_descr));
        let route_role_signal = upstream_interface.is_some() && routed_interfaces.len() >= 2;
        let device_role = infer_route_device_role(inferred_role, route_role_signal);

        let devices = vec![Device {
            id: ctx.local_device_id.clone(),
            device_role,
            default_gateway_ip: default_route.and_then(|route| route.gateway_ip),
            upstream_interface,
            ..Device::empty()
        }];

        Ok(GraphPatch {
            devices,
            observed_links: Vec::new(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RouteResolution {
    Resolved(DefaultRoute),
    Ambiguous,
    RetryLegacy,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct DefaultRoute {
    interface_name: String,
    gateway_ip: Option<String>,
}

async fn resolve_cidr_default_route(
    session: &SnmpSession,
    if_names: &HashMap<String, SnmpValue>,
    if_descrs: &HashMap<String, SnmpValue>,
) -> Result<RouteResolution> {
    let rows = match session.bulk_walk(IP_CIDR_ROUTE_IF_INDEX).await {
        Ok(rows) => rows,
        Err(_) => return Ok(RouteResolution::RetryLegacy),
    };

    Ok(
        match resolve_default_route_interface(
            &rows,
            IP_CIDR_ROUTE_IF_INDEX,
            is_default_cidr_route,
            if_names,
            if_descrs,
        ) {
            RouteResolution::Resolved(route) => RouteResolution::Resolved(route),
            RouteResolution::Ambiguous => RouteResolution::Ambiguous,
            RouteResolution::RetryLegacy => RouteResolution::RetryLegacy,
        },
    )
}

async fn resolve_legacy_default_route(
    session: &SnmpSession,
    if_names: &HashMap<String, SnmpValue>,
    if_descrs: &HashMap<String, SnmpValue>,
) -> Result<Option<DefaultRoute>> {
    let rows = match session.walk(IP_ROUTE_IF_INDEX).await {
        Ok(rows) => rows,
        Err(_) => return Ok(None),
    };
    let next_hop_rows = match session.walk(IP_ROUTE_NEXT_HOP).await {
        Ok(rows) => rows,
        Err(_) => Vec::new(),
    };
    let next_hop_by_suffix = table_by_index(next_hop_rows, IP_ROUTE_NEXT_HOP);

    Ok(
        match resolve_default_route_interface(
            &rows,
            IP_ROUTE_IF_INDEX,
            is_default_legacy_route,
            if_names,
            if_descrs,
        ) {
            RouteResolution::Resolved(route) => Some(DefaultRoute {
                gateway_ip: next_hop_by_suffix
                    .get("0.0.0.0")
                    .and_then(snmp_value_as_ipv4_string)
                    .filter(|value| value != "0.0.0.0"),
                ..route
            }),
            RouteResolution::Ambiguous | RouteResolution::RetryLegacy => None,
        },
    )
}

fn resolve_default_route_interface(
    rows: &[(String, SnmpValue)],
    base: &str,
    matcher: fn(&str) -> bool,
    if_names: &HashMap<String, SnmpValue>,
    if_descrs: &HashMap<String, SnmpValue>,
) -> RouteResolution {
    let candidates = rows
        .iter()
        .filter_map(|(oid, value)| {
            let suffix = index_after_prefix(oid, base)?;
            matcher(suffix).then_some((suffix, value))
        })
        .filter_map(|(suffix, value)| {
            let if_index = snmp_value_as_u32(value)?;
            let interface_name = interface_name_for_index(if_index, if_names, if_descrs)?;
            Some(DefaultRoute {
                interface_name,
                gateway_ip: cidr_default_route_next_hop(suffix),
            })
        })
        .collect::<BTreeSet<_>>();

    match candidates.len() {
        1 => RouteResolution::Resolved(
            candidates
                .into_iter()
                .next()
                .expect("unique candidate exists"),
        ),
        0 => RouteResolution::RetryLegacy,
        _ => RouteResolution::Ambiguous,
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

fn snmp_value_as_ipv4_string(value: &SnmpValue) -> Option<String> {
    value.as_ipv4().map(|value| value.to_string())
}

fn interface_name_for_index(
    if_index: u32,
    if_names: &HashMap<String, SnmpValue>,
    if_descrs: &HashMap<String, SnmpValue>,
) -> Option<String> {
    let key = if_index.to_string();
    if_names
        .get(&key)
        .and_then(snmp_value_as_text)
        .or_else(|| if_descrs.get(&key).and_then(snmp_value_as_text))
        .filter(|value| !value.trim().is_empty())
}

fn routed_interface_names(
    ip_addrs: &HashMap<String, SnmpValue>,
    ip_if_idxs: &HashMap<String, SnmpValue>,
    if_names: &HashMap<String, SnmpValue>,
    if_descrs: &HashMap<String, SnmpValue>,
) -> BTreeSet<String> {
    ip_addrs
        .keys()
        .filter_map(|index| ip_if_idxs.get(index).and_then(snmp_value_as_u32))
        .filter_map(|if_index| interface_name_for_index(if_index, if_names, if_descrs))
        .filter(|name| !is_non_routed_interface(name))
        .collect()
}

fn is_non_routed_interface(interface_name: &str) -> bool {
    let lowered = interface_name.to_ascii_lowercase();
    lowered.starts_with("lo") || lowered.starts_with("loopback") || lowered.starts_with("null")
}

fn is_default_cidr_route(suffix: &str) -> bool {
    suffix_components(suffix)
        .map(|parts| parts.len() >= 8 && parts.iter().take(8).all(|value| *value == 0))
        .unwrap_or(false)
}

fn is_default_legacy_route(suffix: &str) -> bool {
    suffix_components(suffix)
        .map(|parts| parts.len() >= 4 && parts.iter().take(4).all(|value| *value == 0))
        .unwrap_or(false)
}

fn suffix_components(value: &str) -> Option<Vec<u32>> {
    let mut parts = Vec::new();
    for part in value.split('.') {
        if part.is_empty() {
            continue;
        }
        parts.push(part.parse().ok()?);
    }
    Some(parts)
}

fn cidr_default_route_next_hop(suffix: &str) -> Option<String> {
    let parts = suffix_components(suffix)?;
    if parts.len() < 12 {
        return None;
    }
    let next_hop = parts[parts.len().saturating_sub(4)..]
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>();
    let value = next_hop.join(".");
    (value != "0.0.0.0").then_some(value)
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

    let lowered = combined.to_ascii_lowercase();
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

fn infer_route_device_role(inferred_role: DeviceRole, route_role_signal: bool) -> DeviceRole {
    match inferred_role {
        DeviceRole::Router => DeviceRole::Router,
        DeviceRole::Switch | DeviceRole::Server | DeviceRole::Bridge => inferred_role,
        DeviceRole::Unknown => {
            if route_role_signal {
                DeviceRole::Router
            } else {
                DeviceRole::Unknown
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_unique_cidr_default_route_interface() {
        let rows = vec![
            (
                format!("{IP_CIDR_ROUTE_IF_INDEX}.0.0.0.0.0.0.0.0.0.192.0.2.1"),
                SnmpValue::Integer(7),
            ),
            (
                format!("{IP_CIDR_ROUTE_IF_INDEX}.198.51.100.0.255.255.255.0.0.192.0.2.2"),
                SnmpValue::Integer(8),
            ),
        ];
        let if_names = HashMap::from([
            ("7".to_string(), SnmpValue::OctetString(b"eth7".to_vec())),
            ("8".to_string(), SnmpValue::OctetString(b"eth8".to_vec())),
        ]);

        assert_eq!(
            resolve_default_route_interface(
                &rows,
                IP_CIDR_ROUTE_IF_INDEX,
                is_default_cidr_route,
                &if_names,
                &HashMap::new(),
            ),
            RouteResolution::Resolved(DefaultRoute {
                interface_name: "eth7".to_string(),
                gateway_ip: Some("192.0.2.1".to_string()),
            })
        );
    }

    #[test]
    fn leaves_ambiguous_default_route_unset() {
        let rows = vec![
            (
                format!("{IP_CIDR_ROUTE_IF_INDEX}.0.0.0.0.0.0.0.0.0.192.0.2.1"),
                SnmpValue::Integer(7),
            ),
            (
                format!("{IP_CIDR_ROUTE_IF_INDEX}.0.0.0.0.0.0.0.0.0.192.0.2.2"),
                SnmpValue::Integer(8),
            ),
        ];
        let if_names = HashMap::from([
            ("7".to_string(), SnmpValue::OctetString(b"eth7".to_vec())),
            ("8".to_string(), SnmpValue::OctetString(b"eth8".to_vec())),
        ]);

        assert_eq!(
            resolve_default_route_interface(
                &rows,
                IP_CIDR_ROUTE_IF_INDEX,
                is_default_cidr_route,
                &if_names,
                &HashMap::new(),
            ),
            RouteResolution::Ambiguous
        );
    }

    #[test]
    fn detects_legacy_default_route_index() {
        let rows = vec![
            (
                format!("{IP_ROUTE_IF_INDEX}.0.0.0.0"),
                SnmpValue::Integer(3),
            ),
            (
                format!("{IP_ROUTE_IF_INDEX}.198.51.100.0"),
                SnmpValue::Integer(4),
            ),
        ];
        let if_names = HashMap::from([(
            "3".to_string(),
            SnmpValue::OctetString(b"ge-0/0/3".to_vec()),
        )]);

        assert_eq!(
            resolve_default_route_interface(
                &rows,
                IP_ROUTE_IF_INDEX,
                is_default_legacy_route,
                &if_names,
                &HashMap::new(),
            ),
            RouteResolution::Resolved(DefaultRoute {
                interface_name: "ge-0/0/3".to_string(),
                gateway_ip: None,
            })
        );
    }

    #[test]
    fn parses_cidr_default_route_next_hop_from_index_suffix() {
        assert_eq!(
            cidr_default_route_next_hop("0.0.0.0.0.0.0.0.0.203.0.113.1"),
            Some("203.0.113.1".to_string())
        );
    }

    #[test]
    fn infers_router_from_generic_router_naming_and_platform_text() {
        assert_eq!(
            infer_device_role(
                Some("Router"),
                Some("NEC Portable Internetwork Core Operating System Software")
            ),
            DeviceRole::Router
        );
    }

    #[test]
    fn keeps_loopback_and_null_interfaces_out_of_routed_interface_signal() {
        let ip_addrs = HashMap::from([
            (
                "192.168.1.1".to_string(),
                SnmpValue::IpAddress(std::net::Ipv4Addr::new(192, 168, 1, 1)),
            ),
            (
                "192.168.10.2".to_string(),
                SnmpValue::IpAddress(std::net::Ipv4Addr::new(192, 168, 10, 2)),
            ),
            (
                "127.0.0.1".to_string(),
                SnmpValue::IpAddress(std::net::Ipv4Addr::new(127, 0, 0, 1)),
            ),
        ]);
        let ip_if_idxs = HashMap::from([
            ("192.168.1.1".to_string(), SnmpValue::Integer(646)),
            ("192.168.10.2".to_string(), SnmpValue::Integer(644)),
            ("127.0.0.1".to_string(), SnmpValue::Integer(949)),
        ]);
        let if_names = HashMap::from([
            (
                "644".to_string(),
                SnmpValue::OctetString(b"GigaEthernet0.0".to_vec()),
            ),
            (
                "646".to_string(),
                SnmpValue::OctetString(b"GigaEthernet2.0".to_vec()),
            ),
            (
                "949".to_string(),
                SnmpValue::OctetString(b"Loopback0.0".to_vec()),
            ),
        ]);

        assert_eq!(
            routed_interface_names(&ip_addrs, &ip_if_idxs, &if_names, &HashMap::new()),
            BTreeSet::from(["GigaEthernet0.0".to_string(), "GigaEthernet2.0".to_string(),])
        );
    }

    #[test]
    fn route_signal_only_promotes_unknown_devices_to_router() {
        assert_eq!(
            infer_route_device_role(DeviceRole::Unknown, true),
            DeviceRole::Router
        );
        assert_eq!(
            infer_route_device_role(DeviceRole::Switch, true),
            DeviceRole::Switch
        );
        assert_eq!(
            infer_route_device_role(DeviceRole::Server, true),
            DeviceRole::Server
        );
    }
}
