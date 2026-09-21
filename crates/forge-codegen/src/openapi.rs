//! OpenAPI 3.1 and Smithy 2.0 exports (FORGE-056). Both are projections of
//! the target-independent contracts the runtime enforces: the same paths,
//! precondition headers, Problem Details errors and `x-forge-*` semantics
//! the generated client uses. Nothing here adds an operation the runtime does
//! not serve, and SLO descriptors travel as vendor extensions (targets, not
//! promises).
use forge_planner::contracts::{Contracts, JsonSchema};
use forge_planner::observability::ObservabilityPlan;
use serde_json::{Map, Value, json};

fn schema_value(s: &JsonSchema) -> Value {
    let mut v = json!({ "type": s.ty, "properties": s.properties, "additionalProperties": false });
    if !s.required.is_empty() {
        v["required"] = json!(s.required);
    }
    v
}

/// Rewrite the contracts' internal `$ref` forms (`#/$defs/<id>` / `#/components/schemas/X`) onto component names.
fn rewrite_refs(v: &mut Value, names: &Map<String, Value>) {
    match v {
        Value::Object(m) => {
            if let Some(Value::String(r)) = m.get("$ref").cloned()
                && let Some(id) = r.strip_prefix("#/$defs/")
            {
                let short = id.rsplit('/').next().unwrap_or(id).replace('.', "");
                if let Some(Value::String(n)) = names.get(id) {
                    m.insert("$ref".into(), json!(format!("#/components/schemas/{n}")));
                } else {
                    m.insert(
                        "$ref".into(),
                        json!(format!("#/components/schemas/{short}")),
                    );
                }
            }
            for x in m.values_mut() {
                rewrite_refs(x, names);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| rewrite_refs(x, names)),
        _ => {}
    }
}

fn problem_schema() -> Value {
    json!({
        "type": "object",
        "required": ["type", "title", "status", "code"],
        "properties": {
            "type": { "type": "string", "format": "uri" },
            "title": { "type": "string" },
            "status": { "type": "integer" },
            "code": { "type": "string", "description": "Stable machine-readable error code (see specs/portable-profile/errors.md)" },
            "detail": { "type": "string" },
            "requestId": { "type": "string" },
            "retryable": { "type": "boolean" },
            "fields": { "type": "array", "items": { "type": "object", "properties": { "path": { "type": "string" }, "code": { "type": "string" }, "message": { "type": "string" } } } }
        }
    })
}

fn problem_response(description: &str) -> Value {
    json!({ "description": description, "content": { "application/problem+json": { "schema": { "$ref": "#/components/schemas/Problem" } } } })
}

fn params_for(path: &str, extra: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = path
        .split('/')
        .filter(|s| s.starts_with('{'))
        .map(|s| json!({ "name": s.trim_matches(|c| c == '{' || c == '}'), "in": "path", "required": true, "schema": { "type": "string" } }))
        .collect();
    out.push(json!({ "name": "X-Forge-Purpose", "in": "header", "required": false, "schema": { "type": "string" }, "description": "Purpose surface for this invocation (edition 2027; exactly one)" }));
    out.extend(extra.iter().cloned());
    out
}

pub fn openapi(c: &Contracts, obs: &ObservabilityPlan) -> Value {
    let mut schemas = Map::new();
    let mut names = Map::new();
    schemas.insert("Problem".into(), problem_schema());
    for r in &c.resources {
        schemas.insert(format!("{}Record", r.name), schema_value(&r.record));
        schemas.insert(format!("{}Create", r.name), schema_value(&r.create));
        schemas.insert(format!("{}Patch", r.name), schema_value(&r.patch));
        names.insert(
            format!("{}.Record", r.id),
            json!(format!("{}Record", r.name)),
        );
        if let Some(lc) = &r.lifecycle {
            for a in &lc.actions {
                schemas.insert(
                    format!("{}{}Input", r.name, upper(&a.name)),
                    schema_value(&a.input),
                );
            }
        }
    }
    for s in &c.surfaces {
        schemas.insert(
            format!("{}{}Record", s.resource_name, s.purpose_name),
            schema_value(&s.record),
        );
    }
    for v in &c.views {
        schemas.insert(format!("{}Row", v.name), schema_value(&v.record));
    }
    for p in &c.projections {
        schemas.insert(format!("{}Record", p.name), schema_value(&p.record));
    }
    let slo = |op: &str| {
        obs.operations.iter().find(|o| o.operation == op).map(|o| json!({ "availability": o.slo.availability, "latencyGood": o.slo.latency_good, "latencyWithinMs": o.slo.latency_within_ms, "window": o.slo.window, "class": o.class })).unwrap_or(Value::Null)
    };

    let mut paths: Map<String, Value> = Map::new();
    let mut put = |path: &str, method: &str, op: Value| {
        let entry = paths.entry(path.to_string()).or_insert_with(|| json!({}));
        entry[method] = op;
    };
    let etag = json!({ "ETag": { "schema": { "type": "string" }, "description": "Record version as a strong ETag" } });
    let if_match = json!({ "name": "If-Match", "in": "header", "required": true, "schema": { "type": "string" }, "description": "Expected record version; 412 on mismatch, 428 when missing" });
    let idem = json!({ "name": "Idempotency-Key", "in": "header", "required": false, "schema": { "type": "string" }, "description": "Replay returns the stored result; reuse with a different body is 409 IdempotencyMismatch" });
    let page = [
        json!({ "name": "cursor", "in": "query", "schema": { "type": "string" } }),
        json!({ "name": "limit", "in": "query", "schema": { "type": "integer", "minimum": 1, "maximum": 100, "default": 50 } }),
    ];

    for r in &c.resources {
        let rec = format!("#/components/schemas/{}Record", r.name);
        for op in &r.operations {
            let Some(h) = &op.http else { continue };
            let mut responses = Map::new();
            responses.insert("401".into(), problem_response("Unauthenticated"));
            responses.insert("403".into(), problem_response("NotPermitted"));
            let mut parameters = params_for(&h.path, &[]);
            let mut body = Value::Null;
            let ok = json!({ "description": "OK", "headers": etag, "content": { "application/json": { "schema": { "$ref": rec } } } });
            match op.kind.as_str() {
                "create" => {
                    parameters.push(idem.clone());
                    body = json!({ "required": true, "content": { "application/json": { "schema": { "$ref": format!("#/components/schemas/{}Create", r.name) } } } });
                    responses.insert("201".into(), json!({ "description": "Created", "headers": etag, "content": { "application/json": { "schema": { "$ref": rec } } } }));
                    responses.insert(
                        "409".into(),
                        problem_response("UniqueConflict / ReferenceMissing"),
                    );
                    responses.insert("422".into(), problem_response("ValidationFailed"));
                }
                "get" => {
                    responses.insert("200".into(), ok.clone());
                    responses.insert("404".into(), problem_response("NotFound"));
                }
                "update" => {
                    parameters.push(if_match.clone());
                    parameters.push(idem.clone());
                    body = json!({ "required": true, "content": { "application/json": { "schema": { "$ref": format!("#/components/schemas/{}Patch", r.name) } } } });
                    responses.insert("200".into(), ok.clone());
                    responses.insert("404".into(), problem_response("NotFound"));
                    responses.insert(
                        "412".into(),
                        problem_response("VersionConflict (stale If-Match)"),
                    );
                    responses.insert("422".into(), problem_response("ValidationFailed"));
                    responses.insert("428".into(), json!({ "description": "Precondition required (If-Match)", "content": { "application/problem+json": { "schema": { "$ref": "#/components/schemas/Problem" } } } }));
                }
                "delete" | "restore" | "move" | "beginUpload" | "finalizeUpload" => {
                    parameters.push(if_match.clone());
                    parameters.push(idem.clone());
                    responses.insert("200".into(), ok.clone());
                    responses.insert("404".into(), problem_response("NotFound"));
                    responses.insert(
                        "409".into(),
                        problem_response("HasDependents / InvalidTransition"),
                    );
                    responses.insert("412".into(), problem_response("VersionConflict"));
                    responses.insert("428".into(), json!({ "description": "Precondition required (If-Match)", "content": { "application/problem+json": { "schema": { "$ref": "#/components/schemas/Problem" } } } }));
                }
                "transition" => {
                    parameters.push(if_match.clone());
                    parameters.push(idem.clone());
                    if let Some(a) = op.action.as_ref() {
                        body = json!({ "required": false, "content": { "application/json": { "schema": { "$ref": format!("#/components/schemas/{}{}Input", r.name, upper(a)) } } } });
                    }
                    responses.insert("200".into(), ok.clone());
                    responses.insert("404".into(), problem_response("NotFound"));
                    responses.insert("409".into(), problem_response("InvalidTransition"));
                    responses.insert("412".into(), problem_response("VersionConflict"));
                    responses.insert("428".into(), json!({ "description": "Precondition required (If-Match)", "content": { "application/problem+json": { "schema": { "$ref": "#/components/schemas/Problem" } } } }));
                }
                "find" | "list" | "effective" => {
                    if let Some(q) = r
                        .queries
                        .iter()
                        .find(|q| Some(&q.name) == op.query.as_ref())
                    {
                        for p in &q.params {
                            parameters.push(json!({ "name": p, "in": "query", "required": true, "schema": r.record.properties.get(p).cloned().unwrap_or(json!({ "type": "string" })) }));
                        }
                    }
                    if op.kind == "effective" {
                        parameters.push(json!({ "name": "at", "in": "query", "required": true, "schema": { "type": "string", "format": "date-time" } }));
                    }
                    if op.kind == "list" {
                        parameters.extend(page.iter().cloned());
                        responses.insert("200".into(), json!({ "description": "Page", "content": { "application/json": { "schema": { "type": "object", "required": ["items", "next", "limit"], "properties": { "items": { "type": "array", "items": { "$ref": rec } }, "next": { "type": ["string", "null"] }, "limit": { "type": "integer" } } } } } }));
                        responses.insert("400".into(), problem_response("InvalidCursor"));
                    } else {
                        responses.insert("200".into(), ok.clone());
                        responses.insert("404".into(), problem_response("NotFound"));
                    }
                }
                "children" | "ancestors" => {
                    responses.insert("200".into(), json!({ "description": "Page", "content": { "application/json": { "schema": { "type": "object", "properties": { "items": { "type": "array", "items": { "$ref": rec } } } } } } }));
                }
                "download" => {
                    responses.insert("200".into(), json!({ "description": "Signed download", "content": { "application/json": { "schema": { "type": "object", "properties": { "url": { "type": "string" }, "method": { "type": "string" }, "expiresAt": { "type": "string" }, "mediaType": { "type": "string" }, "byteCount": { "type": "integer" }, "digest": { "type": "string" } } } } } }));
                    responses.insert("403".into(), problem_response("InspectionBlocked"));
                    responses.insert(
                        "409".into(),
                        problem_response("InvalidTransition / InspectionPending"),
                    );
                }
                _ => {
                    responses.insert("200".into(), ok.clone());
                }
            }
            let mut o = json!({ "operationId": op.id, "tags": [r.name], "x-forge-kind": op.kind, "parameters": parameters, "responses": responses });
            if !body.is_null() {
                o["requestBody"] = body;
            }
            let s = slo(&op.id);
            if !s.is_null() {
                o["x-forge-slo"] = s;
            }
            put(&h.path, &h.method.to_lowercase(), o);
        }
    }
    for f in &c.functions {
        let Some(h) = &f.http else { continue };
        let mut parameters = params_for(&h.path, std::slice::from_ref(&idem));
        let mut input = schema_value(&f.input);
        // Path parameters bind input fields by name: they are not repeated in the body.
        let path_params: Vec<String> = h
            .path
            .split('/')
            .filter(|s| s.starts_with('{'))
            .map(|s| s.trim_matches(|c| c == '{' || c == '}').to_string())
            .collect();
        if let Some(props) = input["properties"].as_object_mut() {
            for p in &path_params {
                props.remove(p);
            }
        }
        if let Some(req) = input["required"].as_array_mut() {
            req.retain(|x| !path_params.iter().any(|p| Value::String(p.clone()) == *x));
        }
        if input["properties"]
            .as_object()
            .is_some_and(|m| m.contains_key("expectedVersion"))
        {
            parameters.push(json!({ "name": "If-Match", "in": "header", "required": false, "schema": { "type": "string" }, "description": "Supplies expectedVersion" }));
        }
        let mut responses = Map::new();
        responses.insert("200".into(), json!({ "description": "OK", "content": { "application/json": { "schema": f.output } } }));
        responses.insert("401".into(), problem_response("Unauthenticated"));
        responses.insert("403".into(), problem_response("NotPermitted"));
        responses.insert("412".into(), problem_response("VersionConflict"));
        responses.insert("422".into(), problem_response("ValidationFailed"));
        if !f.errors.is_empty() {
            responses.insert(
                "409".into(),
                problem_response(&format!(
                    "Domain errors: {}",
                    f.errors
                        .iter()
                        .map(|e| format!("{}.{e}", f.id))
                        .collect::<Vec<_>>()
                        .join(", ")
                )),
            );
        }
        let mut o = json!({ "operationId": f.id, "tags": ["functions"], "x-forge-kind": "function", "parameters": parameters, "requestBody": { "required": true, "content": { "application/json": { "schema": input } } }, "responses": responses });
        let s = slo(&f.id);
        if !s.is_null() {
            o["x-forge-slo"] = s;
        }
        put(&h.path, &h.method.to_lowercase(), o);
    }
    for w in &c.workflows {
        let mut responses = Map::new();
        responses.insert("200".into(), json!({ "description": "Workflow instance", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/WorkflowInstance" } } } }));
        responses.insert("401".into(), problem_response("Unauthenticated"));
        let mut start_input = schema_value(&w.input);
        let path_params: Vec<String> = w
            .start
            .path
            .split('/')
            .filter(|s| s.starts_with('{'))
            .map(|s| s.trim_matches(|c| c == '{' || c == '}').to_string())
            .collect();
        if let Some(props) = start_input["properties"].as_object_mut() {
            for p in &path_params {
                props.remove(p);
            }
        }
        if let Some(req) = start_input["required"].as_array_mut() {
            req.retain(|x| !path_params.iter().any(|p| Value::String(p.clone()) == *x));
        }
        put(
            &w.start.path,
            &w.start.method.to_lowercase(),
            json!({ "operationId": format!("{}.start", w.id), "tags": ["workflows"], "x-forge-kind": "workflow.start", "parameters": params_for(&w.start.path, std::slice::from_ref(&idem)), "requestBody": { "required": true, "content": { "application/json": { "schema": start_input } } }, "responses": responses.clone() }),
        );
        put(
            &format!("{}/{{id}}", w.path),
            "get",
            json!({ "operationId": format!("{}.get", w.id), "tags": ["workflows"], "x-forge-kind": "workflow.get", "parameters": params_for(&format!("{}/{{id}}", w.path), &[]), "responses": responses.clone() }),
        );
        put(
            &format!("{}/{{id}}/cancel", w.path),
            "post",
            json!({ "operationId": format!("{}.cancel", w.id), "tags": ["workflows"], "x-forge-kind": "workflow.cancel", "parameters": params_for(&format!("{}/{{id}}/cancel", w.path), &[]), "responses": responses.clone() }),
        );
        put(
            &format!("{}/signals/{{message}}", w.path),
            "post",
            json!({ "operationId": format!("{}.signal", w.id), "tags": ["workflows"], "x-forge-kind": "workflow.signal", "parameters": params_for(&format!("{}/signals/{{message}}", w.path), &[]), "requestBody": { "required": true, "content": { "application/json": { "schema": { "type": "object", "required": ["payload"], "properties": { "messageId": { "type": "string" }, "payload": { "type": "object" } } } } } }, "responses": { "200": { "description": "Delivery report", "content": { "application/json": { "schema": { "type": "object", "properties": { "delivered": { "type": "integer" }, "held": { "type": "integer" } } } } } } } }),
        );
    }
    schemas.insert("WorkflowInstance".into(), json!({ "type": "object", "required": ["id", "workflow", "version", "status"], "properties": { "id": { "type": "string" }, "workflow": { "type": "string" }, "version": { "type": "integer" }, "status": { "type": "string", "enum": ["running", "waiting", "sleeping", "completed", "failed", "cancelled"] }, "bindings": { "type": "object" }, "history": { "type": "array" }, "output": {}, "error": { "type": "object" } } }));

    let mut doc = json!({
        "openapi": "3.1.0",
        "info": { "title": c.package, "version": c.version, "description": "Generated by forgec build; a projection of the same contracts the runtime enforces on every target.", "x-forge-contracts": c.version },
        "servers": [],
        "components": { "schemas": schemas, "securitySchemes": { "bearer": { "type": "http", "scheme": "bearer", "bearerFormat": "JWT" } } },
        "security": [{ "bearer": [] }],
        "paths": paths
    });
    rewrite_refs(&mut doc, &names);
    doc
}

fn upper(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// Smithy 2.0 IDL: structures for records/inputs, one operation per exposed contract operation.
pub fn smithy(c: &Contracts) -> String {
    let ns = c.package.trim_start_matches('@').replace(['/', '-'], ".");
    let mut out = format!("$version: \"2.0\"\n\nnamespace {ns}\n\n");
    let ty = |v: &Value| -> String {
        match v.get("type").and_then(|t| t.as_str()) {
            Some("integer") => "Long".into(),
            Some("boolean") => "Boolean".into(),
            Some("number") => "Double".into(),
            _ => "String".into(),
        }
    };
    let structure = |out: &mut String, name: &str, s: &JsonSchema| {
        out.push_str(&format!("structure {name} {{\n"));
        for (k, v) in &s.properties {
            let nullable = v
                .get("type")
                .and_then(|t| t.as_array())
                .is_some_and(|a| a.iter().any(|x| x == "null"));
            let req = if s.required.contains(k) && !nullable {
                "    @required\n"
            } else {
                ""
            };
            out.push_str(&format!("{req}    {k}: {}\n", ty(v)));
        }
        out.push_str("}\n\n");
    };
    out.push_str("@error(\"client\")\nstructure Problem {\n    @required\n    code: String\n    @required\n    title: String\n    detail: String\n}\n\n");
    for r in &c.resources {
        structure(&mut out, &format!("{}Record", r.name), &r.record);
        structure(&mut out, &format!("{}CreateInput", r.name), &r.create);
        structure(&mut out, &format!("{}PatchInput", r.name), &r.patch);
        for op in &r.operations {
            let Some(h) = &op.http else { continue };
            let name = format!(
                "{}{}",
                r.name,
                upper(&op.kind.replace('.', "")).replace(['.', '-'], "")
            );
            let input = match op.kind.as_str() {
                "create" => format!("{}CreateInput", r.name),
                "update" => format!("{}PatchInput", r.name),
                _ => "Unit".into(),
            };
            out.push_str(&format!("@http(method: \"{}\", uri: \"{}\")\noperation {name} {{\n    input: {input}\n    output: {}Record\n    errors: [Problem]\n}}\n\n", h.method, h.path, r.name));
        }
    }
    for f in &c.functions {
        let Some(h) = &f.http else { continue };
        structure(&mut out, &format!("{}Input", f.name), &f.input);
        out.push_str(&format!("@http(method: \"{}\", uri: \"{}\")\noperation {} {{\n    input: {}Input\n    errors: [Problem]\n}}\n\n", h.method, h.path, f.name, f.name));
    }
    out
}
