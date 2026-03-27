use std::collections::{BTreeSet, HashMap};

use anyhow::Result;
use async_trait::async_trait;

use crate::{
    collectors::{Collector, CollectorContext, GraphPatch},
    graph::{Device, DeviceRole},
    snmp::{
        oids::{IF_DESCR, IF_NAME, IP_CIDR_ROUTE_IF_INDEX, IP_ROUTE_IF_INDEX, SYS_DESCR},
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
        if infer_device_role(&sys_descr) != DeviceRole::Router {
            return Ok(GraphPatch::default());
        }

        let if_names = table_by_index(session.walk(IF_NAME).await?, IF_NAME);
        let if_descrs = table_by_index(session.walk(IF_DESCR).await?, IF_DESCR);

        let upstream_interface =
            match resolve_cidr_default_route(session, &if_names, &if_descrs).await? {
                RouteResolution::Resolved(interface_name) => Some(interface_name),
                RouteResolution::Ambiguous => None,
                RouteResolution::RetryLegacy => {
                    resolve_legacy_default_route(session, &if_names, &if_descrs).await?
                }
            };

        let devices = upstream_interface
            .into_iter()
            .map(|interface_name| Device {
                id: ctx.local_device_id.clone(),
                upstream_interface: Some(interface_name),
                ..Device::empty()
            })
            .collect();

        Ok(GraphPatch {
            devices,
            observed_links: Vec::new(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RouteResolution {
    Resolved(String),
    Ambiguous,
    RetryLegacy,
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
            RouteResolution::Resolved(interface_name) => RouteResolution::Resolved(interface_name),
            RouteResolution::Ambiguous => RouteResolution::Ambiguous,
            RouteResolution::RetryLegacy => RouteResolution::RetryLegacy,
        },
    )
}

async fn resolve_legacy_default_route(
    session: &SnmpSession,
    if_names: &HashMap<String, SnmpValue>,
    if_descrs: &HashMap<String, SnmpValue>,
) -> Result<Option<String>> {
    let rows = match session.walk(IP_ROUTE_IF_INDEX).await {
        Ok(rows) => rows,
        Err(_) => return Ok(None),
    };

    Ok(
        match resolve_default_route_interface(
            &rows,
            IP_ROUTE_IF_INDEX,
            is_default_legacy_route,
            if_names,
            if_descrs,
        ) {
            RouteResolution::Resolved(interface_name) => Some(interface_name),
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
        .filter(|(oid, _)| matcher(index_after_prefix(oid, base).unwrap_or_default()))
        .filter_map(|(_, value)| snmp_value_as_u32(value))
        .filter_map(|if_index| interface_name_for_index(if_index, if_names, if_descrs))
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

fn infer_device_role(sys_descr: &str) -> DeviceRole {
    let lowered = sys_descr.to_ascii_lowercase();
    if lowered.contains("router") || lowered.contains("vyos") {
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
            RouteResolution::Resolved("eth7".to_string())
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
            RouteResolution::Resolved("ge-0/0/3".to_string())
        );
    }
}
