mod client;
mod source;
mod uplink;

pub use client::{
    ClusterResource, GuestAgentIpAddress, GuestAgentNetworkInterface,
    GuestAgentNetworkInterfacesResponse, GuestConfig, GuestNetworkAttachment, NodeNetworkInterface,
    ProxmoxApi, ProxmoxApiClient,
};
pub use source::ProxmoxDiscoverySource;
pub use uplink::attach_proxmox_uplinks;
