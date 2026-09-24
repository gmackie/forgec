//! `forge` — check, fmt, inspect. The compiler core is filesystem-free; this
//! binary is the host that loads packages and their path dependencies.

use anyhow::{Context, Result, anyhow, bail};
use clap::{Parser, Subcommand};
use forgegraph_semantic::{Compilation, DomainIR, Package, compile, load_package};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Parser)]
#[command(
    name = "forgec",
    version,
    about = "ForgeGraph compiler: one .forge package, equivalent behaviour on Cloudflare, AWS and Node"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Validate, inspect, or compare explicit business-semantic contracts.
    Concept {
        #[command(subcommand)]
        command: ConceptCmd,
    },
    /// Parse, resolve and check a package and its dependencies.
    Check {
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Require a ConceptIR JSON contract; unproven requirements also fail.
        #[arg(long)]
        concept_contract: Option<PathBuf>,
    },
    /// Format every `.forge` file in a package.
    Fmt {
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Exit 1 if any file would change; write nothing.
        #[arg(long)]
        check: bool,
    },
    /// Print the package's DomainIR, or its partial business ConceptIR, as JSON.
    Inspect {
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Project business semantics without runtime/provider details.
        #[arg(long)]
        concept: bool,
        /// Limit the concept graph to a neighborhood of this semantic ID.
        #[arg(long, requires = "concept")]
        focus: Option<String>,
        /// Maximum graph distance from --focus.
        #[arg(long, requires = "focus", default_value_t = 1)]
        hops: usize,
        /// Relation kinds to include in the focused graph (comma separated).
        #[arg(long, requires = "focus", value_delimiter = ',')]
        relations: Vec<String>,
    },
    /// Compile and write generated artifacts (app bundle, D1 migration, TS client).
    Build {
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Output directory (default: `<package>/generated`).
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Write `forge.lock`, pinning dependency contracts and the compiler version.
    Lock {
        #[arg(default_value = ".")]
        path: PathBuf,
    },
    /// Semantic diff between two built bundles (API, interfaces, event, storage, lifecycle, workflow,
    /// classification, governance, dependencies, policy streams). Exit 1 on breaking findings.
    Compat {
        old: PathBuf,
        new: PathBuf,
        /// Render Markdown for an audience instead of JSON: pr | changelog | security.
        #[arg(long)]
        report: Option<String>,
    },
    /// Import a vendor OpenAPI 3.x document (JSON) as a Forge package: pinned refs only, no fetching.
    ImportOpenapi {
        spec: PathBuf,
        /// Forge package name, e.g. `@vendor/billing`.
        #[arg(long)]
        package: String,
        /// Output directory for the generated package.
        #[arg(long)]
        out: PathBuf,
        /// Pin a remote `$ref` URL to a local file: `URL=FILE` or `URL=FILE@SHA256`.
        #[arg(long = "pin")]
        pins: Vec<String>,
        /// Hosts that servers/callbacks may name (repeatable). Empty allows any public host.
        #[arg(long = "allow-host")]
        allow_hosts: Vec<String>,
    },
    /// Governance-aware migration plan between two built bundles (phased DAG; blocked steps named).
    Migrate { old: PathBuf, new: PathBuf },
    /// Edition upgrade proposals (2026 -> 2027): explicit, minimal, never applied automatically.
    UpgradeEdition {
        #[arg(default_value = ".")]
        path: PathBuf,
    },
    /// Language server over stdio (diagnostics, formatting).
    Lsp,
    /// Explain the effective purpose surface of a resource: every granted and denied atom with its origin.
    Explain {
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Resource name (e.g. `Contact`); omit to list every surface.
        #[arg(long)]
        resource: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum ConceptCmd {
    /// Validate an explicit ConceptIR file. This does not prove its implementation.
    Check {
        path: PathBuf,
        /// Require all type and activation references and external port types to resolve.
        #[arg(long)]
        closed: bool,
    },
    /// Validate recorded engagement membership, bounds, and parent links.
    CheckEngagements { path: PathBuf, snapshot: PathBuf },
    /// Explain effective external constraints; applicability predicates remain unevaluated.
    ExplainConstraints {
        path: PathBuf,
        process: String,
        #[arg(long, allow_hyphen_values = true)]
        at: i64,
    },
    /// Check supplied trace reconstruction evidence against a ConceptIR requirement.
    CheckTrace { path: PathBuf, witness: PathBuf },
    /// Validate exact registry references for supplied L1 artifacts (not implementation proof).
    CheckRegistryRealizations { path: PathBuf, references: PathBuf },
    /// Inspect the semantic graph and invariant producer responsibilities.
    Inspect { path: PathBuf },
    /// Compare semantic declarations independently of implementation choices.
    Diff { old: PathBuf, new: PathBuf },
}
fn load_concept(path: &Path) -> Result<forgegraph_semantic::concept::ConceptIR> {
    let value = serde_json::from_slice(&std::fs::read(path)?)?;
    forgegraph_semantic::concept::ConceptIR::load(&value)
        .map_err(|e| anyhow!("invalid ConceptIR {}: {e}", path.display()))
}

mod lsp;

/// `forge.lock` content. Dependencies are pinned by name, version and the
/// content hash of their compiled contract, so a changed upstream contract is
/// detected even when its version string is not bumped.
fn render_lock(deps: &[(String, DomainIR)], selected: &[DomainIR]) -> String {
    let mut s = String::from("# Generated by `forgec lock`; do not edit.\nlock = 1\n");
    s.push_str(&format!("compiler = \"{}\"\n", env!("CARGO_PKG_VERSION")));
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

/// Compare an existing lock with the loaded dependency set. Missing lock: fine (warn).
fn verify_lock(root: &Path, deps: &[(String, DomainIR)], selected: &[DomainIR]) -> Result<()> {
    let path = root.join("forge.lock");
    let Ok(existing) = std::fs::read_to_string(&path) else {
        if !deps.is_empty() {
            eprintln!(
                "warning[W-LOCK-001]: forge.lock is missing; run `forgec lock` to pin dependencies"
            );
        }
        return Ok(());
    };
    let expected = render_lock(deps, selected);
    if existing != expected {
        eprintln!(
            "error[E-LOCK-001]: forge.lock is stale: a dependency contract or the compiler version changed; run `forgec lock` after reviewing the change"
        );
        std::process::exit(1);
    }
    Ok(())
}

struct Loaded {
    package: Package,
    compilation: Compilation,
    /// Dependencies in topological order (name, ir).
    deps: Vec<(String, DomainIR)>,
    selected: Vec<DomainIR>,
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
fn load_tree(
    root: &Path,
    seen: &mut BTreeMap<PathBuf, CachedPackage>,
    stack: &mut Vec<PathBuf>,
) -> Result<Loaded> {
    let canon = root
        .canonicalize()
        .with_context(|| format!("{}", root.display()))?;
    if stack.contains(&canon) {
        bail!("dependency cycle through {}", canon.display());
    }
    stack.push(canon.clone());
    let package = load_package(&canon).map_err(|e| anyhow!("{e}"))?;
    verify_extensions(&package)?;
    let mut deps = BTreeMap::<String, DomainIR>::new();
    let mut dep_irs = Vec::new();
    let mut selected = BTreeMap::<String, DomainIR>::new();
    for (alias, path) in &package.dependency_paths {
        let dep_canon = path
            .canonicalize()
            .with_context(|| format!("dependency `{alias}` at {}", path.display()))?;
        let cached = match seen.get(&dep_canon) {
            Some(cached) => cached.clone(),
            None => {
                let loaded = load_tree(&dep_canon, seen, stack)?;
                let rendered = loaded.compilation.render();
                let Some(ir) = loaded.raw_ir else {
                    eprint!("{rendered}");
                    bail!("dependency `{}` has errors", loaded.package.name);
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
                bail!("E-ASSEMBLY-001: conflicting dependency package identity `{name}`");
            }
        }
        if package.deployed_dependencies.contains(alias) {
            if cached.has_extensions {
                bail!(
                    "E-ASSEMBLY-005: co-deployed dependency `{alias}` uses extensions; extension pin assembly is not yet supported"
                );
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
            bail!("E-ASSEMBLY-005: extensions in an assembled deployment are not yet supported");
        }
        let assembled =
            forgegraph_semantic::assembly::assemble(ir, &selected).map_err(|e| anyhow!(e))?;
        if !selected.is_empty() {
            forgegraph_planner::plan(&assembled).map_err(|e| anyhow!(e))?;
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

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Concept { command } => {
            let value = match command {
                ConceptCmd::Check { path, closed } => {
                    let concept = load_concept(&path)?;
                    if closed {
                        let errors = concept.validate_closed();
                        if !errors.is_empty() {
                            return Err(anyhow!(serde_json::to_string(&errors)?));
                        }
                    }
                    serde_json::json!({"valid":true, "conceptHash":concept.content_hash(), "implementationProven":false})
                }
                ConceptCmd::CheckEngagements { path, snapshot } => {
                    let concept = load_concept(&path)?;
                    let records = serde_json::from_slice(&std::fs::read(snapshot)?)?;
                    let errors = concept.check_engagement_snapshot(&records);
                    if !errors.is_empty() {
                        return Err(anyhow!(serde_json::to_string(&errors)?));
                    }
                    serde_json::json!({"valid":true,"conceptHash":concept.content_hash(),"scope":"supplied-engagement-snapshot","implementationProven":false})
                }
                ConceptCmd::ExplainConstraints { path, process, at } => {
                    let concept = load_concept(&path)?;
                    if !concept.processes.contains_key(&process) {
                        return Err(anyhow!("unknown process {process}"));
                    }
                    serde_json::json!({"conceptHash":concept.content_hash(),"applicabilityEvaluated":false,"constraints":concept.external_constraints_for(&process, at)})
                }
                ConceptCmd::CheckTrace { path, witness } => {
                    let concept = load_concept(&path)?;
                    let witness = serde_json::from_slice(&std::fs::read(witness)?)?;
                    let errors = concept.check_trace_witness(&witness);
                    if !errors.is_empty() {
                        return Err(anyhow!(serde_json::to_string(&errors)?));
                    }
                    serde_json::json!({"valid":true,"conceptHash":concept.content_hash(),"scope":"supplied-trace-witness","applicabilityEvaluated":false,"implementationProven":false})
                }
                ConceptCmd::CheckRegistryRealizations { path, references } => {
                    let concept = load_concept(&path)?;
                    let references = serde_json::from_slice::<
                        Vec<forgegraph_semantic::concept_registry::RegistryRealization>,
                    >(&std::fs::read(references)?)?;
                    let errors = concept.check_registry_realizations(&references);
                    if !errors.is_empty() {
                        return Err(anyhow!(serde_json::to_string(&errors)?));
                    }
                    serde_json::json!({"valid":true,"scope":"registry-references","implementationProven":false})
                }
                ConceptCmd::Inspect { path } => {
                    let concept = load_concept(&path)?;
                    serde_json::json!({"conceptHash":concept.content_hash(), "graph":concept.graph(), "invariantProducers":concept.invariant_producers()})
                }
                ConceptCmd::Diff { old, new } => {
                    let old = load_concept(&old)?;
                    let new = load_concept(&new)?;
                    serde_json::json!({"before":old.content_hash(), "after":new.content_hash(), "changes":old.semantic_changes(&new)})
                }
            };
            println!("{}", serde_json::to_string_pretty(&value)?);
        }
        Cmd::Check {
            path,
            concept_contract,
        } => {
            let loaded = load_tree(&path, &mut BTreeMap::new(), &mut Vec::new())?;
            verify_lock(&path, &loaded.deps, &loaded.selected)?;
            verify_extensions(&loaded.package)?;
            eprint!("{}", loaded.compilation.render());
            let errors = loaded
                .compilation
                .diagnostics
                .iter()
                .filter(|d| d.is_error())
                .count();
            let warnings = loaded.compilation.diagnostics.len() - errors;
            if errors > 0 {
                eprintln!(
                    "{}: {errors} error(s), {warnings} warning(s)",
                    loaded.package.name
                );
                std::process::exit(1);
            }
            if let Some(contract_path) = concept_contract {
                let value = serde_json::from_slice(&std::fs::read(&contract_path)?)?;
                let contract = forgegraph_semantic::concept::ConceptIR::load(&value)
                    .map_err(|e| anyhow!("invalid ConceptIR contract: {e}"))?;
                let ir = loaded
                    .compilation
                    .ir
                    .as_ref()
                    .ok_or_else(|| anyhow!("missing compiled IR"))?;
                let report = contract.realization_report(ir);
                println!("{}", serde_json::to_string_pretty(&report)?);
                if !report.is_satisfied() {
                    std::process::exit(1);
                }
                return Ok(());
            }
            println!(
                "{}: ok ({} file(s), {} dependency(ies), {warnings} warning(s))",
                loaded.package.name,
                loaded.package.files.len(),
                loaded.deps.len()
            );
        }
        Cmd::Fmt { path, check } => {
            let package = load_package(&path).map_err(|e| anyhow!("{e}"))?;
            let mut changed = Vec::new();
            for f in &package.files {
                let parsed = forgegraph_syntax::parse(&f.text);
                if !parsed.errors().is_empty() {
                    eprintln!("{}: skipped (syntax errors)", f.path);
                    continue;
                }
                let formatted = forgegraph_syntax::format(&parsed);
                if formatted != f.text {
                    changed.push(f.path.clone());
                    if !check {
                        std::fs::write(path.join(&f.path), formatted)?;
                    }
                }
            }
            for c in &changed {
                println!("{c}");
            }
            if check && !changed.is_empty() {
                std::process::exit(1);
            }
        }
        Cmd::Build { path, out } => {
            let loaded = load_tree(&path, &mut BTreeMap::new(), &mut Vec::new())?;
            verify_extensions(&loaded.package)?;
            verify_lock(&path, &loaded.deps, &loaded.selected)?;
            eprint!("{}", loaded.compilation.render());
            let Some(ir) = loaded.compilation.ir.as_ref() else {
                std::process::exit(1)
            };
            let plans = match forgegraph_planner::plan(ir) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(1);
                }
            };
            let out_dir = out.unwrap_or_else(|| path.join("generated"));
            std::fs::create_dir_all(out_dir.join("d1"))?;
            let openapi = forgegraph_codegen::openapi(&plans.contracts, &plans.observability);
            let mut bundle = serde_json::json!({
                "version": "app-bundle/1",
                "buildHash": build_hash(ir, &loaded.deps, &loaded.selected),
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
            let source_map = loaded.compilation.source_map(
                &build_hash(ir, &loaded.deps, &loaded.selected),
                env!("CARGO_PKG_VERSION"),
                std::env::var("FORGE_SOURCE_REVISION").ok().as_deref(),
            );
            std::fs::write(
                out_dir.join("source-map.json"),
                serde_json::to_string_pretty(&source_map)?,
            )?;
            if !loaded.selected.is_empty() {
                bundle["deployment"] = serde_json::json!({
                    "version": "package-assembly/1",
                    "packages": std::iter::once(ir).chain(&loaded.selected).map(|d| serde_json::json!({ "package": d.package, "imports": d.imports })).collect::<Vec<_>>()
                });
            }
            std::fs::write(
                out_dir.join("app.json"),
                serde_json::to_string_pretty(&bundle)?,
            )?;
            std::fs::write(
                out_dir.join("d1/0001_init.sql"),
                forgegraph_planner::sql::render_sqlite(&plans.sql),
            )?;
            std::fs::create_dir_all(out_dir.join("postgres"))?;
            std::fs::write(
                out_dir.join("postgres/0001_init.sql"),
                forgegraph_planner::sql::render_postgres(&plans.sql),
            )?;
            std::fs::write(
                out_dir.join("client.ts"),
                forgegraph_codegen::client_ts(&plans.contracts),
            )?;
            std::fs::write(
                out_dir.join("openapi.json"),
                serde_json::to_string_pretty(&openapi)?,
            )?;
            std::fs::write(
                out_dir.join("api.smithy"),
                forgegraph_codegen::smithy(&plans.contracts),
            )?;
            std::fs::write(
                out_dir.join("README.md"),
                "Generated by `forgec build`; disposable, do not edit.\n",
            )?;
            println!("{}: wrote {}", loaded.package.name, out_dir.display());
        }
        Cmd::Lock { path } => {
            let loaded = load_tree(&path, &mut BTreeMap::new(), &mut Vec::new())?;
            std::fs::write(
                path.join("forge.lock"),
                render_lock(&loaded.deps, &loaded.selected),
            )?;
            println!(
                "{}: wrote forge.lock ({} dependency(ies))",
                loaded.package.name,
                loaded.deps.len()
            );
        }
        Cmd::Explain {
            path,
            resource,
            json,
        } => {
            let loaded = load_tree(&path, &mut BTreeMap::new(), &mut Vec::new())?;
            eprint!("{}", loaded.compilation.render());
            let Some(ir) = loaded.compilation.ir else {
                std::process::exit(1)
            };
            let caps = forgegraph_semantic::ir::EffectiveCapabilities::of(&ir);
            let surfaces: Vec<&forgegraph_semantic::ir::Surface> = caps
                .surfaces
                .iter()
                .filter(|s| {
                    resource
                        .as_ref()
                        .is_none_or(|r| s.resource.ends_with(&format!("/{r}")))
                })
                .collect();
            if json {
                println!("{}", serde_json::to_string_pretty(&surfaces)?);
            } else {
                for s in surfaces {
                    println!(
                        "{} for {} (digest {}) via {}",
                        s.resource,
                        s.purpose,
                        &s.digest[..12],
                        s.capabilities.join(" + ")
                    );
                    for a in &s.allow_atoms {
                        println!(
                            "  allow {:<8} {:<24} from {}",
                            a.verb,
                            a.name,
                            a.origin.join(" > ")
                        );
                    }
                    for d in &s.deny {
                        println!(
                            "  deny  {:<8} {:<24} from {}",
                            d.verb,
                            d.name,
                            d.origin.join(" > ")
                        );
                    }
                }
            }
        }
        Cmd::ImportOpenapi {
            spec,
            package,
            out,
            pins,
            allow_hosts,
        } => {
            let text = std::fs::read_to_string(&spec)?;
            let mut opts = forgegraph_codegen::openapi_import::ImportOptions {
                package,
                allow_hosts,
                pins: Vec::new(),
            };
            for p in pins {
                let (url, rest) = p
                    .split_once('=')
                    .ok_or_else(|| anyhow::anyhow!("--pin expects URL=FILE[@SHA256], got {p}"))?;
                let (file, sha) = rest
                    .rsplit_once('@')
                    .map(|(f, s)| (f.to_string(), Some(s.to_string())))
                    .unwrap_or((rest.to_string(), None));
                opts.pins.push(forgegraph_codegen::openapi_import::Pin {
                    url: url.to_string(),
                    file: PathBuf::from(file),
                    sha256: sha,
                });
            }
            match forgegraph_codegen::openapi_import::import_openapi(&text, &opts) {
                Ok(result) => {
                    for (rel, content) in &result.files {
                        let target = out.join(rel);
                        if let Some(parent) = target.parent() {
                            std::fs::create_dir_all(parent)?;
                        }
                        std::fs::write(target, content)?;
                    }
                    let r = &result.report;
                    eprintln!(
                        "{}: imported {} operations ({} skipped), {} unsupported features, {} foreign identifiers, {} callbacks/webhooks -> {}",
                        r.package,
                        r.operations.len(),
                        r.skipped_operations.len(),
                        r.unsupported.len(),
                        r.foreign_identifiers.len(),
                        r.callbacks.len(),
                        out.display()
                    );
                    if !r.unsupported.is_empty() || !r.foreign_identifiers.is_empty() {
                        eprintln!(
                            "review {} and {}",
                            out.join("import-report.json").display(),
                            out.join("FOREIGN_IDS.md").display()
                        );
                    }
                }
                Err(e) => {
                    eprintln!("import refused: {e}");
                    std::process::exit(1);
                }
            }
        }
        Cmd::Migrate { old, new } => {
            let o: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&old)?)?;
            let n: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&new)?)?;
            for (label, v) in [("old", &o), ("new", &n)] {
                if let Err(e) = DomainIR::load(&v["ir"]) {
                    bail!("{label} bundle: {e}");
                }
            }
            let report = forgegraph_semantic::diff::compare(&o, &n);
            let plan = forgegraph_planner::migrations::plan_migration(&report, &o, &n);
            println!("{}", serde_json::to_string_pretty(&plan)?);
            if plan.blocked {
                std::process::exit(2);
            }
        }
        Cmd::UpgradeEdition { path } => {
            // PAR-178: a proposal per resource that governance would touch; the package's edition stays what it
            // is until the author applies the proposals, and nothing here writes source, grants or schema.
            let loaded = load_tree(&path, &mut BTreeMap::new(), &mut Vec::new())?;
            eprint!("{}", loaded.compilation.render());
            let Some(ir) = loaded.compilation.ir else {
                std::process::exit(1)
            };
            let sem = forgegraph_semantic::ir::DataSemantics::of(
                &ir,
                &forgegraph_semantic::ir::Taxonomy::core(),
            );
            let mut proposals = Vec::new();
            for m in &ir.modules {
                for r in &m.resources {
                    if r.decorators.purpose_scoped {
                        continue;
                    }
                    let personal: Vec<String> = sem
                        .fields
                        .iter()
                        .filter(|f| f.resource == r.id && f.personal != "no")
                        .map(|f| format!("{} ({}, {})", f.field, f.class, f.handling))
                        .collect();
                    let structural: Vec<String> = sem
                        .fields
                        .iter()
                        .filter(|f| {
                            f.resource == r.id && f.personal == "no" && f.class == "data.structural"
                        })
                        .map(|f| f.field.clone())
                        .collect();
                    proposals.push(serde_json::json!({
                        "resource": r.id,
                        "kind": if personal.is_empty() { "optional" } else { "recommended" },
                        "personalFields": personal,
                        "proposal": {
                            "decorators": ["@purposeScoped"],
                            "capability": { "name": "Minimal", "read": structural.iter().filter(|f| *f == "id").cloned().collect::<Vec<_>>(), "note": "structural identity only; every personal field needs an explicit capability atom and a reviewed purpose binding" },
                            "purposeBinding": "for <Purpose> { use Minimal }  -- declare the purpose in the package; taxonomy relationships grant nothing",
                            "subject": if personal.is_empty() { serde_json::Value::Null } else { serde_json::json!("@subject(person) or @subject(from: <field>) if this resource belongs to a person") }
                        },
                        "grants": "none: no dependency grant is proposed or created; edges stay requests until reviewed",
                        "storage": "none: no schema change; purpose scoping is enforced at read/write time",
                        "reviewRequired": true
                    }));
                }
            }
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "version": "edition-upgrade/1",
                    "package": ir.package.name,
                    "currentEdition": ir.package.edition,
                    "targetEdition": "2027",
                    "status": if ir.package.edition == "2027" { "already on edition 2027" } else { "proposals only: the package stays on its current edition until forge.toml is changed and the proposals are applied by hand" },
                    "proposals": proposals,
                    "appliesAutomatically": false
                }))?
            );
        }
        Cmd::Lsp => lsp::run()?,
        Cmd::Compat {
            old,
            new,
            report: audience,
        } => {
            let o: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&old)?)?;
            let n: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&new)?)?;
            // Fail closed on artifacts this build cannot interpret (plan §4.2).
            for (label, v) in [("old", &o), ("new", &n)] {
                if let Err(e) = DomainIR::load(&v["ir"]) {
                    bail!("{label} bundle: {e}");
                }
            }
            let report = forgegraph_semantic::diff::compare(&o, &n);
            match audience {
                Some(a) => print!("{}", forgegraph_semantic::diff::render(&report, &a)),
                None => println!("{}", serde_json::to_string_pretty(&report)?),
            }
            if report.verdict == "breaking" {
                std::process::exit(1);
            }
        }
        Cmd::Inspect {
            path,
            concept,
            focus,
            hops,
            relations,
        } => {
            let loaded = load_tree(&path, &mut BTreeMap::new(), &mut Vec::new())?;
            eprint!("{}", loaded.compilation.render());
            let Some(ir) = loaded.compilation.ir else {
                std::process::exit(1)
            };
            if concept {
                let projection = forgegraph_semantic::concept::project(&ir);
                let graph = projection.concept.graph();
                let graph = match focus {
                    Some(anchor) => {
                        if !graph.nodes.contains_key(&anchor) {
                            return Err(anyhow!("unknown concept graph anchor `{anchor}`"));
                        }
                        graph.scoped(&anchor, hops, &relations.into_iter().collect())
                    }
                    None => graph,
                };
                println!(
                    "{}",
                    serde_json::to_string_pretty(
                        &serde_json::json!({"conceptHash": projection.concept.content_hash(), "graph": graph, "projection": projection})
                    )?
                );
                return Ok(());
            }
            let out = serde_json::json!({
                "buildHash": build_hash(&ir, &loaded.deps, &loaded.selected),
                "digests": ir.digests(),
                "dependencies": loaded.deps.iter().map(|(name, d)| serde_json::json!({ "package": name, "hash": d.content_hash() })).collect::<Vec<_>>(),
                "ir": ir,
            });
            println!("{}", serde_json::to_string_pretty(&out)?);
        }
    }
    Ok(())
}

