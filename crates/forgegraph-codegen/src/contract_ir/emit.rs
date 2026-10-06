//! `contract.json`: the OpenAPI projection re-expressed as ForgeGraph's
//! contract IR v1, the way `@forgegraph/contract/effect` builds one from
//! `OpenApi.fromApi`. Deriving it from `openapi.json` keeps the two exports
//! one projection: an operation is in the contract exactly when it is in the
//! OpenAPI document, with the same paths, parameters, bodies and statuses.
//!
//! Identity (`<serviceId>.<groupId>.<endpointId>`):
//! - `serviceId`: the last `/` segment of the package name (`@demo/service-desk`
//!   → `service-desk`), unless the caller passes the ForgeGraph app slug;
//! - `groupId`: the resource or workflow name (`Contact.create` → `Contact`),
//!   `functions` for functions; prefixed with the module (non-root modules)
//!   and the package (co-deployed dependencies), joined with `-`;
//! - `endpointId`: the rest of the Forge operation id with `.` → `-`
//!   (`list.byOrganization` → `list-byOrganization`), or the function name.
//!   Forge names never contain `-`, so the mapping cannot collide.
//!
//! Policy: every route sits behind the runtime's ingress `AuthHost`, so
//! authentication is derived from the document's security requirement with
//! ForgeGraph's own scheme classification (bearer → `service`). Nothing in
//! the model marks an operation public, so `isPublic` is `false` (the IR
//! default). Forge declares SLOs, not SLAs: `policy.slo` carries the
//! operation's `x-forge-slo` and `policy.sla` stays empty.
use super::canonical::{fingerprint, js_string_cmp};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const IR_VERSION: u64 = 1;
pub const GENERATOR_NAME: &str = "forgec";
pub const GENERATOR_VERSION: &str = env!("CARGO_PKG_VERSION");
pub(crate) const REF_PREFIX: &str = "#/components/schemas/";
/// The runtime's ingress authenticator, which every served route passes through.
const AUTH_MIDDLEWARE: &str = "@forgegraph/runtime/AuthHost";
const METHODS: [&str; 8] = [
    "get", "post", "put", "patch", "delete", "head", "options", "trace",
];

#[derive(Debug, Clone, Default)]
pub struct EmitOptions {
    /// Forge package name; the OpenAPI operation ids are prefixed with it.
    pub package: String,
    /// The ForgeGraph app slug. Default: [`service_id_for`] of the package.
    pub service_id: Option<String>,
}

/// ForgeGraph's identifier grammar: `^[a-zA-Z][a-zA-Z0-9_-]*$`, at most 128.
pub fn is_identifier(s: &str) -> bool {
    s.len() <= 128
        && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Coerce a name into the identifier grammar: invalid characters become `-`
/// and a name that does not start with a letter gains an `x` prefix.
fn identifier(s: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if !out.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
        out.insert(0, 'x');
    }
    out.truncate(128);
    out
}

/// The default `serviceId` for a package: its unscoped name as an identifier.
pub fn service_id_for(package: &str) -> String {
    identifier(package.rsplit('/').next().unwrap_or(package))
}

/// Build the contract from the `openapi.json` document `forgec build` wrote.
pub fn emit(openapi: &Value, opts: &EmitOptions) -> Result<Value, String> {
    let service_id = opts
        .service_id
        .clone()
        .unwrap_or_else(|| service_id_for(&opts.package));
    if !is_identifier(&service_id) {
        return Err(format!(
            "service id `{service_id}` is not an identifier (letters, digits, _ and -, starting with a letter)"
        ));
    }
    let components = openapi
        .pointer("/components/schemas")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let security_schemes = openapi
        .pointer("/components/securitySchemes")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut operations = Vec::new();
    if let Some(paths) = openapi.get("paths").and_then(Value::as_object) {
        for (path, item) in paths {
            let Some(item) = item.as_object() else {
                continue;
            };
            for (method, op) in item {
                if !METHODS.contains(&method.as_str()) {
                    continue;
                }
                let ctx = OperationContext {
                    doc: openapi,
                    components: &components,
                    security_schemes: &security_schemes,
                    package: &opts.package,
                    service_id: &service_id,
                };
                operations.push(ctx.operation(path, method, op)?);
            }
        }
    }
    operations.sort_by(|a, b| js_string_cmp(id_of(a), id_of(b)));
    let mut contract = json!({
        "irVersion": IR_VERSION,
        "serviceId": service_id,
        "apiId": opts.package,
        "operations": operations,
        "components": components,
        "securitySchemes": security_schemes,
        "fingerprint": "",
        "generator": { "name": GENERATOR_NAME, "version": GENERATOR_VERSION },
    });
    contract["fingerprint"] = json!(fingerprint_contract(&contract));
    let issues = verify(&contract);
    if !issues.is_empty() {
        return Err(issues.join("; "));
    }
    Ok(contract)
}

