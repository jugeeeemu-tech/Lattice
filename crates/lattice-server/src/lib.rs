use std::path::{Path, PathBuf};

use axum::{routing::get, Router};

pub fn app() -> Router {
    Router::new().route("/health", get(health))
}

pub fn frontend_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("frontend")
}

async fn health() -> &'static str {
    "ok"
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{app, frontend_root};

    #[test]
    fn builds_router() {
        let _ = app();
    }

    #[test]
    fn frontend_root_points_to_frontend_directory() {
        assert!(frontend_root().ends_with(Path::new("src/frontend")));
    }
}
