//! Data taxonomy, DataSemanticsIR and LineageIR (plan §7, FORGE-037/039).
//! The core vocabulary is pinned in `packages/contracts/data-core/taxonomy.json`
//! and embedded here so compilation stays offline.
//!
//! The embedded copy lives beside this crate (`crates/forgegraph-semantic/taxonomy.json`)
//! because a published crate cannot reach outside its own directory. The
//! contracts package remains the authority; `taxonomy_mirror_matches_the_contract`
//! below fails if the two ever drift. Classification describes
//! data, never access (D11); unknown is not public (D12); a custom class keeps
//! every ancestor and cannot lower handling below its parent.
use crate::ir::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const TAXONOMY_JSON: &str = include_str!("../taxonomy.json");

#[derive(Debug, Clone, Deserialize)]
pub struct TaxonomyNode {
    pub id: String,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub kinds: Vec<String>,
    pub identifiability: String,
    pub handling: String,
    pub personal: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Taxonomy {
    pub version: String,
    pub handling: Vec<String>,
    pub nodes: Vec<TaxonomyNode>,
    #[serde(default)]
    pub inferred_from_type: BTreeMap<String, String>,
    #[serde(default)]
    pub record_contexts: Vec<String>,
}

impl Taxonomy {
    pub fn core() -> Taxonomy {
        #[derive(Deserialize)]
        struct Raw {
            version: String,
            handling: Vec<String>,
            nodes: Vec<TaxonomyNode>,
            #[serde(rename = "inferredFromType", default)]
            inferred_from_type: BTreeMap<String, String>,
            #[serde(rename = "recordContexts", default)]
            record_contexts: Vec<String>,
        }
        let r: Raw = serde_json::from_str(TAXONOMY_JSON).expect("core taxonomy is valid");
        Taxonomy {
            version: r.version,
            handling: r.handling,
            nodes: r.nodes,
            inferred_from_type: r.inferred_from_type,
            record_contexts: r.record_contexts,
        }
    }
    pub fn node(&self, id: &str) -> Option<&TaxonomyNode> {
        self.nodes.iter().find(|n| n.id == id)
    }
    /// Ancestors from the node itself up to the root, inclusive.
    pub fn ancestors(&self, id: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut cur = self.node(id);
        while let Some(n) = cur {
            out.push(n.id.clone());
            cur = n.parent.as_deref().and_then(|p| self.node(p));
        }
        out
    }
    /// Handling can only tighten down a chain: a child never lowers what an ancestor requires. A node
    /// with `unknown` handling states no requirement; if nothing states one, the answer is `restricted`.
    pub fn handling_of(&self, id: &str) -> String {
        let rank = |h: &str| self.handling.iter().position(|x| x == h).unwrap_or(0);
        self.ancestors(id)
            .iter()
            .filter_map(|a| self.node(a))
            .map(|n| n.handling.clone())
            .filter(|h| h != "unknown")
            .max_by_key(|h| rank(h))
            .unwrap_or_else(|| "restricted".into())
    }
}

// ------------------------------------------------------------ DataSemanticsIR
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldSemantics {
    pub resource: String,
    pub field: String,
    /// Most specific class (taxonomy id or the id of a declared dataClass).
    pub class: String,
    /// Taxonomy chain, most specific first; a declared dataClass adds itself in front of its parent chain.
    pub ancestors: Vec<String>,
    pub kinds: Vec<String>,
    pub identifiability: String,
    pub handling: String,
    /// yes | no | unknown
    pub personal: String,
    /// declared | inferred-from-type | structural
    pub evidence: String,
    /// classified | inferred | structural | unclassified
    pub completeness: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubjectEntry {
    pub resource: String,
    /// person | organization | device, or the kind reached through `via`.
    pub kind: String,
    /// Field that carries the subject reference for `@subject(from: field)`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
    /// Bounded `list by` query through which records of one subject are located.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_context: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSemantics {
    pub version: String,
    pub taxonomy: String,
    pub fields: Vec<FieldSemantics>,
    pub subjects: Vec<SubjectEntry>,
    pub summary: BTreeMap<String, usize>,
}

impl DataSemantics {
    pub fn of(ir: &DomainIR, tax: &Taxonomy) -> DataSemantics {
        let declared: BTreeMap<String, String> = ir
            .modules
            .iter()
            .flat_map(|m| &m.data_classes)
            .map(|d| (d.id.clone(), d.extends.clone()))
            .collect();
        let mut fields = Vec::new();
        let mut subjects = Vec::new();
        for m in &ir.modules {
            for r in &m.resources {
                for f in &r.fields {
                    let (class, evidence) = match &f.ty.data_class {
                        Some(c) => (c.clone(), "declared"),
                        None => {
                            let scalar = match &f.ty.base {
                                TypeBase::Scalar { name, .. } => Some(name.as_str()),
                                TypeBase::Reference { .. }
                                | TypeBase::Identity { .. }
                                | TypeBase::Enum { .. }
                                | TypeBase::Status { .. } => Some("id"),
                                _ => None,
                            };
                            match scalar.and_then(|s| tax.inferred_from_type.get(s)) {
                                Some(c) if c == "data.structural" => (c.clone(), "structural"),
                                Some(c) => (c.clone(), "inferred-from-type"),
                                None => ("data.unknown".to_string(), "none"),
                            }
                        }
                    };
                    // A declared dataClass id resolves to its taxonomy parent chain, keeping itself in front.
                    let tax_id = declared
                        .get(&class)
                        .cloned()
                        .unwrap_or_else(|| class.clone());
                    let mut ancestors = tax.ancestors(&tax_id);
                    if ancestors.is_empty() {
                        ancestors = tax.ancestors("data.unknown");
                    }
                    if declared.contains_key(&class) {
                        ancestors.insert(0, class.clone());
                    }
                    let node = tax
                        .node(&tax_id)
                        .or_else(|| tax.node("data.unknown"))
                        .expect("unknown node exists");
                    let completeness = match evidence {
                        "declared" => "classified",
                        "inferred-from-type" => "inferred",
                        "structural" => "structural",
                        _ => "unclassified",
                    };
                    fields.push(FieldSemantics {
                        resource: r.id.clone(),
                        field: f.name.clone(),
                        class,
                        ancestors,
                        kinds: node.kinds.clone(),
                        identifiability: node.identifiability.clone(),
                        handling: tax.handling_of(&tax_id),
                        personal: node.personal.clone(),
                        evidence: evidence.into(),
                        completeness: completeness.into(),
                    });
                }
                match &r.decorators.subject {
                    Some(SubjectBinding::Kind { kind: k }) => subjects.push(SubjectEntry {
                        resource: r.id.clone(),
                        kind: k.clone(),
                        via: None,
                        access_path: None,
                        record_context: r.decorators.record_context.clone(),
                    }),
                    Some(SubjectBinding::From { field }) => {
                        let target = r.fields.iter().find(|f| &f.name == field).and_then(|f| {
                            if let TypeBase::Reference { resource } = &f.ty.base {
                                Some(resource.clone())
                            } else {
                                None
                            }
                        });
                        let kind = target
                            .as_deref()
                            .and_then(|t| ir.find_resource(t))
                            .and_then(|t| match &t.decorators.subject {
                                Some(SubjectBinding::Kind { kind: k }) => Some(k.clone()),
                                _ => None,
                            })
                            .unwrap_or_else(|| "unknown".into());
                        let path = r
                            .lists
                            .iter()
                            .find(|l| l.fields.len() == 1 && &l.fields[0] == field)
                            .map(|l| l.name.clone());
                        subjects.push(SubjectEntry {
                            resource: r.id.clone(),
                            kind,
                            via: Some(field.clone()),
                            access_path: path,
                            record_context: r.decorators.record_context.clone(),
                        });
                    }
                    None => {}
                }
            }
        }
        let mut summary = BTreeMap::new();
        for f in &fields {
            *summary.entry(f.completeness.clone()).or_insert(0) += 1;
        }
        DataSemantics {
            version: "data-semantics/1".into(),
            taxonomy: tax.version.clone(),
            fields,
            subjects,
            summary,
        }
    }
    pub fn field(&self, resource: &str, field: &str) -> Option<&FieldSemantics> {
        self.fields
            .iter()
            .find(|f| f.resource == resource && f.field == field)
    }
    pub fn subjects(&self) -> &[SubjectEntry] {
        &self.subjects
    }
}

// ------------------------------------------------------------------ LineageIR
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationLineage {
    pub operation: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    /// Fields read into the result.
    pub outputs: Vec<String>,
    /// Fields written.
    pub writes: Vec<String>,
    /// Fields used in predicates (a hidden filter is still processing).
    pub filters: Vec<String>,
    pub orders: Vec<String>,
    pub groups: Vec<String>,
    /// Imported callables reached (declared effects).
    pub external_sinks: Vec<String>,
    /// Channels the operation may publish to.
    pub publishes: Vec<String>,
    /// modeled (generated, exact) | declared (handwritten, from `uses`/`sends`) | unknown
    pub coverage: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lineage {
    pub version: String,
    pub operations: Vec<OperationLineage>,
}

fn expr_fields(e: &Expr, out: &mut Vec<String>) {
    match e {
        Expr::Name { path } => {
            if let Some(h) = path.first()
                && !out.contains(h)
                && !h.chars().next().is_some_and(|c| c.is_ascii_uppercase())
            {
                out.push(h.clone());
            }
        }
        Expr::Binary { lhs, rhs, .. } => {
            expr_fields(lhs, out);
            expr_fields(rhs, out);
        }
        Expr::Unary { operand, .. } => expr_fields(operand, out),
        Expr::Call { args, .. } => args.iter().for_each(|a| expr_fields(a, out)),
        Expr::Literal { .. } => {}
    }
}

impl Lineage {
    pub fn of(ir: &DomainIR) -> Lineage {
        let mut ops = Vec::new();
        let visible = |r: &Resource| {
            r.fields
                .iter()
                .filter(|f| !f.hidden)
                .map(|f| f.name.clone())
                .collect::<Vec<_>>()
        };
        let writable = |r: &Resource| {
            r.fields
                .iter()
                .filter(|f| !f.server_owned && !f.synthesized)
                .map(|f| f.name.clone())
                .collect::<Vec<_>>()
        };
        for m in &ir.modules {
            for r in &m.resources {
                for op in &r.operations {
                    let (outputs, writes, filters, orders) = match op.kind.as_str() {
                        "create" => (visible(r), writable(r), vec![], vec![]),
                        "update" => (
                            visible(r),
                            r.fields
                                .iter()
                                .filter(|f| !f.immutable && !f.server_owned && !f.synthesized)
                                .map(|f| f.name.clone())
                                .collect(),
                            vec!["id".into(), "version".into()],
                            vec![],
                        ),
                        "delete" | "restore" => (
                            visible(r),
                            vec!["deletedAt".into(), "version".into()],
                            vec!["id".into(), "version".into()],
                            vec![],
                        ),
                        "transition" => (
                            visible(r),
                            r.lifecycle
                                .as_ref()
                                .map(|l| vec![l.field.clone()])
                                .unwrap_or_default(),
                            vec![
                                "id".into(),
                                "version".into(),
                                r.lifecycle
                                    .as_ref()
                                    .map(|l| l.field.clone())
                                    .unwrap_or_default(),
                            ],
                            vec![],
                        ),
                        "find" => (
                            visible(r),
                            vec![],
                            r.finds
                                .iter()
                                .find(|f| Some(&f.name) == op.query.as_ref())
                                .map(|f| f.fields.clone())
                                .unwrap_or_default(),
                            vec![],
                        ),
                        "list" => {
                            let l = r.lists.iter().find(|l| Some(&l.name) == op.query.as_ref());
                            (
                                visible(r),
                                vec![],
                                l.map(|l| l.fields.clone()).unwrap_or_default(),
                                l.map(|l| l.order.iter().map(|o| o.field.clone()).collect())
                                    .unwrap_or_default(),
                            )
                        }
                        _ => (visible(r), vec![], vec!["id".into()], vec![]),
                    };
                    let mut rules = Vec::new();
                    for rule in &r.rules {
                        expr_fields(rule, &mut rules);
                    }
                    let mut filters = filters;
                    if matches!(op.kind.as_str(), "create" | "update" | "transition") {
                        for f in rules {
                            if !filters.contains(&f) {
                                filters.push(f);
                            }
                        }
                    }
                    ops.push(OperationLineage {
                        operation: op.id.clone(),
                        kind: op.kind.clone(),
                        resource: Some(r.id.clone()),
                        outputs,
                        writes,
                        filters,
                        orders,
                        groups: vec![],
                        external_sinks: vec![],
                        publishes: if r.decorators.audited {
                            vec![format!("{}.changes", r.id)]
                        } else {
                            vec![]
                        },
                        coverage: "modeled".into(),
                    });
                }
            }
            for v in &m.views {
                let mut filters = v.by.clone();
                if let Some(w) = &v.filter {
                    expr_fields(w, &mut filters);
                }
                ops.push(OperationLineage {
                    operation: format!("{}.query", v.id),
                    kind: "view.query".into(),
                    resource: Some(v.source.clone()),
                    outputs: v.fields.clone(),
                    writes: vec![],
                    filters,
                    orders: v.order.iter().map(|o| o.field.clone()).collect(),
                    groups: vec![],
                    external_sinks: vec![],
                    publishes: vec![],
                    coverage: "modeled".into(),
                });
            }
            for p in &m.projections {
                let mut filters = Vec::new();
                if let Some(w) = &p.filter {
                    expr_fields(w, &mut filters);
                }
                ops.push(OperationLineage {
                    operation: format!("{}.get", p.id),
                    kind: "projection.get".into(),
                    resource: Some(p.source.clone()),
                    outputs: p.aggregates.iter().map(|a| a.field.clone()).collect(),
                    writes: vec![],
                    filters,
                    orders: vec![],
                    groups: p.by.clone(),
                    external_sinks: vec![],
                    publishes: vec![],
                    coverage: "modeled".into(),
                });
            }
            for f in &m.functions {
                let mut sinks = Vec::new();
                let mut writes = Vec::new();
                for u in &f.uses {
                    match u {
                        Use::Function { function, .. }
                            if !function.starts_with(&format!("{}/", ir.package.name)) =>
                        {
                            sinks.push(function.clone())
                        }
                        Use::Resource {
                            resource,
                            capability,
                        } if capability != "read" => writes.push(resource.clone()),
                        Use::Transition { resource, action } => {
                            writes.push(format!("{resource}.status.{action}"))
                        }
                        _ => {}
                    }
                }
                ops.push(OperationLineage {
                    operation: f.id.clone(),
                    kind: "function".into(),
                    resource: None,
                    outputs: vec![],
                    writes,
                    filters: vec![],
                    orders: vec![],
                    groups: vec![],
                    external_sinks: sinks,
                    publishes: f.sends.iter().map(|s| s.channel.clone()).collect(),
                    coverage: if f.generated {
                        "modeled".into()
                    } else {
                        "declared".into()
                    },
                });
            }
        }
        Lineage {
            version: "lineage/1".into(),
            operations: ops,
        }
    }
}

#[cfg(test)]
mod mirror {
    /// The crate-local copy exists only so the crate can be published. If it
    /// drifts from the contracts package, the compiler would classify data
    /// differently from the runtime that enforces it.
    #[test]
    fn taxonomy_mirror_matches_the_contract() {
        let contract = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/contracts/data-core/taxonomy.json");
        // Absent when building from a published tarball; there is nothing to compare against.
        let Ok(authority) = std::fs::read_to_string(&contract) else {
            return;
        };
        assert_eq!(
            authority,
            super::TAXONOMY_JSON,
            "crates/forgegraph-semantic/taxonomy.json has drifted from {}; copy the contract over it",
            contract.display()
        );
    }
}
