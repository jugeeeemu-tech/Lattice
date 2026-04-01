use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    error::Error,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct ManifestEntry {
    file: String,
    #[serde(default)]
    css: Vec<String>,
    #[serde(default)]
    assets: Vec<String>,
}

#[derive(Debug)]
struct EmbeddedAsset {
    path: String,
    absolute_path: PathBuf,
    content_type: &'static str,
}

fn main() -> Result<(), Box<dyn Error>> {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?);
    let frontend_dir = manifest_dir.join("frontend");
    let dist_dir = frontend_dir.join("dist");
    let manifest_path = dist_dir.join(".vite").join("manifest.json");

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=PATH");

    for relative_path in [
        "index.html",
        ".npmrc",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "vite.config.ts",
    ] {
        println!(
            "cargo:rerun-if-changed={}",
            frontend_dir.join(relative_path).display()
        );
    }
    rerun_if_changed_recursive(&frontend_dir.join("src"))?;

    ensure_command(&frontend_dir, "node")?;
    ensure_command(&frontend_dir, "npm")?;
    ensure_frontend_dependencies(&frontend_dir)?;
    run_frontend_build(&frontend_dir)?;

    let index_html_path = dist_dir.join("index.html");
    if !index_html_path.is_file() {
        return Err(format!(
            "frontend build did not produce {}",
            index_html_path.display()
        )
        .into());
    }
    if !manifest_path.is_file() {
        return Err(format!(
            "frontend build did not produce {}. Check Vite manifest output.",
            manifest_path.display()
        )
        .into());
    }

    let manifest_assets = collect_manifest_assets(&manifest_path)?;
    let embedded_assets = collect_embedded_assets(&dist_dir)?;
    ensure_manifest_assets_are_embedded(&manifest_assets, &embedded_assets)?;
    let generated =
        render_generated_assets_module(&index_html_path, &manifest_assets, &embedded_assets);
    let out_dir = PathBuf::from(env::var("OUT_DIR")?);
    fs::write(out_dir.join("frontend_assets.rs"), generated)?;

    Ok(())
}

fn rerun_if_changed_recursive(root: &Path) -> Result<(), Box<dyn Error>> {
    if !root.exists() {
        return Ok(());
    }

    println!("cargo:rerun-if-changed={}", root.display());

    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            rerun_if_changed_recursive(&path)?;
        } else {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }

    Ok(())
}

fn ensure_command(frontend_dir: &Path, command: &str) -> Result<(), Box<dyn Error>> {
    let output = Command::new(command)
        .arg("--version")
        .current_dir(frontend_dir)
        .output();

    match output {
        Ok(result) if result.status.success() => Ok(()),
        Ok(_) => Err(format!(
            "{command} is installed but could not be executed successfully while preparing the frontend build."
        )
        .into()),
        Err(_) => Err(format!(
            "{command} was not found in PATH. Install Node 24 and npm 11, then run `cd {}` && npm ci.",
            frontend_dir.display()
        )
        .into()),
    }
}

fn ensure_frontend_dependencies(frontend_dir: &Path) -> Result<(), Box<dyn Error>> {
    let node_modules = frontend_dir.join("node_modules");
    if node_modules.is_dir() {
        return Ok(());
    }

    Err(format!(
        "frontend dependencies are missing at {}. Run `cd {}` && npm ci before cargo build, cargo run, or cargo test.",
        node_modules.display(),
        frontend_dir.display()
    )
    .into())
}

fn run_frontend_build(frontend_dir: &Path) -> Result<(), Box<dyn Error>> {
    let status = Command::new("npm")
        .arg("run")
        .arg("build")
        .current_dir(frontend_dir)
        .status()?;

    if status.success() {
        Ok(())
    } else {
        Err("frontend build failed while running `npm run build`.".into())
    }
}

fn collect_manifest_assets(manifest_path: &Path) -> Result<Vec<String>, Box<dyn Error>> {
    let manifest_text = fs::read_to_string(manifest_path)?;
    let manifest: BTreeMap<String, ManifestEntry> = serde_json::from_str(&manifest_text)?;
    let mut paths = BTreeSet::new();

    for entry in manifest.values() {
        paths.insert(entry.file.clone());
        for css_path in &entry.css {
            paths.insert(css_path.clone());
        }
        for asset_path in &entry.assets {
            paths.insert(asset_path.clone());
        }
    }

    Ok(paths.into_iter().collect())
}