fn id_of(op: &Value) -> &str {
    op["id"].as_str().unwrap_or_default()
}

struct OperationContext<'a> {
    doc: &'a Value,
    components: &'a Map<String, Value>,
    security_schemes: &'a Map<String, Value>,
    package: &'a str,
    service_id: &'a str,
}

impl OperationContext<'_> {
    fn operation(&self, path: &str, method: &str, op: &Value) -> Result<Value, String> {
        let at = format!("paths.{path}.{method}");
        let forge_id = op
            .get("operationId")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{at}: no operationId"))?;
        let kind = op.get("x-forge-kind").and_then(Value::as_str).unwrap_or("");
        let (group_id, endpoint_id) = self.identity(forge_id, kind);
        for (label, value) in [("groupId", &group_id), ("endpointId", &endpoint_id)] {
            if !is_identifier(value) {
                return Err(format!(
                    "{at}: {label} `{value}` derived from `{forge_id}` is not an identifier"
                ));
            }
        }
        let schemes = self.security_schemes_of(op);
        let derived = derive_authentication(&schemes, self.security_schemes);
        let middleware: Vec<Value> = if schemes.is_empty() {
            Vec::new()
        } else {
            vec![json!({ "key": AUTH_MIDDLEWARE, "security": true, "schemes": schemes })]
        };
        let mut policy = json!({
            "isPublic": false,
            "authentication": {
                "mode": derived,
                "derived": derived,
                "mismatch": false,
                "schemes": schemes,
            },
            "sla": { "policy": {}, "provenance": {} },
        });
        if let Some(slo) = op.get("x-forge-slo").and_then(slo_descriptor) {
            policy["slo"] = slo;
        }
        let parameters = self.parameters(op, &at)?;
        let mut request = Map::new();
        for (slot, location) in [
            ("params", "path"),
            ("query", "query"),
            ("headers", "header"),
        ] {
            if let Some(schema) = parameters_schema(&parameters, location) {
                request.insert(slot.into(), self.schema_ref(schema));
            }
        }
        request.insert(
            "bodies".into(),
            json!(self.bodies(op.pointer("/requestBody/content"))),
        );
        let (successes, errors) = self.responses(op, &at)?;
        let mut operation = json!({
            "id": format!("{}.{group_id}.{endpoint_id}", self.service_id),
            "serviceId": self.service_id,
            "groupId": group_id,
            "endpointId": endpoint_id,
            "transport": {
                "type": "http",
                "method": method.to_ascii_uppercase(),
                "path": effect_path(path),
                "openApiPath": path,
            },
            "policy": policy,
            "request": request,
            "successes": successes,
            "errors": errors,
            "middleware": middleware,
            "fingerprint": "",
        });
        operation["fingerprint"] = json!(fingerprint_operation(&operation));
        Ok(operation)
    }

    /// `(groupId, endpointId)` for a Forge operation id `<package>/<module>/<local>`.
    fn identity(&self, forge_id: &str, kind: &str) -> (String, String) {
        let (prefix, local) = forge_id.rsplit_once('/').unwrap_or(("", forge_id));
        let (package, module) = prefix.rsplit_once('/').unwrap_or((prefix, "_"));
        let mut qualifiers = Vec::new();
        if !package.is_empty() && package != self.package {
            qualifiers.push(service_id_for(package));
        }
        if module != "_" {
            qualifiers.push(module.to_string());
        }
        let (base, endpoint) = match local.split_once('.') {
            Some((base, rest)) if kind != "function" => (base.to_string(), rest.replace('.', "-")),
            _ => ("functions".to_string(), local.to_string()),
        };
        qualifiers.push(base);
        (identifier(&qualifiers.join("-")), identifier(&endpoint))
    }

    /// Scheme names of the effective security requirement (operation, else document), any-of.
    fn security_schemes_of(&self, op: &Value) -> Vec<String> {
        let requirement = op.get("security").or_else(|| self.doc.get("security"));
        let mut names = Vec::new();
        for alternative in requirement.and_then(Value::as_array).into_iter().flatten() {
            for name in alternative.as_object().into_iter().flat_map(|m| m.keys()) {
                if !names.contains(name) {
                    names.push(name.clone());
                }
            }
        }
        names
    }

    fn resolve<'v>(&'v self, value: &'v Value) -> &'v Value {
        match value.get("$ref").and_then(Value::as_str) {
            Some(r) => r
                .strip_prefix('#')
                .and_then(|p| self.doc.pointer(p))
                .unwrap_or(value),
            None => value,
        }
    }

    fn parameters<'v>(&'v self, op: &'v Value, at: &str) -> Result<Vec<&'v Value>, String> {
        let mut out = Vec::new();
        for p in op
            .get("parameters")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let p = self.resolve(p);
            match p.get("in").and_then(Value::as_str) {
                Some("path" | "query" | "header") => out.push(p),
                other => {
                    return Err(format!(
                        "{at}: parameter `{}` in {} has no contract IR slot",
                        p.get("name").and_then(Value::as_str).unwrap_or("?"),
                        other.unwrap_or("an unknown location")
                    ));
                }
            }
        }
        Ok(out)
    }

    fn responses(&self, op: &Value, at: &str) -> Result<(Vec<Value>, Vec<Value>), String> {
        let mut successes = Vec::new();
        let mut errors = Vec::new();
        for (code, response) in op
            .get("responses")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            let status = code
                .parse::<u16>()
                .ok()
                .filter(|s| (100..=599).contains(s))
                .ok_or_else(|| format!("{at}: response `{code}` is not a status code"))?;
            let response = self.resolve(response);
            let entry = json!({ "status": status, "bodies": self.bodies(response.get("content")) });
            if status < 400 {
                successes.push((status, entry));
            } else {
                errors.push((status, entry));
            }
        }
        let sorted = |mut v: Vec<(u16, Value)>| {
            v.sort_by_key(|(s, _)| *s);
            v.into_iter().map(|(_, e)| e).collect::<Vec<_>>()
        };
        Ok((sorted(successes), sorted(errors)))
    }

    /// The bodies of an OpenAPI `content` map, sorted by content type.
    fn bodies(&self, content: Option<&Value>) -> Vec<Value> {
        let Some(content) = content.and_then(Value::as_object) else {
            return Vec::new();
        };
        let mut types: Vec<&String> = content.keys().collect();
        types.sort_by(|a, b| js_string_cmp(a, b));
        types
            .into_iter()
            .map(|ct| {
                let schema = content[ct].get("schema").cloned().unwrap_or(json!({}));
                json!({ "contentType": ct, "schema": self.schema_ref(schema) })
            })
            .collect()
    }

    /// A `SchemaRef`: the schema, its component name when it is a bare `$ref`,
    /// and a fingerprint over the schema plus the components it reaches.
    fn schema_ref(&self, schema: Value) -> Value {
        let closure = referenced_components(&schema, self.components);
        let mut out = Map::new();
        if let Some(name) = schema
            .get("$ref")
            .and_then(Value::as_str)
            .and_then(|r| r.strip_prefix(REF_PREFIX))
        {
            out.insert("id".into(), json!(name));
        }
        if let Some(title) = schema.get("title").and_then(Value::as_str) {
            out.insert("title".into(), json!(title));
        }
        let digest = fingerprint(&json!({ "schema": schema, "components": closure }));
        out.insert("jsonSchema".into(), schema);
        out.insert("fingerprint".into(), json!(digest));
        Value::Object(out)
    }
}

