//! Semantic diff between two built models (plan §22; FORGE-067). Streams are
//! tracked separately — API, interfaces, event, storage, lifecycle, workflow,
//! classification, governance, dependencies, policy — because "additive" is not
//! universally safe: an enum output member can break exhaustive consumers, an
//! added lifecycle state changes the event vocabulary, a workflow graph change
//! with the same version violates in-flight pins, a widened purpose surface
//! needs reapproval. Findings carry a *direction* (which side of a contract
//! breaks) and *needs* (review/migration work), never invented live facts: this
//! is a pure function of two artifacts and makes no claim about stored rows.
//! Whitespace and file moves do not change the IR, so they produce nothing.
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

pub const COMPAT_VERSION: &str = "compat/1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub stream: &'static str,
    /// breaking | risk | unknown | migration | additive
    pub severity: &'static str,
    pub code: &'static str,
    pub subject: String,
    pub detail: String,
    /// Which party a change breaks: `consumer` (readers of outputs/events), `producer` (writers/callers), `both`, `none`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<&'static str>,
    /// Work the change requires before or during rollout (never quantified against live data here).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub needs: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub version: &'static str,
    pub old_build: String,
    pub new_build: String,
    /// compatible | migration | unknown | risk | breaking (the most severe finding)
    pub verdict: &'static str,
    /// Per-stream worst severity.
    pub streams: BTreeMap<&'static str, &'static str>,
    /// What this report deliberately does not know.
    pub facts: Facts,
    pub findings: Vec<Finding>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    /// Always "none": the diff runs offline and never counts or samples stored data.
    pub live_data: &'static str,
    pub policy_proof: &'static str,
}

fn direction_of(code: &str) -> Option<&'static str> {
    Some(match code {
        "field-removed"
        | "enum-member-added"
        | "enum-member-removed"
        | "state-added"
        | "state-removed"
        | "message-added"
        | "message-removed"
        | "error-added"
        | "resource-removed"
        | "channel-removed"
        | "surface-narrowed" => "consumer",
        "field-required"
        | "operation-removed"
        | "function-removed"
        | "http-binding-changed"
        | "transition-removed"
        | "endpoint-removed"
        | "parameter-required"
        | "workflow-removed"
        | "dependency-removed" => "producer",
        "collection-type-changed"
        | "graph-changed-without-version"
        | "table-removed"
        | "column-removed"
        | "column-type-changed"
        | "surface-removed"
        | "purpose-removed"
        | "handling-loosened"
        | "class-changed"
        | "subject-binding-removed" => "both",
        _ => "none",
    })
}
fn needs_of(code: &str) -> Vec<&'static str> {
    match code {
        "field-required" => vec!["backfill-review"],
        "collection-type-changed" => vec!["existing-data-validation", "codec-migration-review"],
        "projection-definition-changed" => vec!["rebuild-projection-generation"],
        "unique-invariant-changed" => {
            vec!["existing-data-validation", "rebuild-indexes-and-claims"]
        }
        "column-type-changed" => vec!["data-rewrite"],
        "column-added" | "table-added" => vec!["expand-ddl"],
        "column-removed" | "table-removed" => vec!["retention-decision", "contract-ddl"],
        "personal-field-added" => vec!["classification-review", "surface-mapping"],
        "class-changed" | "handling-loosened" => vec!["classification-review"],
        "subject-binding-added" => vec!["subject-index"],
        "subject-binding-removed" | "subject-binding-changed" => vec!["subject-rights-review"],
        "surface-narrowed" => vec!["cache-invalidation", "receipt-reprojection"],
        "surface-widened" | "surface-added" | "deny-removed" => vec!["grant-reapproval"],
        "surface-removed" | "purpose-removed" => vec!["grant-retirement", "cache-invalidation"],
        "dependency-added" => vec!["dependency-request"],
        "dependency-removed" => vec!["grant-retirement"],
        "workflow-version-bumped" => vec!["drain-old-version"],
        "policy-changed-unknown" => vec!["policy-review"],
        "policy-widened" => vec!["grant-reapproval"],
        "policy-narrowed" => vec!["decision-epoch-bump"],
        _ => vec![],
    }
}

