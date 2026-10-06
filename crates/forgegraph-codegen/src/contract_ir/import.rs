//! `forgec import-contract`: a ForgeGraph contract IR v1 document as a Forge
//! package. The contract is rewritten as an OpenAPI 3.1 document and fed to
//! the OpenAPI importer, so both importers share one mapping and one report.
//!
//! The same doctrine applies: what Forge cannot express is reported at its
//! exact location, never approximated into a different meaning. RPC
//! procedures, methods `@http` cannot bind, anonymous or public visibility,
//! SLA/SLO policy, non-security middleware, alternate media and error bodies
//! other than Problem Details are all listed in `import-report.json`.
//! A contract whose fingerprints do not match its content is refused.
use super::emit::{REF_PREFIX, verify};
use crate::openapi_import::{ImportOptions, ImportOutput, Unsupported, import_openapi, pascal};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// The OpenAPI rewrite plus everything the rewrite itself had to report.
#[derive(Debug, Clone)]
pub struct Conversion {
    pub openapi: Value,
    pub unsupported: Vec<Unsupported>,
    /// OpenAPI operation id (the Forge function name) → contract operation id.
    pub operations: BTreeMap<String, String>,
    /// Contract operation ids that have no OpenAPI form.
    pub skipped: Vec<String>,
}

const BINDABLE: [&str; 5] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
/// Statuses the Forge runtime serves on every function itself (Unauthenticated,
/// NotPermitted, VersionConflict, ValidationFailed). They are left out of the
/// OpenAPI rewrite so the importer does not turn them into domain errors.
const RUNTIME_OWNED: [u64; 4] = [401, 403, 412, 422];

/// Rewrite a validated contract as OpenAPI 3.1.
pub fn contract_to_openapi(contract: &Value) -> Result<Conversion, String> {
    let issues = verify(contract);
    if !issues.is_empty() {
        return Err(format!(
            "not a valid contract IR v1 document: {}",
            issues.join("; ")
        ));
    }
    let mut conv = Converter::new(contract)?;
    let mut paths: Map<String, Value> = Map::new();
    for op in contract["operations"].as_array().into_iter().flatten() {
        if let Some((path, method, operation)) = conv.operation(op)? {
            let item = paths.entry(path).or_insert_with(|| json!({}));
            item[method] = operation;
        }
    }
    let openapi = json!({
        "openapi": "3.1.0",
        "info": {
            "title": contract["apiId"],
            "version": "0.0.0",
            "x-forge-contract": {
                "serviceId": contract["serviceId"],
                "fingerprint": contract["fingerprint"],
                "generator": contract["generator"],
            },
        },
        "paths": paths,
        "components": {
            "schemas": conv.schemas,
            "securitySchemes": contract["securitySchemes"],
        },
    });
    Ok(Conversion {
        openapi,
        unsupported: conv.unsupported,
        operations: conv.operations,
        skipped: conv.skipped,
    })
}

/// `forgec import-contract`: contract IR → OpenAPI 3.1 → Forge package.
pub fn import_contract(text: &str, opts: &ImportOptions) -> Result<ImportOutput, String> {
    let contract: Value =
        serde_json::from_str(text).map_err(|e| format!("the contract is not JSON ({e})"))?;
    let conv = contract_to_openapi(&contract)?;
    let openapi = serde_json::to_string_pretty(&conv.openapi).map_err(|e| e.to_string())? + "\n";
    let mut out = import_openapi(&openapi, opts)?;
    let report = &mut out.report;
    report.version = "contract-import/1".into();
    report.unsupported.extend(conv.unsupported);
    report
        .unsupported
        .sort_by(|a, b| (&a.at, &a.feature).cmp(&(&b.at, &b.feature)));
    report.skipped_operations.extend(conv.skipped);
    report.skipped_operations.sort();
    for op in &mut report.operations {
        if let Some(id) = conv.operations.get(&op.operation_id) {
            op.operation_id = id.clone();
        }
    }
    let rendered = serde_json::to_string_pretty(&out.report).map_err(|e| e.to_string())? + "\n";
    out.files.insert("import-report.json".into(), rendered);
    out.files.insert("openapi.json".into(), openapi);
    if let Some(src) = out.files.get_mut("src/index.forge") {
        *src = src.replacen(
            "by `forgec import-openapi`",
            "by `forgec import-contract` (contract IR v1 via openapi.json)",
            1,
        );
    }
    Ok(out)
}

