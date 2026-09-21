//! Governance-aware migration planning (FORGE-068). Turns a semantic diff
//! plus the two built models into an ordered, phased plan: storage DDL,
//! backfills (never sized here), cache invalidation and receipt re-projection
//! for narrowed purpose surfaces, subject indexes, taxonomy reclassification,
//! grant requests/retirements, projection rebuilds and workflow drains. A new
//! sensitive field on an unscoped resource *blocks* the plan: nothing exposes
//! it automatically until it is scoped or its handling is reviewed.
use forge_semantic::diff::Report;
use serde::Serialize;
use serde_json::Value;

pub const MIGRATION_VERSION: &str = "migration-plan/1";

/// Rollout phases in execution order (see the deployment ledger).
pub const PHASES: [&str; 8] = ["preflight", "expand", "compat-release", "backfill", "verify", "traffic", "drain", "contract"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub id: String,
    pub phase: &'static str,
    pub kind: &'static str,
    pub subject: String,
    pub detail: String,
    /// True when a human decision or review must land before this step can run.
    pub requires_review: bool,
    /// True when the plan cannot proceed past this step as written.
    pub blocked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ddl: Option<Ddl>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub after: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Ddl {
    pub sqlite: String,
    pub postgres: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPlan {
    pub version: &'static str,
    pub old_build: String,
    pub new_build: String,
    pub verdict: String,
    pub blocked: bool,
    pub phases: Vec<&'static str>,
    pub steps: Vec<Step>,
    /// Facts this plan does not have and will not invent.
    pub unknown: Vec<&'static str>,
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

fn column<'a>(bundle: &'a Value, table: &str, col: &str) -> Option<&'a Value> {
    bundle["sql"]["tables"].as_array()?.iter().find(|t| t["name"] == table)?["columns"].as_array()?.iter().find(|c| c["name"] == col)
}

fn pg_type(sqlite: &str, c: &Value) -> String {
    // Mirror of sql.rs::pg_type for the migration DDL: money/decimal minor units and integers are BIGINT.
    match sqlite {
        "INTEGER" => "BIGINT".into(),
        "REAL" => "DOUBLE PRECISION".into(),
        "BLOB" => "BYTEA".into(),
        _ => if c["kind"] == "json" { "JSONB".into() } else { "TEXT".into() },
    }
}

pub fn plan_migration(report: &Report, old: &Value, new: &Value) -> MigrationPlan {
    let mut steps: Vec<Step> = Vec::new();
    let mut n = 0usize;
    let mut push = |phase: &'static str, kind: &'static str, subject: String, detail: String, requires_review: bool, blocked: bool, ddl: Option<Ddl>| {
        n += 1;
        steps.push(Step { id: format!("s{n:03}-{kind}"), phase, kind, subject, detail, requires_review, blocked, ddl, after: vec![] });
    };
    // Preflight always: verify the old build is what runs, and the new artifact verifies.
    push("preflight", "artifact.verify", report.new_build.clone(), "pull and verify the new artifact (digests, signature, schema) and confirm the deployed build is the old one".into(), false, false, None);

    for f in &report.findings {
        match f.code {
            "column-added" => {
                let (table, col) = f.subject.split_once('.').unwrap_or((&f.subject, ""));
                let ddl = column(new, table, col).map(|c| {
                    let ty = s(&c["sqlType"]);
                    let null = if c["nullable"] == Value::Bool(false) { " NOT NULL DEFAULT ''".to_string() } else { String::new() };
                    Ddl { sqlite: format!("ALTER TABLE {table} ADD COLUMN {col} {ty}{null};"), postgres: format!("ALTER TABLE {table} ADD COLUMN {col} {}{};", pg_type(&ty, c), null) }
                });
                push("expand", "storage.expand", f.subject.clone(), "additive column before the new readers deploy".into(), false, false, ddl);
            }
            "table-added" => {
                push("expand", "storage.expand", f.subject.clone(), "create the table from the new bundle's DDL before the new readers deploy".into(), false, false, None);
            }
            "column-type-changed" => {
                push("backfill", "data.rewrite", f.subject.clone(), format!("{}; run as an idempotent, resumable rewrite; the affected volume is measured by the rollout, not assumed", f.detail), true, false, None);
            }
            "field-required" => {
                push("backfill", "data.backfill", f.subject.clone(), "existing records lack a now-required value: decide the fill rule under review; the rollout measures how many rows need it".into(), true, false, None);
            }
            "column-removed" | "table-removed" => {
                let (table, col) = f.subject.split_once('.').unwrap_or((&f.subject, ""));
                let ddl = if f.code == "column-removed" { Some(Ddl { sqlite: format!("ALTER TABLE {table} DROP COLUMN {col};"), postgres: format!("ALTER TABLE {table} DROP COLUMN {col};") }) } else { Some(Ddl { sqlite: format!("DROP TABLE {table};"), postgres: format!("DROP TABLE {table};") }) };
                push("contract", "storage.contract", f.subject.clone(), "drop only after the retention decision is recorded and the old readers are drained; never automatic".into(), true, false, ddl);
            }
            "surface-narrowed" => {
                push("compat-release", "cache.invalidate", f.subject.clone(), "cached values loaded under the broader surface are re-projected under the current one on read; invalidate stored entries for this (resource, purpose)".into(), false, false, None);
                push("compat-release", "receipts.reproject", f.subject.clone(), "idempotency receipts replay through the current surface only; no stored response is disclosed as written".into(), false, false, None);
            }
            "surface-widened" | "surface-added" | "deny-removed" => {
                push("preflight", "grants.reapprove", f.subject.clone(), "new authority: dependency grants naming this surface need reapproval before activation".into(), true, false, None);
            }
            "surface-removed" | "purpose-removed" => {
                push("drain", "grants.retire", f.subject.clone(), "retire grants naming this purpose with their declared drain; invalidate caches and receipts for it".into(), true, false, None);
            }
            "subject-binding-added" => {
                push("backfill", "subject.index", f.subject.clone(), "build the subject index for existing records (resumable)".into(), false, false, None);
            }
            "subject-binding-removed" | "subject-binding-changed" => {
                push("preflight", "subject.review", f.subject.clone(), "subject rights (access/erasure) depend on this binding: review before rollout".into(), true, false, None);
            }
            "personal-field-added" => {
                let (rid, field) = f.subject.rsplit_once('.').unwrap_or((&f.subject, ""));
                let scoped = new["ir"]["modules"].as_array().into_iter().flatten().flat_map(|m| m["resources"].as_array().into_iter().flatten()).any(|r| r["id"] == rid && r["decorators"]["purposeScoped"] == Value::Bool(true));
                let mapped = new["capabilities"]["surfaces"].as_array().into_iter().flatten().any(|sf| sf["resource"] == rid && sf["allowAtoms"].as_array().into_iter().flatten().any(|a| a["verb"] == "read" && a["name"] == field));
                if !scoped {
                    push("preflight", "exposure.block", f.subject.clone(), "a new personal-data field on a resource that is not purpose-scoped would be exposed to every reader automatically; scope the resource (or downgrade the classification under review) before this rollout".into(), true, true, None);
                } else if !mapped {
                    push("preflight", "surface.map", f.subject.clone(), "the field is stored but no purpose surface grants `read` on it: it stays hidden until a surface maps it (no automatic exposure)".into(), true, false, None);
                }
            }
            "class-changed" | "handling-loosened" => {
                push("preflight", "classification.review", f.subject.clone(), f.detail.clone(), true, false, None);
            }
            "dependency-added" => {
                push("preflight", "grant.request", f.subject.clone(), "open the dependency request with the callee owners; the edge stays denied until the grant is activated".into(), true, false, None);
            }
            "dependency-removed" => {
                push("drain", "grant.retire", f.subject.clone(), "retire the grant after releases still using it drain".into(), true, false, None);
            }
            "workflow-version-bumped" => {
                push("drain", "workflow.drain", f.subject.clone(), "instances on the old version finish on the old graph; new starts use the new version".into(), false, false, None);
            }
            "graph-changed-without-version" => {
                push("preflight", "workflow.version", f.subject.clone(), "bump `version` before rollout: in-flight instances are pinned".into(), true, true, None);
            }
            "policy-changed-unknown" => {
                push("preflight", "policy.review", f.subject.clone(), "the policy change has no supported proof; treat as changed and review".into(), true, false, None);
            }
            "policy-narrowed" => {
                push("compat-release", "decision.epoch", f.subject.clone(), "bump the decision epoch so cached allows are re-decided".into(), false, false, None);
            }
            _ => {}
        }
    }
    // Taxonomy revision: every classification is recomputed under the new taxonomy before surfaces are trusted.
    let (ot, nt) = (s(&old["dataSemantics"]["taxonomy"]), s(&new["dataSemantics"]["taxonomy"]));
    if !ot.is_empty() && ot != nt {
        push("preflight", "taxonomy.reclassify", format!("{ot} -> {nt}"), "recompute field classes, subject bindings and lineage under the new taxonomy; review the classification stream of the diff".into(), true, false, None);
    }
    // Projections whose definition changed are rebuilt from their source events.
    let projections = |v: &Value| -> Vec<(String, String)> {
        v["ir"]["modules"].as_array().into_iter().flatten().flat_map(|m| m["projections"].as_array().into_iter().flatten()).map(|p| (s(&p["id"]), serde_json::to_string(p).unwrap_or_default())).collect()
    };
    let (op, np) = (projections(old), projections(new));
    for (id, def) in &np {
        match op.iter().find(|(i, _)| i == id) {
            Some((_, odef)) if odef != def => push("backfill", "projection.rebuild", id.clone(), "definition changed: rebuild from the source stream (resumable, idempotent)".into(), false, false, None),
            None => push("backfill", "projection.rebuild", id.clone(), "new projection: build from the source stream".into(), false, false, None),
            _ => {}
        }
    }
    // Verification and traffic are always part of the DAG; drain and contract only when there is something to do.
    push("verify", "verify.invariants", report.new_build.clone(), "canonical export hash, invariants and the SLO gate on the compat release; missing metrics do not pass".into(), false, false, None);
    push("traffic", "traffic.shift", report.new_build.clone(), "shift traffic by stages with the SLO gate between them".into(), false, false, None);

    // Order: phases in DAG order, stable within a phase; every step depends on the last step of the previous phase.
    let idx = |p: &str| PHASES.iter().position(|x| *x == p).unwrap_or(0);
    steps.sort_by_key(|st| idx(st.phase));
    let mut last_of_prev: Option<String> = None;
    let mut cur_phase = "";
    let mut phase_last: Option<String> = None;
    for st in steps.iter_mut() {
        if st.phase != cur_phase {
            last_of_prev = phase_last.take();
            cur_phase = st.phase;
        }
        if let Some(p) = &last_of_prev {
            st.after = vec![p.clone()];
        }
        phase_last = Some(st.id.clone());
    }
    let blocked = steps.iter().any(|st| st.blocked);
    MigrationPlan {
        version: MIGRATION_VERSION,
        old_build: report.old_build.clone(),
        new_build: report.new_build.clone(),
        verdict: report.verdict.to_string(),
        blocked,
        phases: PHASES.to_vec(),
        steps,
        unknown: vec!["affected row counts (measured during backfill, never estimated here)", "live traffic and error rates (measured by the SLO gate)", "which releases still use retiring grants (reported by the grant registry)"],
    }
}