fn arr<'a>(v: &'a Value, path: &[&str]) -> Vec<&'a Value> {
    let mut cur = v;
    for p in path {
        cur = &cur[*p];
    }
    cur.as_array()
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}
fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}
fn by_id<'a>(items: Vec<&'a Value>, key: &str) -> BTreeMap<String, &'a Value> {
    items.into_iter().map(|i| (s(&i[key]), i)).collect()
}

pub fn compare(old: &Value, new: &Value) -> Report {
    let mut f: Vec<Finding> = Vec::new();
    let push = |f: &mut Vec<Finding>,
                stream: &'static str,
                severity: &'static str,
                code: &'static str,
                subject: String,
                detail: String| {
        f.push(Finding {
            stream,
            severity,
            code,
            subject,
            detail,
            direction: direction_of(code),
            needs: needs_of(code),
        })
    };

    let resources = |bundle: &Value| -> BTreeMap<String, Value> {
        arr(bundle, &["ir", "modules"])
            .into_iter()
            .flat_map(|m| arr(m, &["resources"]))
            .map(|r| (s(&r["id"]), r["uniques"].clone()))
            .collect()
    };
    let before = resources(old);
    let after = resources(new);
    for (id, old_uniques) in &before {
        if let Some(new_uniques) = after.get(id)
            && old_uniques != new_uniques
        {
            push(&mut f,"storage","migration","unique-invariant-changed",id.clone(),"uniqueness keys or conditions changed; validate existing rows and rebuild indexes/claims before activation".into());
        }
    }

    let projections = |bundle: &Value| -> BTreeMap<String, Value> {
        arr(bundle,&["ir","modules"]).into_iter().flat_map(|m|arr(m,&["projections"])).map(|p|(s(&p["id"]),serde_json::json!({"source":p["source"],"by":p["by"],"where":p["where"],"aggregates":p["aggregates"]}))).collect()
    };
    for (id, previous) in projections(old) {
        if let Some(current) = projections(new).get(&id)
            && &previous != current
        {
            push(&mut f,"storage","migration","projection-definition-changed",id,"projection grouping, filters or aggregates changed; build a new generation before serving the new contract".into());
        }
    }

    // JSON storage does not reveal element codec or collection-bound changes.
    let collection_fields = |bundle: &Value| -> BTreeMap<String, Value> {
        arr(bundle, &["ir", "modules"])
            .into_iter()
            .flat_map(|m| {
                arr(m, &["resources"])
                    .into_iter()
                    .chain(arr(m, &["shapes"]))
            })
            .flat_map(|r| {
                arr(r, &["fields"]).into_iter().map(move |field| {
                    (
                        format!("{}.{}", s(&r["id"]), s(&field["name"])),
                        field["type"].clone(),
                    )
                })
            })
            .collect()
    };
    let current_fields = collection_fields(new);
    for (id, previous) in collection_fields(old) {
        if let Some(current) = current_fields.get(&id)
            && previous != *current
            && (previous["base"]["kind"] == "collection" || current["base"]["kind"] == "collection")
        {
            push(&mut f, "api", "breaking", "collection-type-changed", id,
                "collection kind, element codec or bounds changed; validate stored values and review producer/consumer compatibility".into());
        }
    }

    // ---- API: contracts (record/create/patch schemas per resource, operations, functions, enums)
    let old_res = by_id(arr(old, &["contracts", "resources"]), "id");
    let new_res = by_id(arr(new, &["contracts", "resources"]), "id");
    for (id, o) in &old_res {
        let Some(n) = new_res.get(id) else {
            push(
                &mut f,
                "api",
                "breaking",
                "resource-removed",
                id.clone(),
                "clients and readers of this resource break".into(),
            );
            continue;
        };
        let props = |v: &Value, schema: &str| {
            v[schema]["properties"]
                .as_object()
                .map(|m| {
                    m.keys()
                        .cloned()
                        .map(|k| (k, ()))
                        .collect::<BTreeMap<_, _>>()
                })
                .unwrap_or_default()
        };
        let required = |v: &Value, schema: &str| {
            v[schema]["required"]
                .as_array()
                .map(|a| a.iter().map(s).collect::<Vec<_>>())
                .unwrap_or_default()
        };
        let (op, np) = (props(o, "record"), props(n, "record"));
        for k in op.keys() {
            if !np.contains_key(k) {
                push(
                    &mut f,
                    "api",
                    "breaking",
                    "field-removed",
                    format!("{id}.{k}"),
                    "existing readers expect this field".into(),
                );
            }
        }
        for k in np.keys() {
            if !op.contains_key(k) {
                push(
                    &mut f,
                    "api",
                    "additive",
                    "field-added",
                    format!("{id}.{k}"),
                    "new output field; readers ignoring unknown fields are unaffected".into(),
                );
            }
        }
        let (oc, nc) = (required(o, "create"), required(n, "create"));
        for k in &nc {
            if !oc.contains(k) {
                push(
                    &mut f,
                    "api",
                    "breaking",
                    "field-required",
                    format!("{id}.{k}"),
                    "existing writers do not send this now-required field".into(),
                );
            }
        }
        for k in &oc {
            if !nc.contains(k) && props(n, "create").contains_key(k) {
                push(
                    &mut f,
                    "api",
                    "additive",
                    "field-optional",
                    format!("{id}.{k}"),
                    "writers may omit it; readers must accept null".into(),
                );
            }
        }
        let oops = by_id(arr(o, &["operations"]), "id");
        let nops = by_id(arr(n, &["operations"]), "id");
        for k in oops.keys() {
            if !nops.contains_key(k) {
                push(
                    &mut f,
                    "api",
                    "breaking",
                    "operation-removed",
                    k.clone(),
                    "callers of this operation break".into(),
                );
            }
        }
        for k in nops.keys() {
            if !oops.contains_key(k) {
                push(
                    &mut f,
                    "api",
                    "additive",
                    "operation-added",
                    k.clone(),
                    "new operation".into(),
                );
            }
        }
    }
    for id in new_res.keys() {
        if !old_res.contains_key(id) {
            push(
                &mut f,
                "api",
                "additive",
                "resource-added",
                id.clone(),
                "new resource".into(),
            );
        }
    }
    let old_fns = by_id(arr(old, &["contracts", "functions"]), "id");
    let new_fns = by_id(arr(new, &["contracts", "functions"]), "id");
    for (id, o) in &old_fns {
        match new_fns.get(id) {
            None => push(
                &mut f,
                "api",
                "breaking",
                "function-removed",
                id.clone(),
                "callers break".into(),
            ),
            Some(n) => {
                if o["http"] != n["http"] {
                    push(
                        &mut f,
                        "api",
                        "breaking",
                        "http-binding-changed",
                        id.clone(),
                        "path or method changed".into(),
                    );
                }
                let oe: Vec<String> = arr(o, &["errors"]).into_iter().map(s).collect();
                for e in arr(n, &["errors"]).into_iter().map(s) {
                    if !oe.contains(&e) {
                        push(
                            &mut f,
                            "api",
                            "risk",
                            "error-added",
                            format!("{id}.{e}"),
                            "callers with exhaustive error handling must learn it".into(),
                        );
                    }
                }
            }
        }
    }
    for id in new_fns.keys() {
        if !old_fns.contains_key(id) {
            push(
                &mut f,
                "api",
                "additive",
                "function-added",
                id.clone(),
                "new function".into(),
            );
        }
    }
    // enums: members are output values; adding one breaks exhaustive consumers
    let enums = |v: &Value| -> BTreeMap<String, Vec<String>> {
        arr(v, &["ir", "modules"])
            .into_iter()
            .flat_map(|m| arr(m, &["enums"]))
            .map(|e| {
                (
                    s(&e["id"]),
                    arr(e, &["members"])
                        .into_iter()
                        .map(|x| s(&x["name"]))
                        .collect(),
                )
            })
            .collect()
    };
    let (oe, ne) = (enums(old), enums(new));
    for (id, om) in &oe {
        if let Some(nm) = ne.get(id) {
            for m in nm {
                if !om.contains(m) {
                    push(
                        &mut f,
                        "api",
                        "risk",
                        "enum-member-added",
                        format!("{id}.{m}"),
                        "exhaustive consumers of this enum must handle the new member".into(),
                    );
                }
            }
            for m in om {
                if !nm.contains(m) {
                    push(
                        &mut f,
                        "api",
                        "breaking",
                        "enum-member-removed",
                        format!("{id}.{m}"),
                        "stored or sent values may no longer decode".into(),
                    );
                }
            }
        }
    }

    // ---- lifecycle + events
    let lifecycles = |v: &Value| -> BTreeMap<String, (Vec<String>, Vec<String>)> {
        arr(v, &["ir", "modules"])
            .into_iter()
            .flat_map(|m| arr(m, &["resources"]))
            .filter(|r| !r["lifecycle"].is_null())
            .map(|r| {
                (
                    s(&r["id"]),
                    (
                        arr(&r["lifecycle"], &["states"])
                            .into_iter()
                            .map(s)
                            .collect(),
                        arr(&r["lifecycle"], &["transitions"])
                            .into_iter()
                            .map(|t| s(&t["action"]))
                            .collect(),
                    ),
                )
            })
            .collect()
    };
    let (ol, nl) = (lifecycles(old), lifecycles(new));
    for (id, (os, oa)) in &ol {
        if let Some((ns, na)) = nl.get(id) {
            for st in ns {
                if !os.contains(st) {
                    push(
                        &mut f,
                        "lifecycle",
                        "additive",
                        "state-added",
                        format!("{id}.{st}"),
                        "new state; consumers switching on status must handle it".into(),
                    );
                }
            }
            for st in os {
                if !ns.contains(st) {
                    push(
                        &mut f,
                        "lifecycle",
                        "breaking",
                        "state-removed",
                        format!("{id}.{st}"),
                        "stored records may be in this state".into(),
                    );
                }
            }
            for a in na {
                if !oa.contains(a) {
                    push(
                        &mut f,
                        "lifecycle",
                        "additive",
                        "transition-added",
                        format!("{id}.{a}"),
                        "new action".into(),
                    );
                }
            }
            for a in oa {
                if !na.contains(a) {
                    push(
                        &mut f,
                        "lifecycle",
                        "breaking",
                        "transition-removed",
                        format!("{id}.{a}"),
                        "callers of this action break".into(),
                    );
                }
            }
        }
    }
    let channels = |v: &Value| -> BTreeMap<String, Vec<String>> {
        arr(v, &["messaging", "channels"])
            .into_iter()
            .map(|c| {
                (
                    s(&c["id"]),
                    arr(c, &["messages"])
                        .into_iter()
                        .map(|m| s(&m["name"]))
                        .collect(),
                )
            })
            .collect()
    };
    let (oc, nc) = (channels(old), channels(new));
    for (id, om) in &oc {
        match nc.get(id) {
            None => push(
                &mut f,
                "event",
                "breaking",
                "channel-removed",
                id.clone(),
                "subscribers lose their source".into(),
            ),
            Some(nm) => {
                for m in nm {
                    if !om.contains(m) {
                        push(
                            &mut f,
                            "event",
                            "risk",
                            "message-added",
                            format!("{id}.{m}"),
                            "consumers must ignore or handle the new message".into(),
                        );
                    }
                }
                for m in om {
                    if !nm.contains(m) {
                        push(
                            &mut f,
                            "event",
                            "breaking",
                            "message-removed",
                            format!("{id}.{m}"),
                            "in-flight and replayed messages may carry it".into(),
                        );
                    }
                }
            }
        }
    }

    // ---- storage (D1 physical schema; DynamoDB attributes follow the same field set)
    let tables = |v: &Value| -> BTreeMap<String, BTreeMap<String, String>> {
        arr(v, &["sql", "tables"])
            .into_iter()
            .map(|t| {
                (
                    s(&t["name"]),
                    arr(t, &["columns"])
                        .into_iter()
                        .map(|c| (s(&c["name"]), s(&c["sqlType"])))
                        .collect(),
                )
            })
            .collect()
    };
    let (ot, nt) = (tables(old), tables(new));
    for (name, ocols) in &ot {
        match nt.get(name) {
            None => push(
                &mut f,
                "storage",
                "breaking",
                "table-removed",
                name.clone(),
                "data would be dropped; requires an explicit migration and retention decision"
                    .into(),
            ),
            Some(ncols) => {
                for (c, ty) in ocols {
                    match ncols.get(c) {
                        None => push(
                            &mut f,
                            "storage",
                            "breaking",
                            "column-removed",
                            format!("{name}.{c}"),
                            "stored values would be dropped".into(),
                        ),
                        Some(nty) if nty != ty => push(
                            &mut f,
                            "storage",
                            "migration",
                            "column-type-changed",
                            format!("{name}.{c}"),
                            format!("{ty} -> {nty}: values must be rewritten"),
                        ),
                        _ => {}
                    }
                }
                for c in ncols.keys() {
                    if !ocols.contains_key(c) {
                        push(
                            &mut f,
                            "storage",
                            "migration",
                            "column-added",
                            format!("{name}.{c}"),
                            "additive DDL (ALTER TABLE ADD COLUMN) before the new readers deploy"
                                .into(),
                        );
                    }
                }
            }
        }
    }
    for name in nt.keys() {
        if !ot.contains_key(name) {
            push(
                &mut f,
                "storage",
                "migration",
                "table-added",
                name.clone(),
                "additive DDL before the new readers deploy".into(),
            );
        }
    }

    // ---- classification: data semantics and subject bindings (M11); loosening is breaking for governance
    let sem = |v: &Value| -> BTreeMap<String, (String, String, String)> {
        arr(v, &["dataSemantics", "fields"])
            .into_iter()
            .map(|f| {
                (
                    format!("{}.{}", s(&f["resource"]), s(&f["field"])),
                    (s(&f["class"]), s(&f["handling"]), s(&f["personal"])),
                )
            })
            .collect()
    };
    let (os, ns) = (sem(old), sem(new));
    let rank = |h: &str| match h {
        "public" => 0,
        "internal" => 1,
        "confidential" => 2,
        "restricted" => 3,
        _ => 4,
    };
    for (k, (oc, oh, _)) in &os {
        if let Some((nc, nh, _)) = ns.get(k) {
            if oc != nc {
                push(
                    &mut f,
                    "classification",
                    if rank(nh) < rank(oh) {
                        "breaking"
                    } else {
                        "risk"
                    },
                    "class-changed",
                    k.clone(),
                    format!(
                        "{oc} -> {nc}: consumers, grants and retention rules keyed on the class need review"
                    ),
                );
            } else if rank(nh) < rank(oh) {
                push(
                    &mut f,
                    "classification",
                    "breaking",
                    "handling-loosened",
                    k.clone(),
                    format!("{oh} -> {nh}"),
                );
            }
        }
    }
    for (k, (nc, _, personal)) in &ns {
        if !os.contains_key(k) && personal == "yes" {
            push(
                &mut f,
                "classification",
                "risk",
                "personal-field-added",
                k.clone(),
                format!(
                    "new personal-data field classified {nc}: purpose surfaces and subject rights must cover it"
                ),
            );
        }
    }
    let subs = |v: &Value| -> BTreeMap<String, String> {
        arr(v, &["dataSemantics", "subjects"])
            .into_iter()
            .map(|x| {
                (
                    s(&x["resource"]),
                    format!(
                        "{}{}",
                        s(&x["kind"]),
                        x["via"]
                            .as_str()
                            .map(|v| format!(" via {v}"))
                            .unwrap_or_default()
                    ),
                )
            })
            .collect()
    };
    let (osb, nsb) = (subs(old), subs(new));
    for (r, b) in &osb {
        match nsb.get(r) {
            None => push(
                &mut f,
                "classification",
                "breaking",
                "subject-binding-removed",
                r.clone(),
                "records lose their subject linkage (erasure/access rights)".into(),
            ),
            Some(nb) if nb != b => push(
                &mut f,
                "classification",
                "risk",
                "subject-binding-changed",
                r.clone(),
                format!("{b} -> {nb}"),
            ),
            _ => {}
        }
    }
    for r in nsb.keys() {
        if !osb.contains_key(r) {
            push(
                &mut f,
                "classification",
                "additive",
                "subject-binding-added",
                r.clone(),
                "records gain a subject linkage".into(),
            );
        }
    }

    // ---- workflows: in-flight instances are pinned to (version, graphHash)
    let wfs = |v: &Value| -> BTreeMap<String, (u64, String)> {
        arr(v, &["ir", "modules"])
            .into_iter()
            .flat_map(|m| arr(m, &["workflows"]))
            .map(|w| {
                (
                    s(&w["id"]),
                    (w["version"].as_u64().unwrap_or(0), s(&w["graphHash"])),
                )
            })
            .collect()
    };
    let (ow, nw) = (wfs(old), wfs(new));
    for (id, (ov, oh)) in &ow {
        match nw.get(id) {
            None => push(
                &mut f,
                "workflow",
                "breaking",
                "workflow-removed",
                id.clone(),
                "in-flight instances cannot be advanced".into(),
            ),
            Some((nv, nh)) if nh != oh && nv == ov => push(
                &mut f,
                "workflow",
                "breaking",
                "graph-changed-without-version",
                id.clone(),
                "in-flight instances pinned to this version would be reinterpreted; bump `version`"
                    .into(),
            ),
            Some((nv, nh)) if nh != oh && nv != ov => push(
                &mut f,
                "workflow",
                "migration",
                "workflow-version-bumped",
                id.clone(),
                format!(
                    "v{ov} instances keep running on the old graph until drained; v{nv} starts fresh"
                ),
            ),
            _ => {}
        }
    }

    // ---- interfaces: the OpenAPI projection (endpoints and their required parameters)
    let endpoints = |v: &Value| -> BTreeMap<String, Vec<String>> {
        let mut out = BTreeMap::new();
        if let Some(paths) = v["openapi"]["paths"].as_object() {
            for (path, ops) in paths {
                if let Some(ops) = ops.as_object() {
                    for (method, op) in ops {
                        let required: Vec<String> = arr(op, &["parameters"])
                            .into_iter()
                            .filter(|p| p["required"] == Value::Bool(true) && p["in"] != "path")
                            .map(|p| s(&p["name"]))
                            .collect();
                        out.insert(format!("{} {}", method.to_uppercase(), path), required);
                    }
                }
            }
        }
        out
    };
    let (oep, nep) = (endpoints(old), endpoints(new));
    for (k, oreq) in &oep {
        match nep.get(k) {
            None => push(
                &mut f,
                "interfaces",
                "breaking",
                "endpoint-removed",
                k.clone(),
                "generated clients, CLI users and MCP tools calling it break".into(),
            ),
            Some(nreq) => {
                for p in nreq {
                    if !oreq.contains(p) {
                        push(
                            &mut f,
                            "interfaces",
                            "breaking",
                            "parameter-required",
                            format!("{k} ?{p}"),
                            "existing callers do not send it".into(),
                        );
                    }
                }
            }
        }
    }
    for k in nep.keys() {
        if !oep.contains_key(k) {
            push(
                &mut f,
                "interfaces",
                "additive",
                "endpoint-added",
                k.clone(),
                "new endpoint".into(),
            );
        }
    }

    // ---- governance: purpose surfaces (edition 2027). Narrowing invalidates broad cached values and receipts;
    // widening is new authority and needs reapproval by the callee owners.
    let surfaces = |v: &Value| -> BTreeMap<String, (Vec<String>, Vec<String>)> {
        arr(v, &["capabilities", "surfaces"])
            .into_iter()
            .map(|sf| {
                (
                    format!("{}#{}", s(&sf["resource"]), s(&sf["purpose"])),
                    (
                        arr(sf, &["allowAtoms"])
                            .into_iter()
                            .map(|a| format!("{}:{}", s(&a["verb"]), s(&a["name"])))
                            .collect(),
                        arr(sf, &["deny"])
                            .into_iter()
                            .map(|a| format!("{}:{}", s(&a["verb"]), s(&a["name"])))
                            .collect(),
                    ),
                )
            })
            .collect()
    };
    let (osf, nsf) = (surfaces(old), surfaces(new));
    for (k, (oa, od)) in &osf {
        match nsf.get(k) {
            None => push(&mut f, "governance", "breaking", "surface-removed", k.clone(), "callers under this purpose lose every atom; cached values and receipts for it must go".into()),
            Some((na, nd)) => {
                let removed: Vec<&String> = oa.iter().filter(|a| !na.contains(a)).collect();
                let added: Vec<&String> = na.iter().filter(|a| !oa.contains(a)).collect();
                if !removed.is_empty() {
                    push(&mut f, "governance", "migration", "surface-narrowed", k.clone(), format!("atoms removed: {}; values cached under the old surface must be re-projected under the current one before disclosure", removed.iter().map(|x| x.as_str()).collect::<Vec<_>>().join(", ")));
                }
                if !added.is_empty() {
                    push(&mut f, "governance", "risk", "surface-widened", k.clone(), format!("atoms added: {}; new authority requires reapproval", added.iter().map(|x| x.as_str()).collect::<Vec<_>>().join(", ")));
                }
                for d in nd {
                    if !od.contains(d) {
                        push(&mut f, "governance", "migration", "deny-added", format!("{k} {d}"), "sticky denial; anything that relied on the atom must be re-checked".into());
                    }
                }
                for d in od {
                    if !nd.contains(d) {
                        push(&mut f, "governance", "risk", "deny-removed", format!("{k} {d}"), "a sticky denial was lifted: new authority".into());
                    }
                }
            }
        }
    }
    for k in nsf.keys() {
        if !osf.contains_key(k) {
            push(
                &mut f,
                "governance",
                "risk",
                "surface-added",
                k.clone(),
                "a new purpose surface: authority that did not exist before".into(),
            );
        }
    }
    let purposes = |v: &Value| -> Vec<String> {
        arr(v, &["ir", "modules"])
            .into_iter()
            .flat_map(|m| arr(m, &["purposes"]))
            .map(|p| s(&p["id"]))
            .collect()
    };
    let (opu, npu) = (purposes(old), purposes(new));
    for p in &opu {
        if !npu.contains(p) {
            push(
                &mut f,
                "governance",
                "breaking",
                "purpose-removed",
                p.clone(),
                "credentials and grants naming this purpose become invalid".into(),
            );
        }
    }

    // ---- dependencies: imports are cross-service edges that need grants (M16)
    let imports = |v: &Value| -> Vec<String> {
        arr(v, &["ir", "imports"])
            .into_iter()
            .map(|i| s(&i["package"]))
            .collect()
    };
    let (oi, ni) = (imports(old), imports(new));
    for p in &ni {
        if !oi.contains(p) {
            push(&mut f, "dependencies", "migration", "dependency-added", p.clone(), "a new callee: a dependency request must be approved and activated before the edge works".into());
        }
    }
    for p in &oi {
        if !ni.contains(p) {
            push(
                &mut f,
                "dependencies",
                "migration",
                "dependency-removed",
                p.clone(),
                "releases still using the grant need the declared drain".into(),
            );
        }
    }

    // ---- policy: an opaque external policy bundle can only be compared by digest unless a supported proof is attached
    let (op, np) = (&old["policy"], &new["policy"]);
    if (!op.is_null() || !np.is_null()) && op["digest"] != np["digest"] {
        let proof = &np["proof"];
        let supported = proof["basis"] == "forge-policy-diff" && proof["for"] == op["digest"];
        match (supported, proof["relation"].as_str()) {
            (true, Some("narrowing")) => push(
                &mut f,
                "policy",
                "migration",
                "policy-narrowed",
                s(&np["kind"]),
                "proven narrowing: cached allows must be re-decided".into(),
            ),
            (true, Some("widening")) => push(
                &mut f,
                "policy",
                "risk",
                "policy-widened",
                s(&np["kind"]),
                "proven widening: new authority requires reapproval".into(),
            ),
            (true, Some("equivalent")) => {}
            _ => push(
                &mut f,
                "policy",
                "unknown",
                "policy-changed-unknown",
                s(&np["kind"]),
                format!(
                    "policy digest {} -> {}: no supported proof establishes widening or narrowing; treat as changed",
                    s(&op["digest"]),
                    s(&np["digest"])
                ),
            ),
        }
    }

    // Explain effective-shape changes using semantic origins, never source paths.
    let mut origins = BTreeMap::new();
    for artifact in [old, new] {
        for module in arr(artifact, &["ir", "modules"]) {
            if let Some(map) = module["facetOrigins"].as_object() {
                for (anchor, origin) in map {
                    origins.insert(anchor.replace("#field:", "."), s(origin));
                }
            }
        }
    }
    for finding in &mut f {
        if let Some(origin) = origins.get(&finding.subject) {
            finding
                .detail
                .push_str(&format!("; field contributed by {origin}"));
        }
    }
    let rank = |sev: &str| match sev {
        "breaking" => 4,
        "risk" => 3,
        "unknown" => 2,
        "migration" => 1,
        _ => 0,
    };
    let name = |r: i32| match r {
        4 => "breaking",
        3 => "risk",
        2 => "unknown",
        1 => "migration",
        _ => "compatible",
    };
    let worst = f.iter().map(|x| rank(x.severity)).max().unwrap_or(0);
    let mut streams: BTreeMap<&'static str, &'static str> = BTreeMap::new();
    for x in &f {
        let r = rank(x.severity);
        let e = streams.entry(x.stream).or_insert("compatible");
        if rank(e) < r {
            *e = name(r);
        }
    }
    Report {
        version: COMPAT_VERSION,
        old_build: s(&old["buildHash"]),
        new_build: s(&new["buildHash"]),
        verdict: name(worst),
        streams,
        facts: Facts {
            live_data: "none: offline diff; affected-row counts and backfill sizes are measured during rollout, never guessed here",
            policy_proof: if np.is_null() {
                "no policy bundle in the model"
            } else if np["proof"].is_null() {
                "none attached"
            } else {
                "attached"
            },
        },
        findings: f,
    }
}

