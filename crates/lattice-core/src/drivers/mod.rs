use async_trait::async_trait;
use tracing::warn;

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
                match collector.collect(session, ctx).await {
                    Ok(output) => patch.merge(output),
                    Err(error) => {
                        warn!(
                            collector = collector.name(),
                            error = %error,
                            "collector failed; continuing with partial discovery"
                        );
                    }
                }
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
    use crate::{
        collectors::{Collector, CollectorContext, GraphPatch},
        snmp::SnmpSession,
    };
    use anyhow::anyhow;

    struct SuccessCollector;

    #[async_trait]
    impl Collector for SuccessCollector {
        fn name(&self) -> &'static str {
            "success"
        }

        async fn is_available(&self, _session: &SnmpSession) -> bool {
            true
        }

        async fn collect(
            &self,
            _session: &SnmpSession,
            _ctx: &CollectorContext,
        ) -> anyhow::Result<GraphPatch> {
            Ok(GraphPatch::default())
        }
    }

    struct FailingCollector;

    #[async_trait]
    impl Collector for FailingCollector {
        fn name(&self) -> &'static str {
            "failing"
        }

        async fn is_available(&self, _session: &SnmpSession) -> bool {
            true
        }

        async fn collect(
            &self,
            _session: &SnmpSession,
            _ctx: &CollectorContext,
        ) -> anyhow::Result<GraphPatch> {
            Err(anyhow!("boom"))
        }
    }

    struct MixedDriver;

    impl NetworkDriver for MixedDriver {
        fn build_collectors(&self) -> Vec<Box<dyn Collector>> {
            vec![Box::new(FailingCollector), Box::new(SuccessCollector)]
        }
    }

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

    #[tokio::test]
    async fn collect_continues_when_one_collector_fails() {
        let session = SnmpSession::new("127.0.0.1", &crate::snmp::SnmpConfig::default());
        let ctx = CollectorContext {
            local_device_id: "device-1".to_string(),
            target_ip: "127.0.0.1".to_string(),
            seed_ip: "127.0.0.1".to_string(),
            depth: 0,
        };

        let patch = MixedDriver.collect(&session, &ctx).await.unwrap();

        assert!(patch.devices.is_empty());
        assert!(patch.observed_links.is_empty());
    }
}