/// Fold the parameters of one location into an object schema, as declared.
fn parameters_schema(parameters: &[&Value], location: &str) -> Option<Value> {
    let mut properties = Map::new();
    let mut required = Vec::new();
    for p in parameters {
        if p.get("in").and_then(Value::as_str) != Some(location) {
            continue;
        }
        let Some(name) = p.get("name").and_then(Value::as_str) else {
            continue;
        };
        properties.insert(name.into(), p.get("schema").cloned().unwrap_or(json!({})));
        if p.get("required").and_then(Value::as_bool) == Some(true) {
            required.push(json!(name));
        }
    }
    (!properties.is_empty())
        .then(|| json!({ "type": "object", "properties": properties, "required": required }))
}

/// OpenAPI `/users/{id}` → Effect route syntax `/users/:id`.
fn effect_path(path: &str) -> String {
    path.split('/')
        .map(
            |segment| match segment.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
                Some(name) => format!(":{name}"),
                None => segment.to_string(),
            },
        )
        .collect::<Vec<_>>()
        .join("/")
}

/// ForgeGraph's scheme classification (`@forgegraph/contract/effect`):
/// cookie API keys and HTTP basic are a person's session (`user`); bearer,
/// header/query API keys and anything else are machine credentials (`service`).
fn derive_authentication(schemes: &[String], definitions: &Map<String, Value>) -> &'static str {
    let kinds: BTreeSet<&str> = schemes
        .iter()
        .map(|name| {
            let s = definitions.get(name).unwrap_or(&Value::Null);
            let ty = s.get("type").and_then(Value::as_str);
            let scheme = s
                .get("scheme")
                .and_then(Value::as_str)
                .map(str::to_ascii_lowercase);
            match (ty, scheme.as_deref()) {
                (Some("apiKey"), _) if s.get("in").and_then(Value::as_str) == Some("cookie") => {
                    "user"
                }
                (Some("http"), Some("basic")) => "user",
                _ => "service",
            }
        })
        .collect();
    match kinds.len() {
        0 => "anonymous",
        1 => kinds.into_iter().next().unwrap_or("service"),
        _ => "mixed",
    }
}

