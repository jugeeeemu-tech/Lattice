pub mod api;
pub mod cli;
pub mod observability;

use std::path::{Path, PathBuf};

pub fn frontend_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("frontend")
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Arc;

    use lattice_core::{DiscoveryConfig, DiscoveryEngine};

    use crate::api::{routes::build_router, AppState, DiscoveryCoordinator};

    use super::frontend_root;

    #[test]
    fn frontend_root_points_to_frontend_directory() {
        assert!(frontend_root().ends_with(Path::new("frontend")));
    }

    #[test]
    fn builds_router() {
        let config = DiscoveryConfig::default();
        let engine = Arc::new(DiscoveryEngine::new(config.clone(), Vec::new()));
        let coordinator = Arc::new(DiscoveryCoordinator::new(
            engine,
            config.auto_discovery_interval_seconds,
        ));
        let state = AppState { coordinator };
        let _ = build_router(state);
    }
}
