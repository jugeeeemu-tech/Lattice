pub mod collectors;
pub mod config;
pub mod discovery;
pub mod drivers;
pub mod graph;
pub mod proxmox;
pub mod snmp;

pub use config::{
    load_config, AppConfig, DiscoveryConfig, ProxmoxSourceConfig, SeedDevice, ServerConfig,
    SnmpSourceConfig, SourceConfig,
};
pub use discovery::{
    build_discovery_sources, merge_source_results, DeviceRelations, DiscoveryEngine,
    DiscoveryRelations, DiscoveryResult, DiscoverySource, DiscoverySourceOutput, DiscoveryTree,
    DiscoveryTreeNode, SnmpDiscoverySource, SourceResult,
};
pub use graph::{
    synthesize_proxmox_uplinks, DeploymentType, Device, DeviceRole, DeviceStatus, GraphStore,
    GuestAttachment, GuestKind, IdentityKeys, Interface, Link, LinkProtocol, OperStatus, Topology,
};
pub use proxmox::{
    attach_proxmox_uplinks, ClusterResource, GuestConfig, GuestNetworkAttachment,
    NodeNetworkInterface, ProxmoxApi, ProxmoxApiClient, ProxmoxDiscoverySource,
};
pub use snmp::{SnmpSession, SnmpValue};