fn collect_embedded_assets(dist_dir: &Path) -> Result<Vec<EmbeddedAsset>, Box<dyn Error>> {
    let mut assets = Vec::new();
    collect_embedded_assets_recursive(dist_dir, dist_dir, &mut assets)?;
    assets.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(assets)
}

fn ensure_manifest_assets_are_embedded(
    manifest_assets: &[String],
    embedded_assets: &[EmbeddedAsset],
) -> Result<(), Box<dyn Error>> {
    let embedded_paths = embedded_assets
        .iter()
        .map(|asset| asset.path.as_str())
        .collect::<BTreeSet<_>>();

    let missing = manifest_assets
        .iter()
        .filter(|path| !embedded_paths.contains(path.as_str()))
        .cloned()
        .collect::<Vec<_>>();

    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "manifest referenced assets that were not embedded: {}",
            missing.join(", ")
        )
        .into())
    }
}

fn collect_embedded_assets_recursive(
    dist_dir: &Path,
    current_dir: &Path,
    assets: &mut Vec<EmbeddedAsset>,
) -> Result<(), Box<dyn Error>> {
    for entry in fs::read_dir(current_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_embedded_assets_recursive(dist_dir, &path, assets)?;
            continue;
        }

        let relative = path
            .strip_prefix(dist_dir)?
            .to_string_lossy()
            .replace('\\', "/");

        if relative == "index.html" || relative == ".vite/manifest.json" {
            continue;
        }

        assets.push(EmbeddedAsset {
            content_type: content_type_for(&path),
            path: relative,
            absolute_path: fs::canonicalize(path)?,
        });
    }

    Ok(())
}

fn content_type_for(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("css") => "text/css; charset=utf-8",
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("json") | Some("map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn render_generated_assets_module(
    index_html_path: &Path,
    manifest_assets: &[String],
    embedded_assets: &[EmbeddedAsset],
) -> String {
    let mut generated = String::new();

    generated.push_str("// @generated by build.rs\n");
    generated.push_str("#[derive(Debug, Clone, Copy, PartialEq, Eq)]\n");
    generated.push_str("pub struct EmbeddedAsset {\n");
    generated.push_str("    pub path: &'static str,\n");
    generated.push_str("    pub content_type: &'static str,\n");
    generated.push_str("    pub bytes: &'static [u8],\n");
    generated.push_str("}\n\n");

    generated.push_str("pub fn index_html() -> &'static str {\n");
    generated.push_str("    include_str!(");
    generated.push_str(&rust_string_literal(
        &fs::canonicalize(index_html_path)
            .expect("index.html should exist before rendering generated code")
            .to_string_lossy(),
    ));
    generated.push_str(")\n");
    generated.push_str("}\n\n");

    generated.push_str("pub fn manifest_asset_paths() -> &'static [&'static str] {\n");
    generated.push_str("    &[\n");
    for asset_path in manifest_assets {
        generated.push_str("        ");
        generated.push_str(&rust_string_literal(asset_path));
        generated.push_str(",\n");
    }
    generated.push_str("    ]\n");
    generated.push_str("}\n\n");

    generated.push_str("pub fn get(path: &str) -> Option<EmbeddedAsset> {\n");
    generated.push_str("    match path {\n");
    for asset in embedded_assets {
        generated.push_str("        ");
        generated.push_str(&rust_string_literal(&asset.path));
        generated.push_str(" => Some(EmbeddedAsset {\n");
        generated.push_str("            path: ");
        generated.push_str(&rust_string_literal(&asset.path));
        generated.push_str(",\n");
        generated.push_str("            content_type: ");
        generated.push_str(&rust_string_literal(asset.content_type));
        generated.push_str(",\n");
        generated.push_str("            bytes: include_bytes!(");
        generated.push_str(&rust_string_literal(&asset.absolute_path.to_string_lossy()));
        generated.push_str("),\n");
        generated.push_str("        }),\n");
    }
    generated.push_str("        _ => None,\n");
    generated.push_str("    }\n");
    generated.push_str("}\n");

    generated
}

fn rust_string_literal(value: &str) -> String {
    format!("{value:?}")
}
