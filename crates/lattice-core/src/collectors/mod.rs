use anyhow::Result;
use async_trait::async_trait;

use crate::{graph::LinkProtocol, snmp::SnmpSession, Device, IdentityKeys};

pub mod interfaces;
pub mod lldp;
pub mod routes;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectorContext {
    pub local_device_id: String,
    pub target_ip: String,
    pub seed_ip: String,
    pub depth: u32,
}

#[derive(Debug, Clone)]
pub struct ObservedLink {
    pub local_device_id: String,
    pub local_interface: String,
    pub remote_identity: IdentityKeys,
    pub remote_interface: String,
    pub remote_sys_descr: Option<String>,
    pub speed_bps: Option<u64>,
    pub protocol: LinkProtocol,
}

#[derive(Debug, Clone, Default)]
pub struct GraphPatch {
    pub devices: Vec<Device>,
    pub observed_links: Vec<ObservedLink>,
}

impl GraphPatch {
    pub fn merge(&mut self, other: GraphPatch) {
        self.devices.extend(other.devices);
        self.observed_links.extend(other.observed_links);
    }
}

#[async_trait]
pub trait Collector: Send + Sync {
    async fn is_available(&self, session: &SnmpSession) -> bool;
    async fn collect(&self, session: &SnmpSession, ctx: &CollectorContext) -> Result<GraphPatch>;
}

#[cfg(test)]
mod tests {
    use super::GraphPatch;

    #[test]
    fn merge_keeps_empty_patches_empty() {
        let mut patch = GraphPatch::default();
        patch.merge(GraphPatch::default());

        assert!(patch.devices.is_empty());
        assert!(patch.observed_links.is_empty());
    }
}
