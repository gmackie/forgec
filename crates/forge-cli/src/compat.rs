//! `forge compat OLD NEW`: compatibility report between two app bundles (plan §22).
//! Streams are tracked separately — API, event, storage, lifecycle, workflow —
//! because "additive" is not universally safe: an enum output member can break
//! exhaustive consumers, an added lifecycle state changes the event vocabulary,
//! a workflow graph change with the same version violates in-flight pins.
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

pub const COMPAT_VERSION: &str = "compat/1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub stream: &'static str,
    /// breaking | risk | migration | additive
    pub severity: &'static str,
    pub code: &'static str,
    pub subject: String,
    pub detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub version: &'static str,
    pub old_build: String,
    pub new_build: String,
    /// compatible | migration | risk | breaking (the most severe finding)
    pub verdict: &'static str,
    pub findings: Vec<Finding>,
}

fn arr<'a>(v: &'a Value, path: &[&str]) -> Vec<&'a Value> {
    let mut cur = v;
    for p in path {
        cur = &cur[*p];
    }
    cur.as_array().map(|a| a.iter().collect()).unwrap_or_default()
}
fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}
fn by_id<'a>(items: Vec<&'a Value>, key: &str) -> BTreeMap<String, &'a Value> {
    items.into_iter().map(|i| (s(&i[key]), i)).collect()
}

