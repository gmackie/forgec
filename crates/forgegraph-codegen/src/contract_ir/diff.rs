//! `forgec contract-diff`: compare two contract IR documents per operation.
//!
//! Operations are matched by transport (method and OpenAPI path with the
//! parameter names erased; RPC by procedure), not by id, so a renamed
//! operation is one `id` difference rather than a removal plus an addition.
//! Schemas are compared after resolving `$ref`s against each side's own
//! components, ignoring fingerprints, schema ids/titles, key order, the
//! order of `required` and `x-forge-enum` (the Forge enum's declaration id;
//! its values are still compared): two contracts that describe the same
//! wire shapes compare equal whatever their declaration names.
//!
//! Each difference has a `kind` (`id`, `transport.path`, `request.params`,
//! `request.query`, `request.headers`, `request.bodies`, `successes`,
//! `errors`, `response.<status>`, `policy.*`, `middleware`, `contract.*`,
//! `added`, `removed`); callers name the kinds they expect with `ignore`
//! (a kind or a dotted prefix of one) and only the rest are blocking.
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

use super::emit::REF_PREFIX;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Difference {
    pub kind: String,
    /// The matched route (`GET /v1/things/{}`) or `contract`.
    pub at: String,
    pub detail: String,
    /// True when the kind is one the caller declared expected.
    pub ignored: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DiffReport {
    pub version: String,
    /// Operations present on both sides with no difference at all.
    pub equal: usize,
    pub differences: Vec<Difference>,
    /// Differences whose kind was not ignored.
    pub blocking: usize,
}

impl DiffReport {
    pub fn is_clean(&self) -> bool {
        self.blocking == 0
    }

    /// The distinct kinds present, for summaries and tests.
    pub fn kinds(&self) -> BTreeSet<String> {
        self.differences.iter().map(|d| d.kind.clone()).collect()
    }
}

pub fn diff(a: &Value, b: &Value, ignore: &[String]) -> DiffReport {
    let mut differences = Vec::new();
    let mut push = |kind: &str, at: &str, detail: String| {
        differences.push(Difference {
            kind: kind.into(),
            at: at.into(),
            detail,
            ignored: ignore
                .iter()
                .any(|i| kind == i || kind.starts_with(&format!("{i}."))),
        });
    };
    for field in ["serviceId", "apiId", "securitySchemes"] {
        if a[field] != b[field] {
            let detail = format!("{} → {}", short(&a[field]), short(&b[field]));
            push(&format!("contract.{field}"), "contract", detail);
        }
    }
    let ops_a = by_route(a);
    let ops_b = by_route(b);
    let mut equal = 0;
    for (route, op_a) in &ops_a {
        let Some(op_b) = ops_b.get(route) else {
            let id = op_a["id"].as_str().unwrap_or("?");
            push(
                "removed",
                route,
                format!("{id} is not in the second contract"),
            );
            continue;
        };
        let changes = compare_operation((a, op_a), (b, op_b));
        if changes.is_empty() {
            equal += 1;
        }
        for (kind, detail) in changes {
            push(&kind, route, detail);
        }
    }
    for (route, op_b) in &ops_b {
        if !ops_a.contains_key(route) {
            let id = op_b["id"].as_str().unwrap_or("?");
            push("added", route, format!("{id} is not in the first contract"));
        }
    }
    let blocking = differences.iter().filter(|d| !d.ignored).count();
    DiffReport {
        version: "contract-diff/1".into(),
        equal,
        differences,
        blocking,
    }
}

fn short(v: &Value) -> String {
    let s = v.to_string();
    if s.chars().count() > 80 {
        format!("{}…", s.chars().take(77).collect::<String>())
    } else {
        s
    }
}

/// Route key → operation. Parameter names are erased so `/x/{id}` and
/// `/x/{xId}` match (the rename is reported as `transport.path`).
fn by_route(contract: &Value) -> BTreeMap<String, &Value> {
    let mut out = BTreeMap::new();
    for op in contract["operations"].as_array().into_iter().flatten() {
        let t = &op["transport"];
        let key = if t["type"] == "http" {
            let path: Vec<&str> = t["openApiPath"]
                .as_str()
                .unwrap_or_default()
                .split('/')
                .map(|s| if s.starts_with('{') { "{}" } else { s })
                .collect();
            format!("{} {}", t["method"].as_str().unwrap_or("?"), path.join("/"))
        } else {
            format!("RPC {}", t["procedure"].as_str().unwrap_or("?"))
        };
        out.insert(key, op);
    }
    out
}

/// `(kind, detail)` for every way two matched operations differ.
fn compare_operation(
    (ca, a): (&Value, &Value),
    (cb, b): (&Value, &Value),
) -> Vec<(String, String)> {
    let mut changes = Vec::new();
    let mut report = |kind: &str, detail: String| changes.push((kind.to_string(), detail));
    if a["id"] != b["id"] {
        report(
            "id",
            format!(
                "{} → {}",
                a["id"].as_str().unwrap_or("?"),
                b["id"].as_str().unwrap_or("?")
            ),
        );
    }
    if a["transport"]["openApiPath"] != b["transport"]["openApiPath"] {
        report(
            "transport.path",
            format!(
                "{} → {}",
                a["transport"]["openApiPath"], b["transport"]["openApiPath"]
            ),
        );
    }
    for slot in ["params", "query", "headers"] {
        let sa = a["request"].get(slot).map(|s| expand(&s["jsonSchema"], ca));
        let sb = b["request"].get(slot).map(|s| expand(&s["jsonSchema"], cb));
        if let Some(detail) = compare_parameters(sa.as_ref(), sb.as_ref()) {
            report(&format!("request.{slot}"), detail);
        }
    }
    if let Some(detail) = compare_bodies(&a["request"]["bodies"], ca, &b["request"]["bodies"], cb) {
        report("request.bodies", detail);
    }
    for side in ["successes", "errors"] {
        let ra = responses(&a[side]);
        let rb = responses(&b[side]);
        let sa: BTreeSet<u64> = ra.keys().copied().collect();
        let sb: BTreeSet<u64> = rb.keys().copied().collect();
        if sa != sb {
            report(side, format!("{sa:?} → {sb:?}"));
        }
        for status in sa.intersection(&sb) {
            if let Some(detail) = compare_bodies(ra[status], ca, rb[status], cb) {
                report(&format!("response.{status}"), detail);
            }
        }
    }
    let (pa, pb) = (&a["policy"], &b["policy"]);
    for field in ["isPublic", "authentication", "sla", "slo"] {
        if pa.get(field) != pb.get(field) {
            report(
                &format!("policy.{field}"),
                format!(
                    "{} → {}",
                    short(pa.get(field).unwrap_or(&Value::Null)),
                    short(pb.get(field).unwrap_or(&Value::Null))
                ),
            );
        }
    }
    if a["middleware"] != b["middleware"] {
        report(
            "middleware",
            format!("{} → {}", short(&a["middleware"]), short(&b["middleware"])),
        );
    }
    changes
}

fn responses(list: &Value) -> BTreeMap<u64, &Value> {
    list.as_array()
        .into_iter()
        .flatten()
        .map(|r| (r["status"].as_u64().unwrap_or_default(), &r["bodies"]))
        .collect()
}

/// `+name` / `-name` / `~name` (schema or requiredness changed) per property.
fn compare_parameters(a: Option<&Value>, b: Option<&Value>) -> Option<String> {
    let props = |s: Option<&Value>| {
        s.and_then(|s| s.get("properties"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    };
    let required = |s: Option<&Value>| -> BTreeSet<String> {
        s.and_then(|s| s.get("required"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(String::from))
            .collect()
    };
    let (pa, pb) = (props(a), props(b));
    let (ra, rb) = (required(a), required(b));
    let names: BTreeSet<&String> = pa.keys().chain(pb.keys()).collect();
    let mut changes = Vec::new();
    for name in names {
        match (pa.get(name), pb.get(name)) {
            (Some(_), None) => changes.push(format!("-{name}")),
            (None, Some(_)) => changes.push(format!("+{name}")),
            (Some(x), Some(y)) => {
                if x != y || ra.contains(name) != rb.contains(name) {
                    let why = first_difference(x, y, "").unwrap_or_else(|| "required".into());
                    changes.push(format!("~{name} ({why})"));
                }
            }
            (None, None) => {}
        }
    }
    (!changes.is_empty()).then(|| changes.join(", "))
}

fn compare_bodies(a: &Value, ca: &Value, b: &Value, cb: &Value) -> Option<String> {
    let index = |bodies: &Value, c: &Value| -> BTreeMap<String, Value> {
        bodies
            .as_array()
            .into_iter()
            .flatten()
            .map(|body| {
                (
                    body["contentType"].as_str().unwrap_or_default().to_string(),
                    expand(&body["schema"]["jsonSchema"], c),
                )
            })
            .collect()
    };
    let (ia, ib) = (index(a, ca), index(b, cb));
    let ta: BTreeSet<&String> = ia.keys().collect();
    let tb: BTreeSet<&String> = ib.keys().collect();
    if ta != tb {
        return Some(format!("content types {ta:?} → {tb:?}"));
    }
    ia.iter()
        .find_map(|(ct, sa)| first_difference(sa, &ib[ct], "").map(|d| format!("{ct}: {d}")))
}

/// The first JSON pointer at which two normalized schemas differ.
fn first_difference(a: &Value, b: &Value, at: &str) -> Option<String> {
    if a == b {
        return None;
    }
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let keys: BTreeSet<&String> = x.keys().chain(y.keys()).collect();
            for k in keys {
                let here = format!("{at}/{k}");
                match (x.get(k), y.get(k)) {
                    (Some(_), None) => return Some(format!("{here} removed")),
                    (None, Some(_)) => return Some(format!("{here} added")),
                    (Some(p), Some(q)) => {
                        if let Some(d) = first_difference(p, q, &here) {
                            return Some(d);
                        }
                    }
                    (None, None) => {}
                }
            }
            None
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => x
            .iter()
            .zip(y)
            .enumerate()
            .find_map(|(i, (p, q))| first_difference(p, q, &format!("{at}/{i}"))),
        _ => Some(format!(
            "{} {} → {}",
            if at.is_empty() { "/" } else { at },
            short(a),
            short(b)
        )),
    }
}

/// Inline every component `$ref` (a cycle stays a `$ref` to its name), sort
/// `required` and drop `x-forge-enum`, so schemas compare by shape rather
/// than by naming.
fn expand(schema: &Value, contract: &Value) -> Value {
    let components = contract["components"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    expand_in(schema, &components, &mut Vec::new())
}

fn expand_in(schema: &Value, components: &Map<String, Value>, stack: &mut Vec<String>) -> Value {
    match schema {
        Value::Object(map) => {
            if let Some(name) = map
                .get("$ref")
                .and_then(Value::as_str)
                .and_then(|r| r.strip_prefix(REF_PREFIX))
                && let Some(target) = components.get(name)
            {
                if stack.iter().any(|s| s == name) {
                    return json!({ "$ref": name });
                }
                stack.push(name.to_string());
                let mut inlined = expand_in(target, components, stack);
                stack.pop();
                // Sibling keywords next to `$ref` (2020-12) still apply.
                if let Value::Object(target) = &mut inlined {
                    for (k, v) in map.iter().filter(|(k, _)| *k != "$ref") {
                        target.insert(k.clone(), expand_in(v, components, stack));
                    }
                }
                return inlined;
            }
            let mut out = Map::new();
            for (k, v) in map.iter().filter(|(k, _)| *k != "x-forge-enum") {
                let mut v = expand_in(v, components, stack);
                if k == "required"
                    && let Value::Array(items) = &mut v
                {
                    items.sort_by_key(|x| x.to_string());
                }
                out.insert(k.clone(), v);
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|v| expand_in(v, components, stack))
                .collect(),
        ),
        other => other.clone(),
    }
}
