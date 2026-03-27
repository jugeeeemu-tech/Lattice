pub mod api;
pub mod cli;

use std::path::{Path, PathBuf};

pub fn frontend_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("frontend")
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
        assert!(frontend_root().ends_with(Path::new("src/frontend")));
    }

    #[test]
    fn builds_router() {
        let engine = Arc::new(DiscoveryEngine::new(DiscoveryConfig::default(), Vec::new()));
        let coordinator = Arc::new(DiscoveryCoordinator::new(engine));
        let state = AppState { coordinator };
        let _ = build_router(state);
    }
}
