//! Package model and loading. The compiler core is filesystem-free; this
//! module is the host service that reads `forge.toml` and sources, through a
//! [`SourceTree`] so a host without a filesystem (wasm32 Workers) can supply them.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::io;
use std::path::{Component, Path, PathBuf};

/// Read-only access to package sources, manifests and pins.
pub trait SourceTree {
    fn read(&self, path: &Path) -> io::Result<Vec<u8>>;
    fn read_to_string(&self, path: &Path) -> io::Result<String> {
        String::from_utf8(self.read(path)?).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "stream did not contain valid UTF-8",
            )
        })
    }
    /// The entries directly under `dir` as `(path, is_dir)`, in no particular order.
    fn read_dir(&self, dir: &Path) -> io::Result<Vec<(PathBuf, bool)>>;
    /// The identity used to detect dependency cycles and shared dependencies.
    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf>;
}

/// The host filesystem.
pub struct OsTree;
impl SourceTree for OsTree {
    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        std::fs::read(path)
    }
    fn read_to_string(&self, path: &Path) -> io::Result<String> {
        std::fs::read_to_string(path)
    }
    fn read_dir(&self, dir: &Path) -> io::Result<Vec<(PathBuf, bool)>> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            let is_dir = path.is_dir();
            out.push((path, is_dir));
        }
        Ok(out)
    }
    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        path.canonicalize()
    }
}

/// Files held in memory, keyed by `/`-separated path. Paths are resolved
/// lexically (`.` and `..` folded), so `../payments` from `examples/acme`
/// names `examples/payments`. Directories exist implicitly.
#[derive(Debug, Clone, Default)]
pub struct MemoryTree {
    files: BTreeMap<PathBuf, Vec<u8>>,
}
impl MemoryTree {
    pub fn new(files: impl IntoIterator<Item = (String, Vec<u8>)>) -> MemoryTree {
        MemoryTree {
            files: files
                .into_iter()
                .map(|(path, bytes)| (normalize(Path::new(&path)), bytes))
                .collect(),
        }
    }
    fn is_dir(&self, dir: &Path) -> bool {
        self.files.keys().any(|p| p != dir && p.starts_with(dir))
    }
}
fn not_found(path: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::NotFound,
        format!("{} is not in the in-memory source tree", path.display()),
    )
}
fn normalize(path: &Path) -> PathBuf {
    let mut out: Vec<Component> = Vec::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => match out.last() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::RootDir | Component::Prefix(_)) => {}
                _ => out.push(c),
            },
            c => out.push(c),
        }
    }
    out.iter().collect()
}
impl SourceTree for MemoryTree {
    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        let path = normalize(path);
        self.files
            .get(&path)
            .cloned()
            .ok_or_else(|| not_found(&path))
    }
    fn read_dir(&self, dir: &Path) -> io::Result<Vec<(PathBuf, bool)>> {
        let dir = normalize(dir);
        let depth = dir.components().count();
        let mut entries = BTreeMap::new();
        for path in self
            .files
            .keys()
            .filter(|p| **p != dir && p.starts_with(&dir))
        {
            let mut components = path.components();
            let child: PathBuf = components.by_ref().take(depth + 1).collect();
            entries.insert(child, components.next().is_some());
        }
        if entries.is_empty() {
            return Err(not_found(&dir));
        }
        Ok(entries.into_iter().collect())
    }
    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        let path = normalize(path);
        if self.files.contains_key(&path) || self.is_dir(&path) {
            Ok(path)
        } else {
            Err(not_found(&path))
        }
    }
}

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
    load_package_in(&OsTree, root)
}

/// [`load_package`] over any [`SourceTree`].
pub fn load_package_in(tree: &dyn SourceTree, root: &Path) -> Result<Package, LoadError> {
    let manifest_path = root.join("forge.toml");
    let text = tree
        .read_to_string(&manifest_path)
        .map_err(|e| LoadError::Io(manifest_path.clone(), e))?;
    let m: Manifest = toml::from_str(&text)
        .map_err(|e| LoadError::Manifest(manifest_path.clone(), e.to_string()))?;

    let src_root = root.join(&m.source.root);
    let mut paths = Vec::new();
    collect_forge_files(tree, &src_root, &mut paths)?;
    paths.sort();
    let mut files = Vec::new();
    for p in paths {
        let rel = p
            .strip_prefix(root)
            .unwrap_or(&p)
            .to_string_lossy()
            .replace('\\', "/");
        let text = tree
            .read_to_string(&p)
            .map_err(|e| LoadError::Io(p.clone(), e))?;
        files.push(SourceFile { path: rel, text });
    }

    let mut dependencies = Vec::new();
    let mut dependency_paths = Vec::new();
    for (alias, dep) in &m.dependencies {
        let dep_root = root.join(&dep.path);
        let dep_manifest = dep_root.join("forge.toml");
        let dep_text = tree
            .read_to_string(&dep_manifest)
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

fn collect_forge_files(
    tree: &dyn SourceTree,
    dir: &Path,
    out: &mut Vec<PathBuf>,
) -> Result<(), LoadError> {
    let entries = tree
        .read_dir(dir)
        .map_err(|e| LoadError::Io(dir.to_path_buf(), e))?;
    for (path, is_dir) in entries {
        if is_dir {
            collect_forge_files(tree, &path, out)?;
        } else if path.extension().is_some_and(|e| e == "forge") {
            out.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> MemoryTree {
        MemoryTree::new([
            (
                "app/forge.toml".to_string(),
                b"[package]\nname = \"@t/app\"\nversion = \"1.0.0\"\n\n[dependencies]\nlib = { path = \"../lib\" }\n".to_vec(),
            ),
            ("app/src/b/two.forge".to_string(), b"purpose Two\n".to_vec()),
            ("app/src/one.forge".to_string(), b"purpose One\n".to_vec()),
            ("app/src/notes.txt".to_string(), b"ignored".to_vec()),
            (
                "lib/forge.toml".to_string(),
                b"[package]\nname = \"@t/lib\"\nversion = \"0.1.0\"\n".to_vec(),
            ),
        ])
    }

    #[test]
    fn memory_tree_loads_a_package_like_the_filesystem() {
        let package = load_package_in(&tree(), Path::new("app")).unwrap();
        assert_eq!(package.name, "@t/app");
        let paths: Vec<_> = package.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["src/b/two.forge", "src/one.forge"]);
        assert_eq!(package.dependencies, [("lib".into(), "@t/lib".into())]);
        assert_eq!(
            tree().canonicalize(&package.dependency_paths[0].1).unwrap(),
            Path::new("lib")
        );
    }

    #[test]
    fn memory_tree_reports_absent_paths() {
        let tree = tree();
        assert!(tree.canonicalize(Path::new("app/../missing")).is_err());
        assert!(tree.read(Path::new("app/src")).is_err());
        assert!(load_package_in(&tree, Path::new("lib")).is_err());
        assert_eq!(
            tree.canonicalize(Path::new("./app/src/../src")).unwrap(),
            Path::new("app/src")
        );
    }
}
