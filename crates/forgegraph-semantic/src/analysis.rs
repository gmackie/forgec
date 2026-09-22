//! Bounded in-memory analysis caches. Full compilation remains the correctness oracle.
use crate::{Compilation, DomainIR, Package, compiler::compile_with_parser, ir::hash_hex};
use forgegraph_syntax::Parse;
use serde::Serialize;
use std::{collections::BTreeMap, rc::Rc};

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisStats {
    pub parse_hits: u64,
    pub parse_misses: u64,
    pub package_hits: u64,
    pub package_misses: u64,
    pub evictions: u64,
}
struct PackageEntry {
    package: Package,
    dependencies: BTreeMap<String, String>,
    compilation: Rc<Compilation>,
    used: u64,
}
struct ParseEntry {
    parsed: Parse,
    used: u64,
}

/// Keys identify workspace package roots, not names (two checkouts may have the same name).
/// Package fingerprints include full manifests/text/paths and declared dependency IR hashes.
/// A local edit re-elaborates that package; unrelated packages and unchanged trees are reused.
pub struct AnalysisCache {
    packages: BTreeMap<String, PackageEntry>,
    parses: BTreeMap<String, ParseEntry>,
    stats: AnalysisStats,
    tick: u64,
    package_limit: usize,
    parse_limit: usize,
}
impl Default for AnalysisCache {
    fn default() -> Self {
        Self::new(64, 2048)
    }
}
impl AnalysisCache {
    pub fn new(package_limit: usize, parse_limit: usize) -> Self {
        Self {
            packages: BTreeMap::new(),
            parses: BTreeMap::new(),
            stats: AnalysisStats::default(),
            tick: 0,
            package_limit: package_limit.max(1),
            parse_limit: parse_limit.max(1),
        }
    }
    pub fn stats(&self) -> AnalysisStats {
        self.stats.clone()
    }
    pub fn clear(&mut self) {
        self.packages.clear();
        self.parses.clear();
    }
    pub fn analyze(&mut self, key: &str, package: &Package, deps: &[&DomainIR]) -> Rc<Compilation> {
        self.tick += 1;
        let mut package = package.clone();
        package.files.sort_by(|a, b| a.path.cmp(&b.path));
        let dependencies: BTreeMap<String, String> = package
            .dependencies
            .iter()
            .map(|(_, name)| {
                let hash = deps
                    .iter()
                    .find(|d| &d.package.name == name)
                    .map(|d| d.content_hash())
                    .unwrap_or_else(|| "missing".into());
                (name.clone(), hash)
            })
            .collect();
        if let Some(entry) = self.packages.get_mut(key)
            && entry.package == package
            && entry.dependencies == dependencies
        {
            entry.used = self.tick;
            self.stats.package_hits += 1;
            return Rc::clone(&entry.compilation);
        }
        self.stats.package_misses += 1;
        let compilation = Rc::new(compile_with_parser(&package, deps, &mut |text| {
            let hash = hash_hex(text);
            if let Some(entry) = self.parses.get_mut(&hash) {
                self.stats.parse_hits += 1;
                entry.used = self.tick;
                return entry.parsed.clone();
            }
            self.stats.parse_misses += 1;
            let parsed = forgegraph_syntax::parse(text);
            if self.parses.len() >= self.parse_limit {
                let oldest = self
                    .parses
                    .iter()
                    .min_by_key(|(_, e)| e.used)
                    .map(|(k, _)| k.clone())
                    .unwrap();
                self.parses.remove(&oldest);
                self.stats.evictions += 1;
            }
            self.parses.insert(
                hash,
                ParseEntry {
                    parsed: parsed.clone(),
                    used: self.tick,
                },
            );
            parsed
        }));
        if !self.packages.contains_key(key) && self.packages.len() >= self.package_limit {
            let oldest = self
                .packages
                .iter()
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| k.clone())
                .unwrap();
            self.packages.remove(&oldest);
            self.stats.evictions += 1;
        }
        self.packages.insert(
            key.into(),
            PackageEntry {
                package,
                dependencies,
                compilation: Rc::clone(&compilation),
                used: self.tick,
            },
        );
        compilation
    }
    /// Direct package dependency graph, suitable for profiling/debugging invalidations.
    pub fn dependencies(&self) -> BTreeMap<String, Vec<String>> {
        self.packages
            .iter()
            .map(|(key, entry)| (key.clone(), entry.dependencies.keys().cloned().collect()))
            .collect()
    }
}
