//! ObservabilityIR (plan §20): one telemetry entry per logical operation,
//! generated or handwritten, with bounded dimensions, SLI classification
//! policy, histogram boundaries that include the exact SLO thresholds, and
//! vendor-neutral SLO descriptors. Hosts only format (Workers Logs JSON,
//! CloudWatch EMF); nothing here is provider-specific.
use forge_semantic::ir::*;
use serde::Serialize;

pub const OBSERVABILITY_VERSION: &str = "observability/1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservabilityPlan {
    pub version: String,
    /// The only labels an operation event may carry as metric dimensions.
    pub dimensions: Vec<String>,
    pub classification: Classification,
    pub window: String,
    pub operations: Vec<OperationTelemetry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Classification {
    pub good: String,
    pub excluded: String,
    pub bad: String,
    pub business: String,
    pub counting: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationTelemetry {
    pub operation: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    pub class: String,
    pub slo: Slo,
    pub histogram_boundaries_ms: Vec<u32>,
    /// Declared domain errors (served, counted as business outcomes).
    pub business_errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Slo {
    pub availability: String,
    pub latency_good: String,
    pub latency_within_ms: u32,
    pub window: String,
}

const BASE_BOUNDARIES: &[u32] = &[5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

fn duration_ms(d: &str) -> Option<u32> {
    let (n, unit) = d
        .trim()
        .split_at(d.trim().find(|c: char| !c.is_ascii_digit())?);
    let n: u32 = n.parse().ok()?;
    Some(match unit {
        "ms" => n,
        "s" => n * 1000,
        "m" => n * 60_000,
        "h" => n * 3_600_000,
        _ => return None,
    })
}

fn class_of(kind: &str) -> &'static str {
    match kind {
        "get" | "find" | "list" | "effective" | "children" | "ancestors" | "download" => {
            "crud-read"
        }
        "create" | "update" | "delete" | "restore" | "transition" | "move" | "beginUpload"
        | "finalizeUpload" => "crud-write",
        "view.query" | "projection.get" | "projection.status" | "cache.read"
        | "schedule.status" | "workflow.get" => "crud-read",
        "function" => "function",
        "workflow.start" | "workflow.signal" | "workflow.cancel" => "workflow",
        "projection.rebuild" | "schedule.tick" => "job",
        _ => "crud-write",
    }
}

fn default_target(class: &str) -> (String, String, String) {
    match class {
        "crud-read" => ("99.9%".into(), "99%".into(), "500ms".into()),
        "function" | "workflow" => ("99.9%".into(), "99%".into(), "1s".into()),
        "job" => ("99%".into(), "99%".into(), "30s".into()),
        _ => ("99.9%".into(), "99%".into(), "1s".into()),
    }
}

pub fn plan(ir: &DomainIR) -> ObservabilityPlan {
    let cfg = &ir.package.observability;
    let window = cfg.window.clone();
    let target = |class: &str, declared: Option<(String, String, String)>| -> Slo {
        let (a, g, w) = declared
            .or_else(|| {
                cfg.slo.iter().find(|(c, _)| c == class).map(|(_, t)| {
                    (
                        t.availability.clone(),
                        t.latency_good.clone(),
                        t.latency_within.clone(),
                    )
                })
            })
            .unwrap_or_else(|| default_target(class));
        Slo {
            availability: a,
            latency_good: g,
            latency_within_ms: duration_ms(&w).unwrap_or(1000),
            window: window.clone(),
        }
    };
    let boundaries = |within: u32| {
        let mut b: Vec<u32> = BASE_BOUNDARIES.to_vec();
        if !b.contains(&within) {
            b.push(within);
            b.sort_unstable();
        }
        b
    };
    let mut operations = Vec::new();
    let mut push = |operation: String,
                    kind: &str,
                    resource: Option<String>,
                    declared: Option<(String, String, String)>,
                    business_errors: Vec<String>| {
        let class = class_of(kind);
        let slo = target(class, declared);
        operations.push(OperationTelemetry {
            operation,
            kind: kind.into(),
            resource,
            class: class.into(),
            histogram_boundaries_ms: boundaries(slo.latency_within_ms),
            slo,
            business_errors,
        });
    };
    for m in &ir.modules {
        for r in &m.resources {
            for op in &r.operations {
                push(op.id.clone(), &op.kind, Some(r.id.clone()), None, vec![]);
            }
        }
        for f in &m.functions {
            let declared = f.slo.iter().fold((None, None), |acc, s| match s {
                forge_semantic::ir::Slo::Availability { target, .. } => {
                    (Some(target.clone()), acc.1)
                }
                forge_semantic::ir::Slo::Latency { target, within, .. } => {
                    (acc.0, Some((target.clone(), within.clone())))
                }
            });
            let declared = match declared {
                (Some(a), Some((g, w))) => Some((a, g, w)),
                (Some(a), None) => {
                    let d = default_target("function");
                    Some((a, d.1, d.2))
                }
                (None, Some((g, w))) => {
                    let d = default_target("function");
                    Some((d.0, g, w))
                }
                (None, None) => None,
            };
            push(
                f.id.clone(),
                "function",
                None,
                declared,
                f.errors.iter().map(|e| format!("{}.{e}", f.id)).collect(),
            );
        }
        for v in &m.views {
            push(
                format!("{}.query", v.id),
                "view.query",
                Some(v.source.clone()),
                None,
                vec![],
            );
        }
        for p in &m.projections {
            push(
                format!("{}.get", p.id),
                "projection.get",
                Some(p.source.clone()),
                None,
                vec![],
            );
            push(
                format!("{}.status", p.id),
                "projection.status",
                Some(p.source.clone()),
                None,
                vec![],
            );
            push(
                format!("{}.rebuild", p.id),
                "projection.rebuild",
                Some(p.source.clone()),
                None,
                vec![],
            );
        }
        for c in &m.caches {
            push(format!("{}.read", c.id), "cache.read", None, None, vec![]);
        }
        for w in &m.workflows {
            let errs: Vec<String> = w.errors.iter().map(|e| format!("{}.{e}", w.id)).collect();
            push(
                format!("{}.start", w.id),
                "workflow.start",
                None,
                None,
                errs,
            );
            push(format!("{}.get", w.id), "workflow.get", None, None, vec![]);
            push(
                format!("{}.signal", w.id),
                "workflow.signal",
                None,
                None,
                vec![],
            );
            push(
                format!("{}.cancel", w.id),
                "workflow.cancel",
                None,
                None,
                vec![],
            );
        }
        for s in &m.sources {
            push(
                format!("{}.status", s.id),
                "schedule.status",
                None,
                None,
                vec![],
            );
            push(
                format!("{}.tick", s.id),
                "schedule.tick",
                None,
                None,
                vec![],
            );
        }
    }
    ObservabilityPlan {
        version: OBSERVABILITY_VERSION.into(),
        dimensions: ["forge.operation", "forge.kind", "forge.resource", "forge.outcome", "forge.target"].iter().map(|s| s.to_string()).collect(),
        classification: Classification {
            good: "status < 400".into(),
            excluded: "4xx client errors except TransientConflict".into(),
            bad: "5xx, TransientConflict, timeouts, undeclared failures".into(),
            business: "declared domain errors: served, counted separately".into(),
            counting: "one event per logical operation; retries are attempts on the same event, never new events".into(),
        },
        window,
        operations,
    }
}