struct Converter {
    /// Contract component name → OpenAPI component name.
    names: BTreeMap<String, String>,
    schemas: Map<String, Value>,
    /// Names Forge declarations already use (shapes from components, functions).
    taken: BTreeSet<String>,
    routes: BTreeSet<(String, String)>,
    unsupported: Vec<Unsupported>,
    operations: BTreeMap<String, String>,
    skipped: Vec<String>,
}

impl Converter {
    fn new(contract: &Value) -> Result<Self, String> {
        let components = contract["components"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        // OpenAPI component keys are `^[a-zA-Z0-9._-]+$`; anything else is renamed.
        let mut names = BTreeMap::new();
        let mut used = BTreeSet::new();
        for name in components.keys() {
            let base: String = name
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || "._-".contains(c) {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            let mut candidate = base.clone();
            let mut i = 2;
            while !used.insert(candidate.clone()) {
                candidate = format!("{base}_{i}");
                i += 1;
            }
            names.insert(name.clone(), candidate);
        }
        let mut conv = Converter {
            taken: names.values().map(|n| pascal(n)).collect(),
            names,
            schemas: Map::new(),
            routes: BTreeSet::new(),
            unsupported: Vec::new(),
            operations: BTreeMap::new(),
            skipped: Vec::new(),
        };
        for (name, schema) in &components {
            let at = format!("components.{name}");
            let schema = conv.rewrite_refs(schema.clone(), &at)?;
            conv.schemas.insert(conv.names[name].clone(), schema);
        }
        Ok(conv)
    }

    fn report(&mut self, feature: &str, at: &str, note: &str) {
        self.unsupported.push(Unsupported {
            feature: feature.into(),
            at: at.into(),
            note: note.into(),
        });
    }

    /// Point every `$ref` at the (possibly renamed) OpenAPI component.
    fn rewrite_refs(&self, mut value: Value, at: &str) -> Result<Value, String> {
        fn walk(v: &mut Value, names: &BTreeMap<String, String>, at: &str) -> Result<(), String> {
            match v {
                Value::Object(map) => {
                    if let Some(Value::String(r)) = map.get("$ref") {
                        let name = r.strip_prefix(REF_PREFIX).ok_or_else(|| {
                            format!("{at}: $ref `{r}` does not point into components; only `{REF_PREFIX}<name>` references are importable")
                        })?;
                        let target = names
                            .get(name)
                            .ok_or_else(|| format!("{at}: $ref to missing component {name}"))?;
                        map.insert("$ref".into(), json!(format!("{REF_PREFIX}{target}")));
                    }
                    for (key, inner) in map.iter_mut() {
                        if key != "$ref" {
                            walk(inner, names, at)?;
                        }
                    }
                }
                Value::Array(items) => {
                    for inner in items {
                        walk(inner, names, at)?;
                    }
                }
                _ => {}
            }
            Ok(())
        }
        walk(&mut value, &self.names, at)?;
        Ok(value)
    }

    /// A Forge function name for the operation that no other declaration uses.
    /// Operations in `functions` (forgec's group for functions) keep their
    /// endpoint name, so a contract forgec emitted re-imports to the same names.
    fn function_name(&mut self, group: &str, endpoint: &str) -> String {
        let base = if group == "functions" {
            pascal(endpoint)
        } else {
            pascal(&format!("{group}_{endpoint}"))
        };
        let clashes = |taken: &BTreeSet<String>, n: &str| {
            [n.to_string(), format!("{n}Input"), format!("{n}Output")]
                .iter()
                .any(|x| taken.contains(x))
        };
        let mut name = base.clone();
        let mut i = 2;
        while clashes(&self.taken, &name) {
            name = if i == 2 {
                format!("{base}Op")
            } else {
                format!("{base}Op{i}")
            };
            i += 1;
        }
        for n in [
            name.clone(),
            format!("{name}Input"),
            format!("{name}Output"),
        ] {
            self.taken.insert(n);
        }
        name
    }

    /// `(openApiPath, lowercase method, OpenAPI operation)`, or `None` when
    /// the operation has no `@http` form (reported).
    fn operation(&mut self, op: &Value) -> Result<Option<(String, String, Value)>, String> {
        let id = op["id"].as_str().unwrap_or_default().to_string();
        let at = format!("operations.{id}");
        let transport = &op["transport"];
        if transport["type"] != "http" {
            self.report(
                "rpc-transport",
                &format!("{at}.transport"),
                "RPC procedures have no HTTP binding in Forge; operation skipped",
            );
            self.skipped.push(id);
            return Ok(None);
        }
        let method = transport["method"].as_str().unwrap_or_default();
        if !BINDABLE.contains(&method) {
            self.report(
                "http-method",
                &format!("{at}.transport"),
                &format!("@http binds GET, POST, PUT, PATCH and DELETE only, not {method}; operation skipped"),
            );
            self.skipped.push(id);
            return Ok(None);
        }
        let path = transport["openApiPath"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        if !self.routes.insert((method.to_string(), path.clone())) {
            self.report(
                "duplicate-route",
                &format!("{at}.transport"),
                &format!(
                    "{method} {path} is already bound by another operation; operation skipped"
                ),
            );
            self.skipped.push(id);
            return Ok(None);
        }
        self.policy(op, &at);
        let name = self.function_name(
            op["groupId"].as_str().unwrap_or_default(),
            op["endpointId"].as_str().unwrap_or_default(),
        );
        self.operations.insert(name.clone(), id.clone());

        let mut operation = Map::new();
        operation.insert("operationId".into(), json!(name));
        let mut parameters = Vec::new();
        for (slot, location) in [
            ("params", "path"),
            ("query", "query"),
            ("headers", "header"),
        ] {
            if let Some(schema_ref) = op["request"].get(slot) {
                parameters.extend(self.parameters(
                    schema_ref,
                    location,
                    &format!("{at}.request.{slot}"),
                )?);
            }
        }
        if !parameters.is_empty() {
            operation.insert("parameters".into(), json!(parameters));
        }
        let bodies = op["request"]["bodies"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if !bodies.is_empty() {
            let content = self.content(&bodies, &format!("{at}.request.bodies"))?;
            operation.insert("requestBody".into(), json!({ "content": content }));
        }
        operation.insert("responses".into(), self.responses(op, &at)?);
        let schemes = op["policy"]["authentication"]["schemes"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let security: Vec<Value> = schemes
            .iter()
            .filter_map(Value::as_str)
            .map(|s| json!({ s: [] }))
            .collect();
        operation.insert("security".into(), json!(security));
        Ok(Some((
            path,
            method.to_ascii_lowercase(),
            Value::Object(operation),
        )))
    }

    /// Report the policy Forge has no per-operation form for.
    fn policy(&mut self, op: &Value, at: &str) {
        let policy = &op["policy"];
        let auth = &policy["authentication"];
        if auth["mode"] == "anonymous" {
            self.report(
                "anonymous-operation",
                &format!("{at}.policy.authentication"),
                "the Forge runtime authenticates every request; the imported function requires a credential",
            );
        }
        if let Some(declared) = auth.get("declared").and_then(Value::as_str) {
            self.report(
                "declared-authentication",
                &format!("{at}.policy.authentication"),
                &format!("declared mode `{declared}` has no Forge annotation; not imported"),
            );
        }
        if policy["isPublic"] == true {
            self.report(
                "public-visibility",
                &format!("{at}.policy.isPublic"),
                "Forge has no public-operation marker; not imported",
            );
        }
        if policy["sla"]["policy"]
            .as_object()
            .is_some_and(|m| !m.is_empty())
        {
            self.report(
                "sla-policy",
                &format!("{at}.policy.sla"),
                "Forge declares SLOs, not SLA policies; not imported",
            );
        }
        if policy.get("slo").is_some() {
            self.report(
                "slo",
                &format!("{at}.policy.slo"),
                "per-operation objectives are not imported; declare `slo { ... }` on the function or `[observability.slo]` defaults",
            );
        }
        for m in op["middleware"].as_array().into_iter().flatten() {
            if m["security"] != true {
                self.report(
                    "middleware",
                    &format!("{at}.middleware"),
                    &format!(
                        "middleware `{}` has no Forge equivalent; not imported",
                        m["key"].as_str().unwrap_or("?")
                    ),
                );
            }
        }
    }

    /// One OpenAPI parameter per property of the folded parameter schema.
    fn parameters(
        &mut self,
        schema_ref: &Value,
        location: &str,
        at: &str,
    ) -> Result<Vec<Value>, String> {
        let schema = self.rewrite_refs(schema_ref["jsonSchema"].clone(), at)?;
        let schema = match schema.get("$ref").and_then(Value::as_str) {
            Some(r) => self
                .schemas
                .get(r.strip_prefix(REF_PREFIX).unwrap_or(r))
                .cloned()
                .unwrap_or(schema),
            None => schema,
        };
        let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
            self.report(
                "parameters-schema",
                at,
                "parameters are not a plain object schema; dropped",
            );
            return Ok(Vec::new());
        };
        let required: BTreeSet<&str> = schema["required"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        Ok(properties
            .iter()
            .map(|(name, s)| {
                json!({
                    "name": name,
                    "in": location,
                    "required": location == "path" || required.contains(name.as_str()),
                    "schema": s,
                })
            })
            .collect())
    }

    /// An OpenAPI `content` map. The importer reads the JSON body only, so
    /// any other media type next to it is reported.
    fn content(&mut self, bodies: &[Value], at: &str) -> Result<Value, String> {
        let is_json = |ct: &str| ct == "application/json" || ct.ends_with("+json");
        let has_json = bodies
            .iter()
            .any(|b| is_json(b["contentType"].as_str().unwrap_or_default()));
        let mut content = Map::new();
        for body in bodies {
            let ct = body["contentType"].as_str().unwrap_or_default();
            if has_json && !is_json(ct) {
                self.report(
                    "alternate-media",
                    at,
                    &format!("{ct} alongside a JSON body is not importable; only the JSON body is"),
                );
            }
            let schema = self.rewrite_refs(body["schema"]["jsonSchema"].clone(), at)?;
            content.insert(ct.into(), json!({ "schema": schema }));
        }
        Ok(Value::Object(content))
    }

    fn responses(&mut self, op: &Value, at: &str) -> Result<Value, String> {
        let mut responses = Map::new();
        let mut success_bodies = 0;
        for (side, entries) in [("successes", &op["successes"]), ("errors", &op["errors"])] {
            for entry in entries.as_array().into_iter().flatten() {
                let status = entry["status"].as_u64().unwrap_or_default();
                if RUNTIME_OWNED.contains(&status) {
                    continue;
                }
                let bodies = entry["bodies"].as_array().cloned().unwrap_or_default();
                let rat = format!("{at}.{side}.{status}");
                let mut response = json!({ "description": reason(status) });
                match status {
                    200..=299 if !bodies.is_empty() => {
                        success_bodies += 1;
                        if success_bodies > 1 {
                            self.report(
                                "additional-success-response",
                                &rat,
                                "a Forge function has one output; only the first success body is imported",
                            );
                        }
                    }
                    100..=199 | 300..=399 => self.report(
                        "non-success-status",
                        &rat,
                        "informational and redirect responses have no Forge function form; not imported",
                    ),
                    500..=599 => self.report(
                        "server-error-response",
                        &rat,
                        "server errors are runtime failures in Forge, not declared errors; not imported",
                    ),
                    400..=499
                        if bodies.iter().any(|b| {
                            b["contentType"] != "application/problem+json"
                        }) =>
                    {
                        self.report(
                            "error-body",
                            &rat,
                            "Forge errors are Problem Details; the declared error body is not imported",
                        )
                    }
                    _ => {}
                }
                if !bodies.is_empty() {
                    response["content"] = self.content(&bodies, &rat)?;
                }
                responses.insert(status.to_string(), response);
            }
        }
        Ok(Value::Object(responses))
    }
}

/// The RFC 9110 reason phrase, which the importer turns into the error name.
fn reason(status: u64) -> String {
    match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        409 => "Conflict",
        410 => "Gone",
        412 => "Precondition Failed",
        413 => "Content Too Large",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Content",
        428 => "Precondition Required",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => return format!("Status {status}"),
    }
    .into()
}
