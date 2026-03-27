use crate::collectors::{
    interfaces::InterfaceCollector, lldp::LldpCollector, routes::RouteCollector,
};

use super::NetworkDriver;

#[derive(Debug, Default, Clone)]
pub struct GenericDriver;

impl GenericDriver {
    pub fn new() -> Box<dyn NetworkDriver> {
        Box::new(Self)
    }
}

impl NetworkDriver for GenericDriver {
    fn build_collectors(&self) -> Vec<Box<dyn crate::collectors::Collector>> {
        vec![
            Box::new(LldpCollector::new()),
            Box::new(InterfaceCollector::new()),
            Box::new(RouteCollector::new()),
        ]
    }
}
