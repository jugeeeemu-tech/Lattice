use std::{cmp::Ordering, net::Ipv4Addr, time::Duration};

use anyhow::{anyhow, Context, Result};
use snmp::{SyncSession, Value};
use tokio::task::spawn_blocking;

use super::{SnmpConfig, SnmpValue};

const DEFAULT_PORT: u16 = 161;
const BULK_MAX_REPETITIONS: u32 = 16;

#[derive(Debug, Clone)]
pub struct SnmpSession {
    target: String,
    community: String,
    timeout: Duration,
    retries: u32,
    _version: String,
}

impl SnmpSession {
    pub fn new(ip: &str, config: &SnmpConfig) -> Self {
        Self {
            target: format!("{ip}:{DEFAULT_PORT}"),
            community: config.community.clone(),
            timeout: config.timeout,
            retries: config.retries,
            _version: config.version.clone(),
        }
    }

    pub async fn get(&self, oid: &str) -> Result<SnmpValue> {
        let target = self.target.clone();
        let community = self.community.clone();
        let timeout = self.timeout;
        let retries = self.retries;
        let oid = parse_oid(oid)?;

        spawn_blocking(move || {
            let mut session = build_sync_session(&target, &community, timeout)?;
            request_with_retries(retries, || {
                let mut response = session.get(&oid).map_err(|err| anyhow!("{:?}", err))?;
                let (_, value) = response
                    .varbinds
                    .next()
                    .context("SNMP GET returned no varbinds")?;

                Ok(value_to_owned(value))
            })
        })
        .await
        .context("SNMP GET task failed")?
    }

    pub async fn walk(&self, oid: &str) -> Result<Vec<(String, SnmpValue)>> {
        self.walk_impl(oid, false).await
    }

    pub async fn bulk_walk(&self, oid: &str) -> Result<Vec<(String, SnmpValue)>> {
        self.walk_impl(oid, true).await
    }

    async fn walk_impl(&self, oid: &str, use_bulk: bool) -> Result<Vec<(String, SnmpValue)>> {
        let target = self.target.clone();
        let community = self.community.clone();
        let timeout = self.timeout;
        let retries = self.retries;
        let start_oid = parse_oid(oid)?;

        spawn_blocking(move || {
            let mut session = build_sync_session(&target, &community, timeout)?;
            let mut current_oid = start_oid.clone();
            let mut values = Vec::new();
            let mut seen: Vec<Vec<u32>> = Vec::new();

            loop {
                let entries = if use_bulk {
                    request_with_retries(retries, || {
                        let response = session
                            .getbulk(&[current_oid.as_slice()], 0, BULK_MAX_REPETITIONS)
                            .map_err(|err| anyhow!("{:?}", err))?;
                        let mut rows = Vec::new();
                        for (name, value) in response.varbinds {
                            rows.push((oid_to_string_vec(&name)?, value_to_owned(value)));
                        }
                        Ok(rows)
                    })?
                } else {
                    request_with_retries(retries, || {
                        let response = session
                            .getnext(&current_oid)
                            .map_err(|err| anyhow!("{:?}", err))?;
                        let mut rows = Vec::new();
                        for (name, value) in response.varbinds {
                            rows.push((oid_to_string_vec(&name)?, value_to_owned(value)));
                        }
                        Ok(rows)
                    })?
                };

                let mut advanced = false;
                for (name_vec, value) in entries {
                    if !is_within_subtree(&start_oid, &name_vec) {
                        return Ok(values);
                    }
                    if let Some(previous) = seen.last() {
                        if !is_progressing(previous, &name_vec) {
                            return Ok(values);
                        }
                    }
                    seen.push(name_vec.clone());
                    current_oid = name_vec;
                    values.push((oid_to_string_vec_text(&current_oid), value));
                    advanced = true;
                }

                if !advanced {
                    break;
                }
            }

            Ok(values)
        })
        .await
        .context("SNMP WALK task failed")?
    }
}

fn build_sync_session(target: &str, community: &str, timeout: Duration) -> Result<SyncSession> {
    SyncSession::new(target, community.as_bytes(), Some(timeout), 1).map_err(|err| anyhow!(err))
}

fn request_with_retries<T, F>(retries: u32, mut f: F) -> Result<T>
where
    F: FnMut() -> Result<T>,
{
    let attempts = retries.saturating_add(1);
    let mut last_error = None;

    for _ in 0..attempts {
        match f() {
            Ok(value) => return Ok(value),
            Err(err) => last_error = Some(err),
        }
    }

    Err(anyhow!(
        "{:?}",
        last_error.expect("at least one attempt is executed")
    ))
}

pub fn parse_oid(oid: &str) -> Result<Vec<u32>> {
    let mut parts = Vec::new();

    for part in oid.split('.') {
        if part.is_empty() {
            continue;
        }
        let value: u32 = part
            .parse()
            .with_context(|| format!("invalid OID component: {part}"))?;
        parts.push(value);
    }

    if parts.is_empty() {
        return Err(anyhow!("OID must contain at least one component"));
    }

    Ok(parts)
}

