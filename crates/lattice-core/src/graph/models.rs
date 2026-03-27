use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeviceRole {
    Router,
    Switch,
    Bridge,
    Server,
    Unknown,
}

impl Default for DeviceRole {
    fn default() -> Self {
        Self::Unknown
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeploymentType {
    Physical,
    Virtual,
    Unknown,
}

impl DeploymentType {
    pub fn is_virtual(&self) -> bool {
        matches!(self, Self::Virtual)
    }

    pub fn is_physical(&self) -> bool {
        matches!(self, Self::Physical)
    }
}

impl Default for DeploymentType {
    fn default() -> Self {
        Self::Unknown
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeviceStatus {
    Up,
    Down,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperStatus {
    Up,
    Down,
    Unknown,
}

impl Default for OperStatus {
    fn default() -> Self {
        Self::Unknown
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LinkProtocol {
    Lldp,
    ProxmoxBridge,
    ProxmoxGuestLink,
    ProxmoxUplink,
    Unknown,
}

impl Default for LinkProtocol {
    fn default() -> Self {
        Self::Unknown
    }
}

impl LinkProtocol {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Lldp => "lldp",
            Self::ProxmoxBridge => "proxmox_bridge",
            Self::ProxmoxGuestLink => "proxmox_guest_link",
            Self::ProxmoxUplink => "proxmox_uplink",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct IdentityKeys {
    pub chassis_id: Option<String>,
    pub sys_name: Option<String>,
    pub mgmt_ip: Option<String>,
    #[serde(default)]
    pub mac_addresses: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Device {
    pub id: String,
    pub identity_keys: IdentityKeys,
    pub sys_descr: String,
    pub vendor: String,
    pub model: Option<String>,
    pub device_role: DeviceRole,
    pub deployment_type: DeploymentType,
    pub interfaces: Vec<Interface>,
    pub status: DeviceStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_mgmt_ip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_interface: Option<String>,
    pub last_seen: DateTime<Utc>,
}

impl Device {
    pub fn empty() -> Self {
        Self {
            id: String::new(),
            identity_keys: IdentityKeys::default(),
            sys_descr: String::new(),
            vendor: "generic".to_string(),
            model: None,
            device_role: DeviceRole::Unknown,
            deployment_type: DeploymentType::Unknown,
            interfaces: Vec::new(),
            status: DeviceStatus::Unknown,
            host_label: None,
            host_mgmt_ip: None,
            upstream_interface: None,
            last_seen: Utc::now(),
        }
    }

    pub fn label(&self) -> String {
        self.identity_keys
            .sys_name
            .clone()
            .or_else(|| self.identity_keys.mgmt_ip.clone())
            .unwrap_or_else(|| "Unknown".to_string())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Interface {
    pub if_index: u32,
    pub if_name: String,
    pub ip_addresses: Vec<String>,
    pub speed_bps: Option<u64>,
    pub oper_status: OperStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GuestAttachment {
    pub bridge_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vlan_tag: Option<u16>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub trunk_vlans: Vec<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Link {
    pub id: String,
    pub local_device_id: String,
    pub local_interface: String,
    pub local_ip: Option<String>,
    pub remote_device_id: String,
    pub remote_interface: String,
    pub remote_ip: Option<String>,
    pub speed_bps: Option<u64>,
    pub protocol: LinkProtocol,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guest_attachment: Option<GuestAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Topology {
    pub devices: HashMap<String, Device>,
    pub links: Vec<Link>,
    pub updated_at: DateTime<Utc>,
}

impl Default for Topology {
    fn default() -> Self {
        Self {
            devices: HashMap::new(),
            links: Vec::new(),
            updated_at: Utc::now(),
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;

    #[test]
    fn topology_round_trips_via_json() {
        let mut devices = HashMap::new();
        devices.insert(
            "device-1".to_string(),
            Device {
                id: "device-1".to_string(),
                identity_keys: IdentityKeys {
                    chassis_id: Some("00:11:22:33:44:55".to_string()),
                    sys_name: Some("core-sw".to_string()),
                    mgmt_ip: Some("192.0.2.10".to_string()),
                    mac_addresses: vec!["00:11:22:33:44:55".to_string()],
                },
                sys_descr: "VyOS 1.4".to_string(),
                vendor: "vyos".to_string(),
                model: Some("virtual".to_string()),
                device_role: DeviceRole::Bridge,
                deployment_type: DeploymentType::Virtual,
                interfaces: vec![Interface {
                    if_index: 1,
                    if_name: "vmbr0".to_string(),
                    ip_addresses: vec!["192.0.2.10/24".to_string()],
                    speed_bps: Some(1_000_000_000),
                    oper_status: OperStatus::Up,
                }],
                status: DeviceStatus::Up,
                host_label: Some("pve-01".to_string()),
                host_mgmt_ip: Some("192.0.2.10".to_string()),
                upstream_interface: Some("eno1".to_string()),
                last_seen: Utc::now(),
            },
        );

        let topology = Topology {
            devices,
            links: vec![Link {
                id: "device-1::vmbr0--device-2::eth0::proxmox_guest_link".to_string(),
                local_device_id: "device-1".to_string(),
                local_interface: "vmbr0".to_string(),
                local_ip: Some("192.0.2.10/24".to_string()),
                remote_device_id: "device-2".to_string(),
                remote_interface: "eth0".to_string(),
                remote_ip: None,
                speed_bps: Some(1_000_000_000),
                protocol: LinkProtocol::ProxmoxGuestLink,
                guest_attachment: Some(GuestAttachment {
                    bridge_name: "vmbr0".to_string(),
                    vlan_tag: Some(20),
                    trunk_vlans: vec![20, 30],
                }),
            }],
            updated_at: Utc::now(),
        };

        let value = serde_json::to_value(&topology).unwrap();
        let round_trip: Topology = serde_json::from_value(value).unwrap();

        assert_eq!(
            round_trip.devices["device-1"]
                .identity_keys
                .sys_name
                .as_deref(),
            Some("core-sw")
        );
        assert_eq!(
            round_trip.devices["device-1"].host_label.as_deref(),
            Some("pve-01")
        );
        assert_eq!(
            round_trip.devices["device-1"].host_mgmt_ip.as_deref(),
            Some("192.0.2.10")
        );
        assert_eq!(
            round_trip.devices["device-1"].upstream_interface.as_deref(),
            Some("eno1")
        );
        assert_eq!(
            round_trip.devices["device-1"]
                .identity_keys
                .mac_addresses
                .as_slice(),
            ["00:11:22:33:44:55"]
        );
        assert_eq!(
            round_trip.links[0].guest_attachment,
            Some(GuestAttachment {
                bridge_name: "vmbr0".to_string(),
                vlan_tag: Some(20),
                trunk_vlans: vec![20, 30],
            })
        );
        assert_eq!(round_trip.links[0].protocol, LinkProtocol::ProxmoxGuestLink);
    }
}
