//! Package model and loading. The compiler core is filesystem-free; this
//! module is the host service that reads `forge.toml` and sources.

use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceFile {
    /// Path relative to the package root, `/`-separated after normalization.
    pub path: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Package {
    pub name: String,
    pub version: String,
    pub edition: String,
    pub profile: String,
    pub targets: Vec<String>,
    pub files: Vec<SourceFile>,
    /// (alias, package name) as declared under `[dependencies]`.
    pub dependencies: Vec<(String, String)>,
    /// (alias, path) for dependencies resolved from disk, used by loaders.
    pub dependency_paths: Vec<(String, PathBuf)>,
    /// Dependency aliases explicitly selected for this deployment. Imports alone stay remote.
    pub deployed_dependencies: Vec<String>,
    /// `[observability]` from forge.toml: SLO window and per-class targets.
    pub observability: crate::ir::ObservabilityConfig,
    /// `[extensions.<name>]` pins: manifest path (relative to the package root) and expected sha256.
    pub extensions: Vec<Extension>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extension {
    pub name: String,
    pub manifest: PathBuf,
    pub sha256: String,
}

impl Package {
    pub fn inline(name: &str, files: Vec<(String, String)>) -> Package {
        Package {
            name: name.to_string(),
            version: "0.0.0".into(),
            edition: "2026".into(),
            profile: "portable-v1".into(),
            targets: vec!["cloudflare-d1".into(), "aws-dynamodb".into()],
            files: files
                .into_iter()
                .map(|(path, text)| SourceFile { path, text })
                .collect(),
            dependencies: Vec::new(),
            dependency_paths: Vec::new(),
            deployed_dependencies: Vec::new(),
            observability: crate::ir::ObservabilityConfig::default(),
            extensions: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct Manifest {
    package: ManifestPackage,
    #[serde(default)]
    source: ManifestSource,
    #[serde(default)]
    dependencies: indexmap::IndexMap<String, Dependency>,
    #[serde(default)]
    compatibility: Compatibility,
    #[serde(default)]
    observability: ManifestObservability,
    #[serde(default)]
    extensions: indexmap::IndexMap<String, ManifestExtension>,
}
#[derive(Debug, Deserialize)]
struct ManifestExtension {
    manifest: String,
    sha256: String,
}
#[derive(Debug, Deserialize, Default)]
struct ManifestObservability {
    #[serde(default)]
    window: Option<String>,
    #[serde(default)]
    slo: indexmap::IndexMap<String, ManifestSlo>,
}
#[derive(Debug, Deserialize)]
struct ManifestSlo {
    availability: String,
    latency: ManifestLatency,
}
#[derive(Debug, Deserialize)]
struct ManifestLatency {
    good: String,
    within: String,
}
#[derive(Debug, Deserialize)]
struct ManifestPackage {
    name: String,
    version: String,
    #[serde(default = "default_edition")]
    edition: String,
}
fn default_edition() -> String {
    "2026".into()
}
#[derive(Debug, Deserialize)]
struct ManifestSource {
    #[serde(default = "default_root")]
    root: String,
}
impl Default for ManifestSource {
    fn default() -> Self {
        Self {
            root: default_root(),
        }
    }
}
fn default_root() -> String {
    "src".into()
}
#[derive(Debug, Deserialize)]
struct Dependency {
    path: String,
    #[serde(default)]
    deploy: bool,
}
#[derive(Debug, Deserialize, Default)]
struct Compatibility {
    #[serde(default = "default_profile")]
    profile: String,
    #[serde(default)]
    targets: Vec<String>,
}
fn default_profile() -> String {
    "portable-v1".into()
}

#[derive(Debug)]
pub enum LoadError {
    Io(PathBuf, std::io::Error),
    Manifest(PathBuf, String),
}
impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoadError::Io(p, e) => write!(f, "{}: {e}", p.display()),
            LoadError::Manifest(p, e) => write!(f, "{}: {e}", p.display()),
        }
    }
}
impl std::error::Error for LoadError {}

/// Read `forge.toml` and every `.forge` file under the source root, in a
/// deterministic order independent of directory iteration order.
pub fn load_package(root: &Path) -> Result<Package, LoadError> {
    let manifest_path = root.join("forge.toml");
    let text = std::fs::read_to_string(&manifest_path)
        .map_err(|e| LoadError::Io(manifest_path.clone(), e))?;
    let m: Manifest = toml::from_str(&text)
        .map_err(|e| LoadError::Manifest(manifest_path.clone(), e.to_string()))?;

    let src_root = root.join(&m.source.root);
    let mut paths = Vec::new();
    collect_forge_files(&src_root, &mut paths)?;
    paths.sort();
    let mut files = Vec::new();
    for p in paths {
        let rel = p
            .strip_prefix(root)
            .unwrap_or(&p)
            .to_string_lossy()
            .replace('\\', "/");
        let text = std::fs::read_to_string(&p).map_err(|e| LoadError::Io(p.clone(), e))?;
        files.push(SourceFile { path: rel, text });
    }

    let mut dependencies = Vec::new();
    let mut dependency_paths = Vec::new();
    for (alias, dep) in &m.dependencies {
        let dep_root = root.join(&dep.path);
        let dep_manifest = dep_root.join("forge.toml");
        let dep_text = std::fs::read_to_string(&dep_manifest)
            .map_err(|e| LoadError::Io(dep_manifest.clone(), e))?;
        let dm: Manifest = toml::from_str(&dep_text)
            .map_err(|e| LoadError::Manifest(dep_manifest.clone(), e.to_string()))?;
        dependencies.push((alias.clone(), dm.package.name));
        dependency_paths.push((alias.clone(), dep_root));
    }

    Ok(Package {
        name: m.package.name,
        version: m.package.version,
        edition: m.package.edition,
        profile: m.compatibility.profile,
        targets: m.compatibility.targets,
        files,
        dependencies,
        dependency_paths,
        deployed_dependencies: m
            .dependencies
            .iter()
            .filter(|(_, d)| d.deploy)
            .map(|(a, _)| a.clone())
            .collect(),
        extensions: m
            .extensions
            .iter()
            .map(|(name, e)| Extension {
                name: name.clone(),
                manifest: root.join(&e.manifest),
                sha256: e.sha256.clone(),
            })
            .collect(),
        observability: crate::ir::ObservabilityConfig {
            window: m.observability.window.unwrap_or_else(|| "28d".into()),
            slo: m
                .observability
                .slo
                .into_iter()
                .map(|(class, s)| {
                    (
                        class,
                        crate::ir::SloTarget {
                            availability: s.availability,
                            latency_good: s.latency.good,
                            latency_within: s.latency.within,
                        },
                    )
                })
                .collect(),
        },
    })
}

fn collect_forge_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), LoadError> {
    let entries = std::fs::read_dir(dir).map_err(|e| LoadError::Io(dir.to_path_buf(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| LoadError::Io(dir.to_path_buf(), e))?;
        let path = entry.path();
        if path.is_dir() {
            collect_forge_files(&path, out)?;
        } else if path.extension().is_some_and(|e| e == "forge") {
            out.push(path);
        }
    }
    Ok(())
}