/// `x-forge-slo` (`99.9%`, `99%`, `500`, `28d`) as an IR `SloDescriptor`.
/// `None` when the window has no whole-day form the IR accepts.
fn slo_descriptor(slo: &Value) -> Option<Value> {
    let window_days = slo
        .get("window")
        .and_then(Value::as_str)
        .and_then(window_days)
        .filter(|d| (1..=365).contains(d))?;
    let mut out = Map::new();
    if let Some(a) = slo
        .get("availability")
        .and_then(Value::as_str)
        .and_then(fraction)
    {
        out.insert("availability".into(), json!(a));
    }
    let good = slo
        .get("latencyGood")
        .and_then(Value::as_str)
        .and_then(fraction);
    let within = slo
        .get("latencyWithinMs")
        .filter(|ms| ms.as_f64().is_some_and(|ms| ms > 0.0));
    if let (Some(good), Some(within)) = (good, within) {
        out.insert(
            "latency".into(),
            json!({ "good": good, "withinMs": within }),
        );
    }
    out.insert("windowDays".into(), json!(window_days));
    Some(Value::Object(out))
}

/// `28d` → 28, `4w` → 28.
fn window_days(window: &str) -> Option<u64> {
    let window = window.trim();
    let (n, unit) = window.split_at(window.find(|c: char| !c.is_ascii_digit())?);
    let n: u64 = n.parse().ok()?;
    match unit {
        "d" => Some(n),
        "w" => Some(n * 7),
        _ => None,
    }
}

/// A percentage string as a fraction in (0, 1], shifted in decimal so
/// `99.9%` is exactly the double `0.999` (not `99.9 / 100`).
fn fraction(percent: &str) -> Option<f64> {
    let number = percent.trim().strip_suffix('%')?.trim();
    let (int, frac) = number.split_once('.').unwrap_or((number, ""));
    if int.is_empty() || !int.chars().chain(frac.chars()).all(|c| c.is_ascii_digit()) {
        return None;
    }
    let digits = format!("{int}{frac}");
    let point = int.len() as isize - 2;
    let shifted = if point <= 0 {
        format!("0.{}{digits}", "0".repeat(point.unsigned_abs()))
    } else {
        format!(
            "{}.{}",
            &digits[..point as usize],
            &digits[point as usize..]
        )
    };
    shifted
        .parse::<f64>()
        .ok()
        .filter(|f| *f > 0.0 && *f <= 1.0)
}

/// Every `#/components/schemas/<name>` a value references, directly.
pub(crate) fn collect_refs(value: &Value, into: &mut BTreeSet<String>) {
    match value {
        Value::Array(items) => items.iter().for_each(|v| collect_refs(v, into)),
        Value::Object(map) => {
            for (key, v) in map {
                match (key.as_str(), v) {
                    ("$ref", Value::String(r)) => {
                        if let Some(name) = r.strip_prefix(REF_PREFIX) {
                            into.insert(name.to_string());
                        }
                    }
                    _ => collect_refs(v, into),
                }
            }
        }
        _ => {}
    }
}

/// The transitive closure of the components a schema references.
fn referenced_components(schema: &Value, components: &Map<String, Value>) -> Map<String, Value> {
    let mut closure = BTreeMap::new();
    let mut pending = BTreeSet::new();
    collect_refs(schema, &mut pending);
    while let Some(name) = pending.pop_first() {
        if closure.contains_key(&name) {
            continue;
        }
        let Some(component) = components.get(&name) else {
            continue;
        };
        collect_refs(component, &mut pending);
        closure.insert(name, component.clone());
    }
    closure.into_iter().collect()
}

