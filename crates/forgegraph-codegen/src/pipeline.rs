//! The `check`/`build` pipeline shared by `forgec` and the wasm32 build: load a
//! package and its path dependencies from a [`SourceTree`], verify pins, and
//! render the generated artifacts as `(relative path, contents)` pairs. Hosts
//! own printing, exit codes and writing files.

use forgegraph_planner::Plans;
use forgegraph_semantic::{Compilation, DomainIR, Package, SourceTree, compile, load_package_in};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Every workspace crate shares one version, so this is the `forgec` version.
pub const COMPILER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// A pipeline failure. `rendered` carries dependency diagnostics that a host
/// prints before the error itself.
#[derive(Debug)]
pub struct Error {
    message: String,
    rendered: Option<String>,
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
}
impl Error {
    fn msg(message: impl Into<String>) -> Error {
        Error {
            message: message.into(),
            rendered: None,
            source: None,
        }
    }
    fn caused(
        message: impl Into<String>,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Error {
        Error {
            source: Some(Box::new(source)),
            ..Error::msg(message)
        }
    }
    pub fn rendered(&self) -> Option<&str> {
        self.rendered.as_deref()
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_deref()
            .map(|e| e as &(dyn std::error::Error + 'static))
    }
}

pub struct Loaded {
    pub package: Package,
    pub compilation: Compilation,
    /// Dependencies in topological order (name, ir).
    pub deps: Vec<(String, DomainIR)>,
    pub selected: Vec<DomainIR>,
    raw_ir: Option<DomainIR>,
}

#[derive(Clone)]
struct CachedPackage {
    has_extensions: bool,
    ir: DomainIR,
    selected: Vec<DomainIR>,
    deps: Vec<(String, DomainIR)>,
}

/// Load and compile a package after its path dependencies, depth-first.
pub fn load_tree(tree: &dyn SourceTree, root: &Path) -> Result<Loaded, Error> {
    load_tree_inner(tree, root, &mut BTreeMap::new(), &mut Vec::new())
}

fn load_tree_inner(
    tree: &dyn SourceTree,
    root: &Path,
    seen: &mut BTreeMap<PathBuf, CachedPackage>,
    stack: &mut Vec<PathBuf>,
) -> Result<Loaded, Error> {
    let canon = tree
        .canonicalize(root)
        .map_err(|e| Error::caused(format!("{}", root.display()), e))?;
    if stack.contains(&canon) {
        return Err(Error::msg(format!(
            "dependency cycle through {}",
            canon.display()
        )));
    }
    stack.push(canon.clone());
    let package = load_package_in(tree, &canon).map_err(|e| Error::msg(e.to_string()))?;
    verify_extensions(tree, &package)?;
    let mut deps = BTreeMap::<String, DomainIR>::new();
    let mut dep_irs = Vec::new();
    let mut selected = BTreeMap::<String, DomainIR>::new();
    for (alias, path) in &package.dependency_paths {
        let dep_canon = tree
            .canonicalize(path)
            .map_err(|e| Error::caused(format!("dependency `{alias}` at {}", path.display()), e))?;
        let cached = match seen.get(&dep_canon) {
            Some(cached) => cached.clone(),
            None => {
                let loaded = load_tree_inner(tree, &dep_canon, seen, stack)?;
                let rendered = loaded.compilation.render();
                let Some(ir) = loaded.raw_ir else {
                    return Err(Error {
                        rendered: Some(rendered),
                        ..Error::msg(format!("dependency `{}` has errors", loaded.package.name))
                    });
                };
                let cached = CachedPackage {
                    has_extensions: !loaded.package.extensions.is_empty(),
                    ir,
                    selected: loaded.selected,
                    deps: loaded.deps,
                };
                seen.insert(dep_canon, cached.clone());
                cached
            }
        };
        for (name, ir) in cached.deps.iter().chain(std::iter::once(&(
            cached.ir.package.name.clone(),
            cached.ir.clone(),
        ))) {
            if let Some(previous) = deps.insert(name.clone(), ir.clone())
                && previous != *ir
            {
                return Err(Error::msg(format!(
                    "E-ASSEMBLY-001: conflicting dependency package identity `{name}`"
                )));
            }
        }
        if package.deployed_dependencies.contains(alias) {
            if cached.has_extensions {
                return Err(Error::msg(format!(
                    "E-ASSEMBLY-005: co-deployed dependency `{alias}` uses extensions; extension pin assembly is not yet supported"
                )));
            }
            for ir in std::iter::once(&cached.ir).chain(&cached.selected) {
                selected.insert(ir.package.name.clone(), ir.clone());
            }
        }
        dep_irs.push(cached.ir);
    }
    let mut compilation = compile(&package, &dep_irs.iter().collect::<Vec<_>>());
    let raw_ir = compilation.ir.clone();
    let selected: Vec<_> = selected.into_values().collect();
    if stack.len() == 1
        && let Some(ir) = &raw_ir
    {
        if !selected.is_empty() && !package.extensions.is_empty() {
            return Err(Error::msg(
                "E-ASSEMBLY-005: extensions in an assembled deployment are not yet supported",
            ));
        }
        let assembled =
            forgegraph_semantic::assembly::assemble(ir, &selected).map_err(Error::msg)?;
        if !selected.is_empty() {
            forgegraph_planner::plan(&assembled).map_err(|e| Error::msg(e.to_string()))?;
        }
        compilation.ir = Some(assembled);
    }
    stack.pop();
    Ok(Loaded {
        package,
        compilation,
        deps: deps.into_iter().collect(),
        selected,
        raw_ir,
    })
}

/// `forge.lock` content. Dependencies are pinned by name, version and the
/// content hash of their compiled contract, so a changed upstream contract is
/// detected even when its version string is not bumped.
pub fn render_lock(deps: &[(String, DomainIR)], selected: &[DomainIR]) -> String {
    let mut s = String::from("# Generated by `forgec lock`; do not edit.\nlock = 1\n");
    s.push_str(&format!("compiler = \"{COMPILER_VERSION}\"\n"));
    for (name, d) in deps {
        s.push_str(&format!(
            "\n[[dependency]]\nname = \"{name}\"\nversion = \"{}\"\nhash = \"sha256:{}\"\n",
            d.package.version,
            d.content_hash()
        ));
    }
    for ir in selected {
        s.push_str(&format!("\n[[deployment]]\nname = {:?}\n", ir.package.name));
    }
    s
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockStatus {
    Current,
    /// No `forge.lock`; hosts warn only when there are dependencies to pin.
    Missing,
    /// A dependency contract or the compiler version changed.
    Stale,
}

/// Compare an existing `forge.lock` under `root` with the loaded dependency set.
pub fn lock_status(tree: &dyn SourceTree, root: &Path, loaded: &Loaded) -> LockStatus {
    let Ok(existing) = tree.read_to_string(&root.join("forge.lock")) else {
        return LockStatus::Missing;
    };
    if existing == render_lock(&loaded.deps, &loaded.selected) {
        LockStatus::Current
    } else {
        LockStatus::Stale
    }
}

/// FORGE-030: pinned extension manifests are read as bytes, digest-checked and shape-validated.
/// They declare capabilities; nothing in them is ever executed by the compiler.
pub fn verify_extensions(tree: &dyn SourceTree, pkg: &Package) -> Result<(), Error> {
    use sha2::Digest;
    const FORBIDDEN: &[&str] = &[
        "main",
        "exports",
        "scripts",
        "bin",
        "module",
        "require",
        "install",
        "postinstall",
        "code",
        "script",
    ];
    for e in &pkg.extensions {
        let bytes = tree.read(&e.manifest).map_err(|err| {
            Error::caused(
                format!("extension `{}`: {}", e.name, e.manifest.display()),
                err,
            )
        })?;
        let digest: String = sha2::Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if digest != e.sha256.trim_start_matches("sha256:") {
            return Err(Error::msg(format!(
                "error[E-EXT-001]: extension `{}` manifest digest {digest} does not match the pinned {}; review the change and re-pin",
                e.name, e.sha256
            )));
        }
        let v: Value = serde_json::from_slice(&bytes).map_err(|err| {
            Error::caused(
                format!(
                    "error[E-EXT-002]: extension `{}` manifest is not JSON",
                    e.name
                ),
                err,
            )
        })?;
        let Some(obj) = v.as_object() else {
            return Err(Error::msg(format!(
                "error[E-EXT-002]: extension `{}` manifest must be an object",
                e.name
            )));
        };
        if let Some(k) = obj.keys().find(|k| FORBIDDEN.contains(&k.as_str())) {
            return Err(Error::msg(format!(
                "error[E-EXT-002]: extension `{}` manifest carries an executable entry `{k}`; manifests declare capabilities and never run",
                e.name
            )));
        }
        if obj.get("version").and_then(|x| x.as_str()) != Some("capability-manifest/1") {
            return Err(Error::msg(format!(
                "error[E-EXT-002]: extension `{}` manifest version must be capability-manifest/1",
                e.name
            )));
        }
        for k in [
            "id",
            "kind",
            "adapterVersion",
            "engine",
            "runtime",
            "capabilities",
        ] {
            if obj.get(k).is_none() {
                return Err(Error::msg(format!(
                    "error[E-EXT-002]: extension `{}` manifest is missing `{k}`",
                    e.name
                )));
            }
        }
        for c in obj["capabilities"].as_array().cloned().unwrap_or_default() {
            let support = c["support"].as_str().unwrap_or("");
            if support != "unsupported" && c["evidence"].as_array().is_none_or(|a| a.is_empty()) {
                return Err(Error::msg(format!(
                    "error[E-EXT-002]: extension `{}` claims `{}` as {support} without evidence references (no self-certification)",
                    e.name, c["id"]
                )));
            }
        }
    }
    Ok(())
}

/// Build identity per specs/language/identity.md: package IR content, dependency
/// hashes, and the compiler version. No timestamps or machine paths.
pub fn build_hash(ir: &DomainIR, deps: &[(String, DomainIR)], selected: &[DomainIR]) -> String {
    use std::fmt::Write;
    let mut material = String::new();
    let _ = write!(
        material,
        "compiler={COMPILER_VERSION};ir={};",
        ir.content_hash()
    );
    for (name, d) in deps {
        let _ = write!(material, "dep:{name}={};", d.content_hash());
    }
    for ir in selected {
        let _ = write!(
            material,
            "deploy:{}={};",
            ir.package.name,
            ir.content_hash()
        );
    }
    forgegraph_semantic::ir::hash_hex(&material)
}

/// What `forgec build` writes, relative to the output directory, in write order.
pub struct Artifacts {
    pub files: Vec<(String, String)>,
    /// Non-fatal problems, already formatted as `warning[...]` lines.
    pub warnings: Vec<String>,
}

/// Render every generated artifact for a planned package.
pub fn artifacts(
    loaded: &Loaded,
    ir: &DomainIR,
    plans: &Plans,
    service_id: Option<String>,
    source_revision: Option<&str>,
) -> Artifacts {
    let pretty = |v: &Value| serde_json::to_string_pretty(v).expect("JSON value serializes");
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    let hash = build_hash(ir, &loaded.deps, &loaded.selected);
    let openapi = crate::openapi(&plans.contracts, &plans.observability);
    let mut bundle = json!({
        "version": "app-bundle/1",
        "buildHash": hash,
        "digests": ir.digests(),
        "ir": ir,
        "contracts": plans.contracts,
        "sql": plans.sql,
        "dynamo": plans.dynamo,
        "ui": plans.ui,
        "messaging": plans.messaging,
        "workflows": plans.workflows,
        "schedules": plans.schedules,
        "realtime": plans.realtime,
        "observability": plans.observability,
        "dataSemantics": forgegraph_semantic::ir::DataSemantics::of(ir, &forgegraph_semantic::ir::Taxonomy::core()),
        "lineage": forgegraph_semantic::ir::Lineage::of(ir),
        "capabilities": forgegraph_semantic::ir::EffectiveCapabilities::of(ir),
        // Served at /forge/openapi.json by every host: the runtime is a consumer of the projection, not its author.
        "openapi": openapi,
    });
    let source_map = loaded
        .compilation
        .source_map(&hash, COMPILER_VERSION, source_revision);
    files.push(("source-map.json".into(), pretty(&source_map)));
    if !loaded.selected.is_empty() {
        bundle["deployment"] = json!({
            "version": "package-assembly/1",
            "packages": std::iter::once(ir).chain(&loaded.selected).map(|d| json!({ "package": d.package, "imports": d.imports })).collect::<Vec<_>>()
        });
    }
    files.push(("app.json".into(), pretty(&bundle)));
    files.push((
        "d1/0001_init.sql".into(),
        forgegraph_planner::sql::render_sqlite(&plans.sql),
    ));
    files.push((
        "postgres/0001_init.sql".into(),
        forgegraph_planner::sql::render_postgres(&plans.sql),
    ));
    files.push(("client.ts".into(), crate::client_ts(&plans.contracts)));
    files.push(("openapi.json".into(), pretty(&openapi)));
    // ForgeGraph's registry format, the same projection as openapi.json (`fg contract publish`).
    let contract_options = crate::contract_ir::EmitOptions {
        package: ir.package.name.clone(),
        service_id,
    };
    match crate::contract_ir::emit(&openapi, &contract_options) {
        Ok(contract) => files.push(("contract.json".into(), pretty(&contract) + "\n")),
        Err(e) => warnings.push(format!(
            "warning[W-CONTRACT-001]: contract.json not written: {e}"
        )),
    }
    files.push(("api.smithy".into(), crate::smithy(&plans.contracts)));
    files.push((
        "README.md".into(),
        "Generated by `forgec build`; disposable, do not edit.\n".into(),
    ));
    Artifacts { files, warnings }
}

/// `units/plan.json`: the composable-unit plan that `@forgegraph/units` bundles
/// and seals into a Closure Manifest (research, FORG-28). Written by
/// `forgec build --units`.
pub fn units_plan(loaded: &Loaded, ir: &DomainIR, plans: &Plans) -> (String, String) {
    let deps: Vec<&DomainIR> = loaded.deps.iter().map(|(_, d)| d).collect();
    let mut plan = serde_json::to_value(forgegraph_planner::units::plan(ir, &deps, plans))
        .expect("unit plan serializes");
    // Ties the sealed manifest to the app bundle it was planned from.
    plan["compiler"] = COMPILER_VERSION.into();
    plan["buildHash"] = build_hash(ir, &loaded.deps, &loaded.selected).into();
    let text = serde_json::to_string_pretty(&plan).expect("JSON value serializes") + "\n";
    ("units/plan.json".into(), text)
}