/// Audience-specific Markdown. `pr` lists everything with needs; `changelog` is the user-facing subset;
/// `security` is governance/classification/dependencies/policy only.
pub fn render(report: &Report, audience: &str) -> String {
    let mut out = String::new();
    let title = match audience {
        "changelog" => "Changes",
        "security" => "Security review",
        _ => "Compatibility report",
    };
    out.push_str(&format!(
        "## {title}

Verdict: **{}** ({} -> {})

",
        report.verdict,
        &report.old_build[..report.old_build.len().min(12)],
        &report.new_build[..report.new_build.len().min(12)]
    ));
    let include = |x: &Finding| match audience {
        "changelog" => {
            matches!(x.stream, "api" | "interfaces" | "lifecycle" | "event")
                && x.severity != "unknown"
        }
        "security" => matches!(
            x.stream,
            "governance" | "classification" | "dependencies" | "policy"
        ),
        _ => true,
    };
    let mut by_stream: BTreeMap<&str, Vec<&Finding>> = BTreeMap::new();
    for x in report.findings.iter().filter(|x| include(x)) {
        by_stream.entry(x.stream).or_default().push(x);
    }
    if by_stream.is_empty() {
        out.push_str(
            "No changes in scope.
",
        );
    }
    for (stream, xs) in by_stream {
        out.push_str(&format!(
            "### {stream}

"
        ));
        for x in xs {
            let dir = x
                .direction
                .filter(|d| *d != "none")
                .map(|d| format!(" (breaks: {d})"))
                .unwrap_or_default();
            let needs = if x.needs.is_empty() || audience == "changelog" {
                String::new()
            } else {
                format!(" — needs: {}", x.needs.join(", "))
            };
            out.push_str(&format!(
                "- **{}** `{}` {}{}: {}{}
",
                x.severity, x.code, x.subject, dir, x.detail, needs
            ));
        }
        out.push('\n');
    }
    if audience != "changelog" {
        out.push_str(&format!(
            "_Live data: {}_
",
            report.facts.live_data
        ));
    }
    out
}