pub fn oid_to_string_vec(name: &snmp::ObjectIdentifier<'_>) -> Result<Vec<u32>> {
    let mut buffer = [0u32; 128];
    Ok(name
        .read_name(&mut buffer)
        .map_err(|err| anyhow!("{:?}", err))?
        .to_vec())
}

pub fn oid_to_string_vec_text(oid: &[u32]) -> String {
    oid.iter().map(u32::to_string).collect::<Vec<_>>().join(".")
}

pub fn oid_to_string(name: &snmp::ObjectIdentifier<'_>) -> Result<String> {
    Ok(oid_to_string_vec_text(&oid_to_string_vec(name)?))
}

pub fn is_within_subtree(prefix: &[u32], candidate: &[u32]) -> bool {
    candidate.len() >= prefix.len() && candidate.starts_with(prefix)
}

pub fn cidr_prefix_len(mask: &[u8]) -> Option<u8> {
    if mask.len() != 4 {
        return None;
    }

    let mut prefix = 0u8;
    let mut seen_zero = false;
    for octet in mask {
        for bit in (0..8).rev() {
            let is_set = (octet >> bit) & 1 == 1;
            if seen_zero && is_set {
                return None;
            }
            if is_set {
                prefix = prefix.saturating_add(1);
            } else {
                seen_zero = true;
            }
        }
    }

    Some(prefix)
}

pub fn value_to_owned(value: Value<'_>) -> SnmpValue {
    match value {
        Value::Boolean(inner) => SnmpValue::Boolean(inner),
        Value::Null => SnmpValue::Null,
        Value::Integer(inner) => SnmpValue::Integer(inner),
        Value::OctetString(inner) => SnmpValue::OctetString(inner.to_vec()),
        Value::ObjectIdentifier(inner) => {
            let mut buffer = [0u32; 128];
            let text = inner
                .read_name(&mut buffer)
                .map(oid_to_string_vec_text)
                .unwrap_or_else(|_| format!("Invalid OID: {:?}", inner.raw()));
            SnmpValue::ObjectIdentifier(text)
        }
        Value::IpAddress(inner) => {
            SnmpValue::IpAddress(Ipv4Addr::new(inner[0], inner[1], inner[2], inner[3]))
        }
        Value::Counter32(inner) => SnmpValue::Counter32(inner),
        Value::Unsigned32(inner) => SnmpValue::Unsigned32(inner),
        Value::Timeticks(inner) => SnmpValue::Timeticks(inner),
        Value::Opaque(inner) => SnmpValue::Opaque(inner.to_vec()),
        Value::Counter64(inner) => SnmpValue::Counter64(inner),
        Value::Sequence(_)
        | Value::Set(_)
        | Value::Constructed(_, _)
        | Value::SnmpGetRequest(_)
        | Value::SnmpGetNextRequest(_)
        | Value::SnmpGetBulkRequest(_)
        | Value::SnmpResponse(_)
        | Value::SnmpSetRequest(_)
        | Value::SnmpInformRequest(_)
        | Value::SnmpTrap(_)
        | Value::SnmpReport(_) => SnmpValue::Null,
    }
}

pub(crate) fn is_progressing(previous: &[u32], current: &[u32]) -> bool {
    match current.cmp(previous) {
        Ordering::Greater => true,
        Ordering::Equal | Ordering::Less => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_oids() {
        let oid = parse_oid("1.3.6.1.2.1.1.1.0").unwrap();
        assert_eq!(oid, vec![1, 3, 6, 1, 2, 1, 1, 1, 0]);
    }

    #[test]
    fn rejects_empty_oid() {
        assert!(parse_oid("").is_err());
    }

    #[test]
    fn subtree_detection_is_strict() {
        let prefix = vec![1, 3, 6];
        assert!(is_within_subtree(&prefix, &[1, 3, 6, 1]));
        assert!(is_within_subtree(&prefix, &[1, 3, 6]));
        assert!(!is_within_subtree(&prefix, &[1, 3, 5, 9]));
    }

    #[test]
    fn masks_are_converted_to_prefix_lengths() {
        assert_eq!(cidr_prefix_len(&[255, 255, 255, 0]), Some(24));
        assert_eq!(cidr_prefix_len(&[255, 255, 254, 0]), Some(23));
        assert_eq!(cidr_prefix_len(&[255, 0, 255, 0]), None);
    }

    #[test]
    fn ordered_walk_progresses_monotonically() {
        assert!(is_progressing(&[1, 3, 6], &[1, 3, 6, 1]));
        assert!(!is_progressing(&[1, 3, 6, 1], &[1, 3, 6, 1]));
        assert!(!is_progressing(&[1, 3, 6, 2], &[1, 3, 6, 1]));
    }

    #[test]
    fn converts_common_snmp_values() {
        assert_eq!(value_to_owned(Value::Integer(42)), SnmpValue::Integer(42));
        assert_eq!(
            value_to_owned(Value::IpAddress([192, 0, 2, 1])),
            SnmpValue::IpAddress(Ipv4Addr::new(192, 0, 2, 1))
        );
        assert_eq!(
            value_to_owned(Value::OctetString(b"vyos".as_ref())),
            SnmpValue::OctetString(b"vyos".to_vec())
        );
    }
}
