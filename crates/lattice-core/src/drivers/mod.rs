use async_trait::async_trait;

use crate::{
    collectors::{Collector, GraphPatch},
    snmp::SnmpSession,
};

pub mod generic;

#[async_trait]
pub trait NetworkDriver: Send + Sync {
    fn build_collectors(&self) -> Vec<Box<dyn Collector>>;

    fn name(&self) -> &'static str {
        "generic"
    }

    async fn collect(
        &self,
        session: &SnmpSession,
        ctx: &crate::collectors::CollectorContext,
    ) -> anyhow::Result<GraphPatch> {
        let mut patch = GraphPatch::default();
        for collector in self.build_collectors() {
            if collector.is_available(session).await {
                let output = collector.collect(session, ctx).await?;
                patch.merge(output);
            }
        }
        Ok(patch)
    }
}

pub fn detect_vendor(sys_descr: &str) -> &'static str {
    let lowered = sys_descr.to_lowercase();
    if lowered.contains("vyos") {
        "vyos"
    } else if lowered.contains("cisco") {
        "cisco"
    } else if lowered.contains("juniper") {
        "juniper"
    } else if lowered.contains("arista") {
        "arista"
    } else {
        "generic"
    }
}

pub fn get_driver(vendor: &str) -> Box<dyn NetworkDriver> {
    match vendor.to_lowercase().as_str() {
        "vyos" | "generic" => generic::GenericDriver::new(),
        _ => generic::GenericDriver::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vendor_detection_handles_vyos_and_fallbacks() {
        assert_eq!(detect_vendor("VyOS 1.4"), "vyos");
        assert_eq!(detect_vendor("unknown appliance"), "generic");
    }

    #[test]
    fn registry_returns_generic_for_vyos() {
        assert_eq!(get_driver("vyos").name(), "generic");
        assert_eq!(get_driver("generic").name(), "generic");
    }
}