/// FORGE-030: pinned extension manifests are read as bytes, digest-checked and shape-validated.
/// They declare capabilities; nothing in them is ever executed by the compiler.
fn verify_extensions(pkg: &forgegraph_semantic::Package) -> Result<()> {
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
        let bytes = std::fs::read(&e.manifest)
            .with_context(|| format!("extension `{}`: {}", e.name, e.manifest.display()))?;
        let digest = {
            use sha2::Digest;
            hex::encode(sha2::Sha256::digest(&bytes))
        };
        if digest != e.sha256.trim_start_matches("sha256:") {
            bail!(
                "error[E-EXT-001]: extension `{}` manifest digest {digest} does not match the pinned {}; review the change and re-pin",
                e.name,
                e.sha256
            );
        }
        let v: serde_json::Value = serde_json::from_slice(&bytes).with_context(|| {
            format!(
                "error[E-EXT-002]: extension `{}` manifest is not JSON",
                e.name
            )
        })?;
        let Some(obj) = v.as_object() else {
            bail!(
                "error[E-EXT-002]: extension `{}` manifest must be an object",
                e.name
            )
        };
        if let Some(k) = obj.keys().find(|k| FORBIDDEN.contains(&k.as_str())) {
            bail!(
                "error[E-EXT-002]: extension `{}` manifest carries an executable entry `{k}`; manifests declare capabilities and never run",
                e.name
            );
        }
        if obj.get("version").and_then(|x| x.as_str()) != Some("capability-manifest/1") {
            bail!(
                "error[E-EXT-002]: extension `{}` manifest version must be capability-manifest/1",
                e.name
            );
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
                bail!(
                    "error[E-EXT-002]: extension `{}` manifest is missing `{k}`",
                    e.name
                );
            }
        }
        for c in obj["capabilities"].as_array().cloned().unwrap_or_default() {
            let support = c["support"].as_str().unwrap_or("");
            if support != "unsupported" && c["evidence"].as_array().is_none_or(|a| a.is_empty()) {
                bail!(
                    "error[E-EXT-002]: extension `{}` claims `{}` as {support} without evidence references (no self-certification)",
                    e.name,
                    c["id"]
                );
            }
        }
    }
    Ok(())
}

/// Build identity per specs/language/identity.md: package IR content, dependency
/// hashes, and the compiler version. No timestamps or machine paths.
fn build_hash(ir: &DomainIR, deps: &[(String, DomainIR)], selected: &[DomainIR]) -> String {
    use std::fmt::Write;
    let mut material = String::new();
    let _ = write!(
        material,
        "compiler={};ir={};",
        env!("CARGO_PKG_VERSION"),
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
