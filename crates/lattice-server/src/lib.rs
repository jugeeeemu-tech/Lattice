pub mod api;
pub mod cli;
pub mod observability;
pub mod serve;

use std::path::{Path, PathBuf};

pub fn frontend_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("frontend")
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Arc;

    use lattice_core::{DiscoveryConfig, DiscoveryEngine, TopologyHintsConfig};
    use tokio::sync::Semaphore;

    use crate::api::{
        routes::{build_router, AccessPolicy},
        AppState, DiscoveryCoordinator,
    };

    use super::frontend_root;

    #[test]
    fn frontend_root_points_to_frontend_directory() {
        assert!(frontend_root().ends_with(Path::new("frontend")));
    }

    #[test]
    fn builds_router() {
        let config = DiscoveryConfig::default();
        let engine = Arc::new(DiscoveryEngine::new(
            config.clone(),
            Vec::new(),
            TopologyHintsConfig::default(),
        ));
        let coordinator = Arc::new(DiscoveryCoordinator::new(
            engine,
            config.auto_discovery_interval_seconds,
            config.manual_discovery_cooldown_seconds,
        ));
        let state = AppState {
            coordinator,
            access_policy: AccessPolicy::for_bind_target("127.0.0.1", 8080, &[]).unwrap(),
            websocket_slots: Arc::new(Semaphore::new(64)),
        };
        let _ = build_router(state);
    }
}