/// sha256 over the operation minus its `fingerprint`.
pub fn fingerprint_operation(op: &Value) -> String {
    let mut rest = op.clone();
    if let Some(map) = rest.as_object_mut() {
        map.remove("fingerprint");
    }
    fingerprint(&rest)
}

/// sha256 over the contract minus `fingerprint` and `generator`, with
/// operations reduced to `{ id, fingerprint }` sorted by id.
pub fn fingerprint_contract(contract: &Value) -> String {
    let mut rest = contract.clone();
    if let Some(map) = rest.as_object_mut() {
        map.remove("fingerprint");
        map.remove("generator");
        let mut ops: Vec<Value> = map
            .get("operations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|op| json!({ "id": op["id"], "fingerprint": op["fingerprint"] }))
            .collect();
        ops.sort_by(|a, b| js_string_cmp(id_of(a), id_of(b)));
        map.insert("operations".into(), json!(ops));
    }
    fingerprint(&rest)
}

/// The cross-checks `validateContract` runs after the shape check: unique
/// and well-formed ids, both fingerprint levels, and resolvable `$ref`s.
/// (The shape itself is checked by the Zod conformance suite.)
pub fn verify(contract: &Value) -> Vec<String> {
    let mut issues = Vec::new();
    if contract.get("irVersion") != Some(&json!(IR_VERSION)) {
        issues.push(format!("irVersion must be {IR_VERSION}"));
    }
    let service_id = contract["serviceId"].as_str().unwrap_or_default();
    if !is_identifier(service_id) {
        issues.push(format!("serviceId `{service_id}` is not an identifier"));
    }
    let components = contract["components"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let mut seen = BTreeSet::new();
    for (i, op) in contract["operations"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let id = id_of(op);
        if !seen.insert(id.to_string()) {
            issues.push(format!("operations.{i}: duplicate operation id {id}"));
        }
        let parts = [&op["serviceId"], &op["groupId"], &op["endpointId"]]
            .map(|v| v.as_str().unwrap_or_default());
        if parts.iter().any(|p| !is_identifier(p)) || id != parts.join(".") {
            issues.push(format!(
                "operations.{i}: id {id} does not match {}",
                parts.join(".")
            ));
        }
        if parts[0] != service_id {
            issues.push(format!(
                "operations.{i}: serviceId {} differs from {service_id}",
                parts[0]
            ));
        }
        if op["fingerprint"].as_str() != Some(fingerprint_operation(op).as_str()) {
            issues.push(format!(
                "operations.{i}: fingerprint does not match content"
            ));
        }
        let mut refs = BTreeSet::new();
        collect_refs(op, &mut refs);
        for r in refs.iter().filter(|r| !components.contains_key(*r)) {
            issues.push(format!("operations.{i}: $ref to missing component {r}"));
        }
    }
    let mut refs = BTreeSet::new();
    collect_refs(&contract["components"], &mut refs);
    for r in refs.iter().filter(|r| !components.contains_key(*r)) {
        issues.push(format!("components: $ref to missing component {r}"));
    }
    if contract["fingerprint"].as_str() != Some(fingerprint_contract(contract).as_str()) {
        issues.push("fingerprint does not match content".into());
    }
    issues
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_ids_are_the_unscoped_package_name() {
        assert_eq!(service_id_for("@demo/service-desk"), "service-desk");
        assert_eq!(service_id_for("plain"), "plain");
        assert_eq!(service_id_for("@x/9lives.app"), "x9lives-app");
    }

    #[test]
    fn percentages_shift_in_decimal() {
        assert_eq!(fraction("99.9%"), Some(0.999));
        assert_eq!(fraction("99%"), Some(0.99));
        assert_eq!(fraction("100%"), Some(1.0));
        assert_eq!(fraction("0.05%"), Some(0.0005));
        assert_eq!(fraction("150%"), None);
        assert_eq!(fraction("0%"), None);
        assert_eq!(fraction("abc"), None);
    }

    #[test]
    fn windows_convert_to_days() {
        assert_eq!(window_days("28d"), Some(28));
        assert_eq!(window_days("4w"), Some(28));
        assert_eq!(window_days("1h"), None);
    }

    #[test]
    fn effect_paths_use_colon_parameters() {
        assert_eq!(
            effect_path("/v1/tickets/{id}/actions/close"),
            "/v1/tickets/:id/actions/close"
        );
        assert_eq!(effect_path("/"), "/");
    }
}
