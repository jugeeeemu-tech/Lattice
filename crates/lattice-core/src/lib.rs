pub mod collectors;
pub mod config;
pub mod discovery;
pub mod drivers;
pub mod graph;
pub mod proxmox;
pub mod snmp;

pub use config::{
    load_config, resolve_config_path, AppConfig, DiscoveryConfig, ProxmoxSourceConfig, SeedDevice,
    ServerConfig, SnmpSourceConfig, SourceConfig, TopologyHintEndpoint, TopologyHintLink,
    TopologyHintsConfig,
};
pub use discovery::{
    build_discovery_sources, merge_source_results, merge_source_results_with_hints,
    DeviceRelations, DiscoveryEngine, DiscoveryRelations, DiscoveryResult, DiscoverySource,
    DiscoverySourceOutput, DiscoveryTree, DiscoveryTreeNode, SnmpDiscoverySource, SourceResult,
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
