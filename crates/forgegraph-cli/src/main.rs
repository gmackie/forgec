//! `forge` — check, fmt, inspect. The compiler core is filesystem-free; this
//! binary is the host that loads packages and their path dependencies.

mod init;

use anyhow::{Context, Result, anyhow, bail};
use clap::{Parser, Subcommand};
use forgegraph_codegen::pipeline::{self, LockStatus, build_hash, render_lock};
use forgegraph_semantic::{DomainIR, OsTree, Package, load_package};
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
    /// Create a dependency-free Forge package in a new directory.
    Init {
        path: PathBuf,
        /// Package identity (default: @local/<directory-name>).
        #[arg(long)]
        name: Option<String>,
    },
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
        /// Validate authored business semantics against the compiled package and dependencies.
        #[arg(long, requires = "concept")]
        semantics: Option<PathBuf>,
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
    /// Compile and write generated artifacts (app bundle, D1 migration, TS client, OpenAPI, contract IR).
    Build {
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Output directory (default: `<package>/generated`).
        #[arg(long)]
        out: Option<PathBuf>,
        /// ForgeGraph app slug for `contract.json` (default: the unscoped package name).
        #[arg(long)]
        service_id: Option<String>,
        /// Also write `units/plan.json`, the composable-unit plan that `@forgegraph/units`
        /// bundles and seals into a Closure Manifest (research, FORG-28).
        #[arg(long)]
        units: bool,
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
    /// Import a ForgeGraph contract IR v1 document (`contract.json`) as a Forge package, via OpenAPI 3.1.
    ImportContract {
        contract: PathBuf,
        /// Forge package name, e.g. `@acme/billing`.
        #[arg(long)]
        package: String,
        /// Output directory for the generated package.
        #[arg(long)]
        out: PathBuf,
    },
    /// Compare two contract IR documents per operation (routes, schemas, statuses, policy). Exit 1 on differences.
    ContractDiff {
        a: PathBuf,
        b: PathBuf,
        /// Difference kinds (or dotted prefixes) that are expected and do not fail, e.g. `id`, `policy`.
        #[arg(long = "ignore")]
        ignore: Vec<String>,
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

/// Report a pipeline error the way `anyhow` would, after any dependency diagnostics it carries.
fn host<T>(result: std::result::Result<T, pipeline::Error>) -> Result<T> {
    result.map_err(|e| {
        if let Some(rendered) = e.rendered() {
            eprint!("{rendered}");
        }
        anyhow::Error::new(e)
    })
}

fn load_tree(root: &Path) -> Result<pipeline::Loaded> {
    host(pipeline::load_tree(&OsTree, root))
}

fn verify_extensions(pkg: &Package) -> Result<()> {
    host(pipeline::verify_extensions(&OsTree, pkg))
}

/// Compare an existing lock with the loaded dependency set. Missing lock: fine (warn).
fn verify_lock(root: &Path, loaded: &pipeline::Loaded) -> Result<()> {
    match pipeline::lock_status(&OsTree, root, loaded) {
        LockStatus::Current => {}
        LockStatus::Missing => {
            if !loaded.deps.is_empty() {
                eprintln!(
                    "warning[W-LOCK-001]: forge.lock is missing; run `forgec lock` to pin dependencies"
                );
            }
        }
        LockStatus::Stale => {
            eprintln!(
                "error[E-LOCK-001]: forge.lock is stale: a dependency contract or the compiler version changed; run `forgec lock` after reviewing the change"
            );
            std::process::exit(1);
        }
    }
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Init { path, name } => init::create(&path, name.as_deref())?,
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
                    serde_json::json!({"conceptHash":concept.content_hash(), "graph":concept.graph(), "invariantProducers":concept.invariant_producers(), "archetypes":concept.elaborate_archetypes().map_err(|errors| anyhow!(serde_json::to_string(&errors).unwrap()))?})
                }
                ConceptCmd::Diff { old, new } => {
                    let old = load_concept(&old)?;
                    let new = load_concept(&new)?;
                    serde_json::json!({"before":old.content_hash(), "after":new.content_hash(), "changes":old.semantic_changes(&new), "archetypeChanges":old.archetype_changes(&new)})
                }
            };
            println!("{}", serde_json::to_string_pretty(&value)?);
        }
        Cmd::Check {
            path,
            concept_contract,
        } => {
            let loaded = load_tree(&path)?;
            verify_lock(&path, &loaded)?;
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
        Cmd::Build {
            path,
            out,
            service_id,
            units,
        } => {
            if let Some(id) = &service_id
                && !forgegraph_codegen::contract_ir::emit::is_identifier(id)
            {
                bail!(
                    "--service-id `{id}` is not an identifier (letters, digits, _ and -, starting with a letter)"
                );
            }
            let loaded = load_tree(&path)?;
            verify_extensions(&loaded.package)?;
            verify_lock(&path, &loaded)?;
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
            let artifacts = pipeline::artifacts(
                &loaded,
                ir,
                &plans,
                service_id,
                std::env::var("FORGE_SOURCE_REVISION").ok().as_deref(),
            );
            let mut files = artifacts.files;
            if units {
                files.push(pipeline::units_plan(&loaded, ir, &plans));
            }
            for (rel, content) in &files {
                let target = out_dir.join(rel);
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(target, content)?;
            }
            for warning in &artifacts.warnings {
                eprintln!("{warning}");
            }
            println!("{}: wrote {}", loaded.package.name, out_dir.display());
        }
        Cmd::Lock { path } => {
            let loaded = load_tree(&path)?;
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
            let loaded = load_tree(&path)?;
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
        Cmd::ImportContract {
            contract,
            package,
            out,
        } => {
            let text = std::fs::read_to_string(&contract)?;
            let opts = forgegraph_codegen::openapi_import::ImportOptions {
                package,
                ..Default::default()
            };
            match forgegraph_codegen::contract_ir::import_contract(&text, &opts) {
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
                        "{}: imported {} operations ({} skipped), {} unsupported features, {} foreign identifiers -> {}",
                        r.package,
                        r.operations.len(),
                        r.skipped_operations.len(),
                        r.unsupported.len(),
                        r.foreign_identifiers.len(),
                        out.display()
                    );
                    if !r.unsupported.is_empty() || !r.skipped_operations.is_empty() {
                        eprintln!("review {}", out.join("import-report.json").display());
                    }
                }
                Err(e) => {
                    eprintln!("import refused: {e}");
                    std::process::exit(1);
                }
            }
        }
        Cmd::ContractDiff { a, b, ignore } => {
            let read = |p: &Path| -> Result<serde_json::Value> {
                serde_json::from_str(&std::fs::read_to_string(p)?)
                    .with_context(|| format!("{} is not JSON", p.display()))
            };
            let report = forgegraph_codegen::contract_ir::diff(&read(&a)?, &read(&b)?, &ignore);
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.is_clean() {
                std::process::exit(1);
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
            let loaded = load_tree(&path)?;
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
            semantics,
            focus,
            hops,
            relations,
        } => {
            let loaded = load_tree(&path)?;
            eprint!("{}", loaded.compilation.render());
            let Some(ir) = loaded.compilation.ir else {
                std::process::exit(1)
            };
            if concept {
                let projection = if let Some(path) = semantics {
                    let semantics = serde_json::from_slice(
                        &std::fs::read(&path)
                            .with_context(|| format!("reading {}", path.display()))?,
                    )?;
                    let dependencies = loaded
                        .deps
                        .iter()
                        .map(|(_, ir)| ir.clone())
                        .collect::<Vec<_>>();
                    let assembled = forgegraph_semantic::assembly::assemble(&ir, &dependencies)
                        .map_err(|e| anyhow!(e))?;
                    forgegraph_semantic::concept::project_with_semantics(&assembled, &semantics)
                        .map_err(|errors| anyhow!(serde_json::to_string_pretty(&errors).unwrap()))?
                } else {
                    forgegraph_semantic::concept::project(&ir)
                };
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
