pub mod session;

use std::{fmt, net::Ipv4Addr, time::Duration};

use serde::{Deserialize, Serialize};

pub use session::{
    cidr_prefix_len, is_within_subtree, oid_to_string, oid_to_string_vec, parse_oid, SnmpSession,
};

pub mod oids {
    pub const SYS_DESCR: &str = "1.3.6.1.2.1.1.1.0";
    pub const SYS_NAME: &str = "1.3.6.1.2.1.1.5.0";

    pub const LLDP_REM_SYS_NAME: &str = "1.0.8802.1.1.2.1.4.1.1.9";
    pub const LLDP_REM_PORT_ID: &str = "1.0.8802.1.1.2.1.4.1.1.7";
    pub const LLDP_REM_PORT_DESC: &str = "1.0.8802.1.1.2.1.4.1.1.8";
    pub const LLDP_REM_SYS_DESC: &str = "1.0.8802.1.1.2.1.4.1.1.10";
    pub const LLDP_REM_MGMT_ADDR: &str = "1.0.8802.1.1.2.1.4.2.1.4";
    pub const LLDP_REM_CHASSIS_ID: &str = "1.0.8802.1.1.2.1.4.1.1.5";
    pub const LLDP_LOC_PORT_ID: &str = "1.0.8802.1.1.2.1.3.7.1.3";

    pub const IF_DESCR: &str = "1.3.6.1.2.1.2.2.1.2";
    pub const IF_PHYS_ADDRESS: &str = "1.3.6.1.2.1.2.2.1.6";
    pub const IF_OPER_STATUS: &str = "1.3.6.1.2.1.2.2.1.8";
    pub const IF_HIGH_SPEED: &str = "1.3.6.1.2.1.31.1.1.1.15";
    pub const IF_NAME: &str = "1.3.6.1.2.1.31.1.1.1.1";

    pub const IP_AD_ENT_ADDR: &str = "1.3.6.1.2.1.4.20.1.1";
    pub const IP_AD_ENT_IF_IDX: &str = "1.3.6.1.2.1.4.20.1.2";
    pub const IP_AD_ENT_NET_MASK: &str = "1.3.6.1.2.1.4.20.1.3";
    pub const IP_CIDR_ROUTE_IF_INDEX: &str = "1.3.6.1.2.1.4.24.4.1.5";
    pub const IP_ROUTE_IF_INDEX: &str = "1.3.6.1.2.1.4.21.1.2";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnmpConfig {
    pub version: String,
    pub community: String,
    pub timeout: Duration,
    pub retries: u32,
}

impl SnmpConfig {
    pub fn new(
        version: impl Into<String>,
        community: impl Into<String>,
        timeout: Duration,
        retries: u32,
    ) -> Self {
        Self {
            version: version.into(),
            community: community.into(),
            timeout,
            retries,
        }
    }
}

impl Default for SnmpConfig {
    fn default() -> Self {
        Self {
            version: "2c".to_string(),
            community: "public".to_string(),
            timeout: Duration::from_secs(5),
            retries: 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SnmpValue {
    Boolean(bool),
    Integer(i64),
    OctetString(Vec<u8>),
    ObjectIdentifier(String),
    Null,
    IpAddress(Ipv4Addr),
    Counter32(u32),
    Unsigned32(u32),
    Timeticks(u32),
    Opaque(Vec<u8>),
    Counter64(u64),
}

impl SnmpValue {
    pub fn as_text(&self) -> String {
        match self {
            SnmpValue::Boolean(value) => value.to_string(),
            SnmpValue::Integer(value) => value.to_string(),
            SnmpValue::OctetString(value) => String::from_utf8_lossy(value).to_string(),
            SnmpValue::ObjectIdentifier(value) => value.clone(),
            SnmpValue::Null => "null".to_string(),
            SnmpValue::IpAddress(value) => value.to_string(),
            SnmpValue::Counter32(value) => value.to_string(),
            SnmpValue::Unsigned32(value) => value.to_string(),
            SnmpValue::Timeticks(value) => value.to_string(),
            SnmpValue::Opaque(value) => format!("{:?}", value),
            SnmpValue::Counter64(value) => value.to_string(),
        }
    }

    pub fn as_ipv4(&self) -> Option<Ipv4Addr> {
        match self {
            SnmpValue::IpAddress(value) => Some(*value),
            SnmpValue::OctetString(value) if value.len() == 4 => {
                Some(Ipv4Addr::new(value[0], value[1], value[2], value[3]))
            }
            _ => None,
        }
    }
}

impl fmt::Display for SnmpValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.as_text())
    }
}