pub fn compare(old: &Value, new: &Value) -> Report {
    let mut f: Vec<Finding> = Vec::new();
    let push = |f: &mut Vec<Finding>, stream: &'static str, severity: &'static str, code: &'static str, subject: String, detail: String| f.push(Finding { stream, severity, code, subject, detail });

    // ---- API: contracts (record/create/patch schemas per resource, operations, functions, enums)
    let old_res = by_id(arr(old, &["contracts", "resources"]), "id");
    let new_res = by_id(arr(new, &["contracts", "resources"]), "id");
    for (id, o) in &old_res {
        let Some(n) = new_res.get(id) else {
            push(&mut f, "api", "breaking", "resource-removed", id.clone(), "clients and readers of this resource break".into());
            continue;
        };
        let props = |v: &Value, schema: &str| v[schema]["properties"].as_object().map(|m| m.keys().cloned().map(|k| (k, ())).collect::<BTreeMap<_, _>>()).unwrap_or_default();
        let required = |v: &Value, schema: &str| v[schema]["required"].as_array().map(|a| a.iter().map(s).collect::<Vec<_>>()).unwrap_or_default();
        let (op, np) = (props(o, "record"), props(n, "record"));
        for k in op.keys() {
            if !np.contains_key(k) {
                push(&mut f, "api", "breaking", "field-removed", format!("{id}.{k}"), "existing readers expect this field".into());
            }
        }
        for k in np.keys() {
            if !op.contains_key(k) {
                push(&mut f, "api", "additive", "field-added", format!("{id}.{k}"), "new output field; readers ignoring unknown fields are unaffected".into());
            }
        }
        let (oc, nc) = (required(o, "create"), required(n, "create"));
        for k in &nc {
            if !oc.contains(k) {
                push(&mut f, "api", "breaking", "field-required", format!("{id}.{k}"), "existing writers do not send this now-required field".into());
            }
        }
        for k in &oc {
            if !nc.contains(k) && props(n, "create").contains_key(k) {
                push(&mut f, "api", "additive", "field-optional", format!("{id}.{k}"), "writers may omit it; readers must accept null".into());
            }
        }
        let oops = by_id(arr(o, &["operations"]), "id");
        let nops = by_id(arr(n, &["operations"]), "id");
        for k in oops.keys() {
            if !nops.contains_key(k) {
                push(&mut f, "api", "breaking", "operation-removed", k.clone(), "callers of this operation break".into());
            }
        }
        for k in nops.keys() {
            if !oops.contains_key(k) {
                push(&mut f, "api", "additive", "operation-added", k.clone(), "new operation".into());
            }
        }
    }
    for id in new_res.keys() {
        if !old_res.contains_key(id) {
            push(&mut f, "api", "additive", "resource-added", id.clone(), "new resource".into());
        }
    }
    let old_fns = by_id(arr(old, &["contracts", "functions"]), "id");
    let new_fns = by_id(arr(new, &["contracts", "functions"]), "id");
    for (id, o) in &old_fns {
        match new_fns.get(id) {
            None => push(&mut f, "api", "breaking", "function-removed", id.clone(), "callers break".into()),
            Some(n) => {
                if o["http"] != n["http"] {
                    push(&mut f, "api", "breaking", "http-binding-changed", id.clone(), "path or method changed".into());
                }
                let oe: Vec<String> = arr(o, &["errors"]).into_iter().map(s).collect();
                for e in arr(n, &["errors"]).into_iter().map(s) {
                    if !oe.contains(&e) {
                        push(&mut f, "api", "risk", "error-added", format!("{id}.{e}"), "callers with exhaustive error handling must learn it".into());
                    }
                }
            }
        }
    }
    for id in new_fns.keys() {
        if !old_fns.contains_key(id) {
            push(&mut f, "api", "additive", "function-added", id.clone(), "new function".into());
        }
    }
    // enums: members are output values; adding one breaks exhaustive consumers
    let enums = |v: &Value| -> BTreeMap<String, Vec<String>> {
        arr(v, &["ir", "modules"]).into_iter().flat_map(|m| arr(m, &["enums"])).map(|e| (s(&e["id"]), arr(e, &["members"]).into_iter().map(|x| s(&x["name"])).collect())).collect()
    };
    let (oe, ne) = (enums(old), enums(new));
    for (id, om) in &oe {
        if let Some(nm) = ne.get(id) {
            for m in nm {
                if !om.contains(m) {
                    push(&mut f, "api", "risk", "enum-member-added", format!("{id}.{m}"), "exhaustive consumers of this enum must handle the new member".into());
                }
            }
            for m in om {
                if !nm.contains(m) {
                    push(&mut f, "api", "breaking", "enum-member-removed", format!("{id}.{m}"), "stored or sent values may no longer decode".into());
                }
            }
        }
    }

    // ---- lifecycle + events
    let lifecycles = |v: &Value| -> BTreeMap<String, (Vec<String>, Vec<String>)> {
        arr(v, &["ir", "modules"]).into_iter().flat_map(|m| arr(m, &["resources"])).filter(|r| !r["lifecycle"].is_null()).map(|r| (s(&r["id"]), (arr(&r["lifecycle"], &["states"]).into_iter().map(s).collect(), arr(&r["lifecycle"], &["transitions"]).into_iter().map(|t| s(&t["action"])).collect()))).collect()
    };
    let (ol, nl) = (lifecycles(old), lifecycles(new));
    for (id, (os, oa)) in &ol {
        if let Some((ns, na)) = nl.get(id) {
            for st in ns {
                if !os.contains(st) {
                    push(&mut f, "lifecycle", "additive", "state-added", format!("{id}.{st}"), "new state; consumers switching on status must handle it".into());
                }
            }
            for st in os {
                if !ns.contains(st) {
                    push(&mut f, "lifecycle", "breaking", "state-removed", format!("{id}.{st}"), "stored records may be in this state".into());
                }
            }
            for a in na {
                if !oa.contains(a) {
                    push(&mut f, "lifecycle", "additive", "transition-added", format!("{id}.{a}"), "new action".into());
                }
            }
            for a in oa {
                if !na.contains(a) {
                    push(&mut f, "lifecycle", "breaking", "transition-removed", format!("{id}.{a}"), "callers of this action break".into());
                }
            }
        }
    }
    let channels = |v: &Value| -> BTreeMap<String, Vec<String>> {
        arr(v, &["messaging", "channels"]).into_iter().map(|c| (s(&c["id"]), arr(c, &["messages"]).into_iter().map(|m| s(&m["name"])).collect())).collect()
    };
    let (oc, nc) = (channels(old), channels(new));
    for (id, om) in &oc {
        match nc.get(id) {
            None => push(&mut f, "event", "breaking", "channel-removed", id.clone(), "subscribers lose their source".into()),
            Some(nm) => {
                for m in nm {
                    if !om.contains(m) {
                        push(&mut f, "event", "risk", "message-added", format!("{id}.{m}"), "consumers must ignore or handle the new message".into());
                    }
                }
                for m in om {
                    if !nm.contains(m) {
                        push(&mut f, "event", "breaking", "message-removed", format!("{id}.{m}"), "in-flight and replayed messages may carry it".into());
                    }
                }
            }
        }
    }

    // ---- storage (D1 physical schema; DynamoDB attributes follow the same field set)
    let tables = |v: &Value| -> BTreeMap<String, BTreeMap<String, String>> {
        arr(v, &["sql", "tables"]).into_iter().map(|t| (s(&t["name"]), arr(t, &["columns"]).into_iter().map(|c| (s(&c["name"]), s(&c["sqlType"]))).collect())).collect()
    };
    let (ot, nt) = (tables(old), tables(new));
    for (name, ocols) in &ot {
        match nt.get(name) {
            None => push(&mut f, "storage", "breaking", "table-removed", name.clone(), "data would be dropped; requires an explicit migration and retention decision".into()),
            Some(ncols) => {
                for (c, ty) in ocols {
                    match ncols.get(c) {
                        None => push(&mut f, "storage", "breaking", "column-removed", format!("{name}.{c}"), "stored values would be dropped".into()),
                        Some(nty) if nty != ty => push(&mut f, "storage", "migration", "column-type-changed", format!("{name}.{c}"), format!("{ty} -> {nty}: values must be rewritten")),
                        _ => {}
                    }
                }
                for c in ncols.keys() {
                    if !ocols.contains_key(c) {
                        push(&mut f, "storage", "migration", "column-added", format!("{name}.{c}"), "additive DDL (ALTER TABLE ADD COLUMN) before the new readers deploy".into());
                    }
                }
            }
        }
    }
    for name in nt.keys() {
        if !ot.contains_key(name) {
            push(&mut f, "storage", "migration", "table-added", name.clone(), "additive DDL before the new readers deploy".into());
        }
    }

    // ---- classification: data semantics and subject bindings (M11); loosening is breaking for governance
    let sem = |v: &Value| -> BTreeMap<String, (String, String, String)> {
        arr(v, &["dataSemantics", "fields"]).into_iter().map(|f| (format!("{}.{}", s(&f["resource"]), s(&f["field"])), (s(&f["class"]), s(&f["handling"]), s(&f["personal"])))).collect()
    };
    let (os, ns) = (sem(old), sem(new));
    let rank = |h: &str| match h { "public" => 0, "internal" => 1, "confidential" => 2, "restricted" => 3, _ => 4 };
    for (k, (oc, oh, _)) in &os {
        if let Some((nc, nh, _)) = ns.get(k) {
            if oc != nc {
                push(&mut f, "classification", if rank(nh) < rank(oh) { "breaking" } else { "risk" }, "class-changed", k.clone(), format!("{oc} -> {nc}: consumers, grants and retention rules keyed on the class need review"));
            } else if rank(nh) < rank(oh) {
                push(&mut f, "classification", "breaking", "handling-loosened", k.clone(), format!("{oh} -> {nh}"));
            }
        }
    }
    for (k, (nc, _, personal)) in &ns {
        if !os.contains_key(k) && personal == "yes" {
            push(&mut f, "classification", "risk", "personal-field-added", k.clone(), format!("new personal-data field classified {nc}: purpose surfaces and subject rights must cover it"));
        }
    }
    let subs = |v: &Value| -> BTreeMap<String, String> { arr(v, &["dataSemantics", "subjects"]).into_iter().map(|x| (s(&x["resource"]), format!("{}{}", s(&x["kind"]), x["via"].as_str().map(|v| format!(" via {v}")).unwrap_or_default()))).collect() };
    let (osb, nsb) = (subs(old), subs(new));
    for (r, b) in &osb {
        match nsb.get(r) {
            None => push(&mut f, "classification", "breaking", "subject-binding-removed", r.clone(), "records lose their subject linkage (erasure/access rights)".into()),
            Some(nb) if nb != b => push(&mut f, "classification", "risk", "subject-binding-changed", r.clone(), format!("{b} -> {nb}")),
            _ => {}
        }
    }
    for r in nsb.keys() {
        if !osb.contains_key(r) {
            push(&mut f, "classification", "additive", "subject-binding-added", r.clone(), "records gain a subject linkage".into());
        }
    }

    // ---- workflows: in-flight instances are pinned to (version, graphHash)
    let wfs = |v: &Value| -> BTreeMap<String, (u64, String)> {
        arr(v, &["ir", "modules"]).into_iter().flat_map(|m| arr(m, &["workflows"])).map(|w| (s(&w["id"]), (w["version"].as_u64().unwrap_or(0), s(&w["graphHash"])))).collect()
    };
    let (ow, nw) = (wfs(old), wfs(new));
    for (id, (ov, oh)) in &ow {
        match nw.get(id) {
            None => push(&mut f, "workflow", "breaking", "workflow-removed", id.clone(), "in-flight instances cannot be advanced".into()),
            Some((nv, nh)) if nh != oh && nv == ov => push(&mut f, "workflow", "breaking", "graph-changed-without-version", id.clone(), "in-flight instances pinned to this version would be reinterpreted; bump `version`".into()),
            Some((nv, nh)) if nh != oh && nv != ov => push(&mut f, "workflow", "migration", "workflow-version-bumped", id.clone(), format!("v{ov} instances keep running on the old graph until drained; v{nv} starts fresh")),
            _ => {}
        }
    }

    let rank = |sev: &str| match sev { "breaking" => 3, "risk" => 2, "migration" => 1, _ => 0 };
    let worst = f.iter().map(|x| rank(x.severity)).max().unwrap_or(0);
    let verdict = match worst { 3 => "breaking", 2 => "risk", 1 => "migration", _ => "compatible" };
    Report { version: COMPAT_VERSION, old_build: s(&old["buildHash"]), new_build: s(&new["buildHash"]), verdict, findings: f }
}
