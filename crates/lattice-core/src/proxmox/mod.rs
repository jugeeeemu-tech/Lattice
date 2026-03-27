mod client;
mod source;
mod uplink;

pub use client::{
    ClusterResource, GuestConfig, GuestNetworkAttachment, NodeNetworkInterface, ProxmoxApi,
    ProxmoxApiClient,
};
pub use source::ProxmoxDiscoverySource;
pub use uplink::attach_proxmox_uplinks;
