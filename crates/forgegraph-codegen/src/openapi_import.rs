//! Pinned, offline OpenAPI importer (FORGE-052; PAR-116/117/118).
//!
//! Turns a vendor OpenAPI 3.0/3.1 document into a Forge package of shapes,
//! enums and `@http`-bound functions. The importer never fetches anything:
//! every remote `$ref` must be pinned to a local file (optionally by SHA-256),
//! server and callback URLs must name an allowed public host, and private,
//! loopback, link-local and metadata hosts fail closed. Features Forge cannot
//! express (arrays, unions, binary media, exploded query arrays) are reported
//! as unsupported at the exact location, never silently approximated into a
//! different meaning. Fields that look like identifiers stay `text` and are
//! listed for a reviewed resolver: a vendor `customer_id` is never a Forge
//! `Customer`.
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Pin {
    pub url: String,
    pub file: PathBuf,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ImportOptions {
    /// Forge package name for the generated package (`@vendor/billing`).
    pub package: String,
    pub pins: Vec<Pin>,
    /// Hosts servers/callbacks may name. Empty = any public host (still reported).
    pub allow_hosts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Unsupported {
    pub feature: String,
    pub at: String,
    pub note: String,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ForeignId {
    pub shape: String,
    pub field: String,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Callback {
    pub name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<String>,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ImportedOperation {
    pub operation_id: String,
    pub function: String,
    pub method: String,
    pub path: String,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Report {
    pub version: String,
    pub package: String,
    pub source: SourceInfo,
    pub hosts: Vec<String>,
    pub pins: Vec<PinReport>,
    pub operations: Vec<ImportedOperation>,
    pub skipped_operations: Vec<String>,
    pub unsupported: Vec<Unsupported>,
    pub foreign_identifiers: Vec<ForeignId>,
    pub callbacks: Vec<Callback>,
    pub security: Vec<Value>,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SourceInfo {
    pub title: String,
    pub version: String,
    pub openapi: String,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PinReport {
    pub url: String,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct ImportOutput {
    /// Relative path -> file text, deterministic.
    pub files: BTreeMap<String, String>,
    pub report: Report,
}

// ------------------------------------------------------------------ hosts
fn ipv4_private(octets: [u8; 4]) -> bool {
    let [a, b, _, _] = octets;
    a == 10
        || a == 127
        || a == 0
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 100 && (64..=127).contains(&b))
}

/// Parse dotted IPv4 including short forms (`127.1` == 127.0.0.1), as libc's inet_aton does.
fn parse_ipv4(host: &str) -> Option<[u8; 4]> {
    if host.is_empty() || !host.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    let parts: Vec<u64> = host
        .split('.')
        .map(|p| p.parse::<u64>().ok())
        .collect::<Option<_>>()?;
    let value: u64 = match parts.as_slice() {
        [a] => *a,
        [a, b] => (a << 24) | b,
        [a, b, c] => (a << 24) | (b << 16) | c,
        [a, b, c, d] => (a << 24) | (b << 16) | (c << 8) | d,
        _ => return None,
    };
    if value > u32::MAX as u64 {
        return None;
    }
    Some((value as u32).to_be_bytes())
}

/// Host classification: `Err` names why the host is refused.
pub fn check_host(url: &str, allow: &[String]) -> Result<String, String> {
    let rest = url
        .split("://")
        .nth(1)
        .ok_or_else(|| format!("{url}: not an absolute URL"))?;
    let authority = rest.split('/').next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = if let Some(h) = authority.strip_prefix('[') {
        h.split(']').next().unwrap_or("").to_string()
    } else {
        authority.split(':').next().unwrap_or("").to_string()
    };
    let lower = host.to_ascii_lowercase();
    if lower.is_empty() {
        return Err(format!("{url}: no host"));
    }
    if lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".internal")
        || lower.ends_with(".local")
        || lower == "metadata"
    {
        return Err(format!(
            "{url}: private/metadata host `{host}` is forbidden"
        ));
    }
    if let Some(o) = parse_ipv4(&lower) {
        if ipv4_private(o) {
            return Err(format!("{url}: private address `{host}` is forbidden"));
        }
        return Err(format!(
            "{url}: literal IP addresses are forbidden; pin a hostname"
        ));
    }
    if lower.contains(':') {
        // IPv6 literal
        if lower == "::1"
            || lower == "::"
            || lower.starts_with("fe80:")
            || lower.starts_with("fc")
            || lower.starts_with("fd")
            || lower.starts_with("::ffff:")
        {
            return Err(format!("{url}: private address `{host}` is forbidden"));
        }
        return Err(format!(
            "{url}: literal IP addresses are forbidden; pin a hostname"
        ));
    }
    if !allow.is_empty()
        && !allow.iter().any(|a| {
            a.eq_ignore_ascii_case(&lower)
                || (a.starts_with('.') && lower.ends_with(&a.to_ascii_lowercase()))
        })
    {
        return Err(format!(
            "{url}: host `{host}` is not in the allowed host list (forbidden by default)"
        ));
    }
    Ok(lower)
}

// ------------------------------------------------------------------ naming
fn pascal(s: &str) -> String {
    let mut out = String::new();
    let mut up = true;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            if up {
                out.extend(c.to_uppercase());
                up = false;
            } else {
                out.push(c);
            }
        } else {
            up = true;
        }
    }
    if out.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        out.insert(0, '_');
    }
    out
}
fn ident(s: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        out.insert(0, '_');
    }
    if out.is_empty() {
        out.push('_');
    }
    out
}
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

// ------------------------------------------------------------------ state
struct Importer {
    doc: Value,
    pinned: BTreeMap<String, Value>,
    shapes: BTreeMap<String, Vec<String>>, // name -> field lines
    shape_order: Vec<String>,
    enums: BTreeMap<Vec<String>, String>, // value set -> enum name
    enum_names: BTreeSet<String>,
    report: Report,
    /// (shape, field) sites per enum value set: a set used on several shapes is named by its field.
    enum_field_counts: BTreeMap<Vec<String>, BTreeSet<(String, String)>>,
}

impl Importer {
    fn resolve(&self, r: &str, at: &str) -> Result<Value, String> {
        if let Some(ptr) = r.strip_prefix('#') {
            return self
                .doc
                .pointer(ptr)
                .cloned()
                .ok_or_else(|| format!("{at}: unresolved local reference {r}"));
        }
        let (url, ptr) = r
            .split_once('#')
            .map(|(u, p)| (u.to_string(), p.to_string()))
            .unwrap_or((r.to_string(), String::new()));
        let file = self.pinned.get(&url).ok_or_else(|| format!("{at}: remote reference {url} is not pinned; the importer never fetches (add --pin {url}=<file>)"))?;
        if ptr.is_empty() {
            return Ok(file.clone());
        }
        file.pointer(&ptr)
            .cloned()
            .ok_or_else(|| format!("{at}: pinned file for {url} has no {ptr}"))
    }

    /// Follow `$ref`s (bounded) and merge `allOf` object members.
    fn deref(&self, schema: &Value, at: &str) -> Result<Value, String> {
        let mut cur = schema.clone();
        for _ in 0..16 {
            if let Some(Value::String(r)) = cur.get("$ref") {
                cur = self.resolve(r, at)?;
                continue;
            }
            break;
        }
        if let Some(Value::Array(parts)) = cur.get("allOf") {
            let mut merged = Map::new();
            merged.insert("type".into(), json_str("object"));
            let mut props = Map::new();
            let mut required = Vec::new();
            for p in parts {
                let d = self.deref(p, at)?;
                if let Some(Value::Object(ps)) = d.get("properties") {
                    for (k, v) in ps {
                        props.insert(k.clone(), v.clone());
                    }
                }
                if let Some(Value::Array(r)) = d.get("required") {
                    required.extend(r.iter().cloned());
                }
            }
            merged.insert("properties".into(), Value::Object(props));
            merged.insert("required".into(), Value::Array(required));
            return Ok(Value::Object(merged));
        }
        Ok(cur)
    }

    fn unsupported(&mut self, feature: &str, at: &str, note: &str) {
        self.report.unsupported.push(Unsupported {
            feature: feature.into(),
            at: at.into(),
            note: note.into(),
        });
    }

    fn enum_name(&mut self, values: &[String], parent: &str, field: &str) -> String {
        if let Some(n) = self.enums.get(values) {
            return n.clone();
        }
        let shared = self
            .enum_field_counts
            .get(values)
            .is_some_and(|s| s.len() >= 2);
        let base = if shared {
            pascal(field)
        } else {
            format!("{}{}", pascal(parent), pascal(field))
        };
        let mut name = base.clone();
        let mut i = 2;
        while self.enum_names.contains(&name) {
            name = format!("{base}{i}");
            i += 1;
        }
        self.enum_names.insert(name.clone());
        self.enums.insert(values.to_vec(), name.clone());
        name
    }

    /// Forge type text for a property schema, or `None` when the field must be skipped.
    fn type_of(
        &mut self,
        schema: &Value,
        parent: &str,
        field: &str,
        required: bool,
        at: &str,
    ) -> Result<Option<String>, String> {
        let s = self.deref(schema, at)?;
        let mut nullable = s.get("nullable").and_then(|v| v.as_bool()).unwrap_or(false);
        let ty: Option<String> = match s.get("type") {
            Some(Value::Array(ts)) => {
                let non_null: Vec<&str> = ts
                    .iter()
                    .filter_map(|t| t.as_str())
                    .filter(|t| *t != "null")
                    .collect();
                nullable = nullable || ts.iter().any(|t| t == "null");
                if non_null.len() == 1 {
                    Some(non_null[0].to_string())
                } else {
                    None
                }
            }
            Some(Value::String(t)) => Some(t.clone()),
            _ => None,
        };
        if s.get("oneOf").is_some() || s.get("anyOf").is_some() {
            let f = if s.get("oneOf").is_some() {
                "oneOf"
            } else {
                "anyOf"
            };
            self.unsupported(
                f,
                at,
                "union schemas have no Forge shape; typed as json (opaque)",
            );
            return Ok(Some(format!(
                "json{}",
                if nullable || !required { "?" } else { "" }
            )));
        }
        let opt = if nullable || !required { "?" } else { "" };
        let base = match ty.as_deref() {
            Some("string") => {
                if let Some(Value::Array(vals)) = s.get("enum") {
                    let values: Vec<String> = vals
                        .iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect();
                    let name = self.enum_name(&values, parent, field);
                    return Ok(Some(format!("{name}{opt}")));
                }
                match s.get("format").and_then(|f| f.as_str()) {
                    Some("date") => format!("date{opt}"),
                    Some("date-time") => format!("datetime{opt}"),
                    Some("email") => format!("email{opt}"),
                    Some("uri") | Some("url") => format!("url{opt}"),
                    Some("binary") | Some("byte") => {
                        self.unsupported(
                            "binary",
                            at,
                            "binary strings are not importable as shape fields; skipped",
                        );
                        return Ok(None);
                    }
                    _ => {
                        let mut t = format!("text{opt}");
                        let min = s.get("minLength").and_then(|v| v.as_u64());
                        let max = s.get("maxLength").and_then(|v| v.as_u64());
                        match (min, max) {
                            (Some(a), Some(b)) => t.push_str(&format!(" length {a}..{b}")),
                            (Some(a), None) => t.push_str(&format!(" length >= {a}")),
                            (None, Some(b)) => t.push_str(&format!(" length <= {b}")),
                            _ => {}
                        }
                        if let Some(p) = s.get("pattern").and_then(|v| v.as_str()) {
                            t.push_str(&format!(" pattern {}", quote(p)));
                        }
                        t
                    }
                }
            }
            Some("integer") => {
                let mut t = format!("integer{opt}");
                if let Some(v) = s.get("minimum") {
                    t.push_str(&format!(" >= {v}"));
                }
                if let Some(v) = s.get("maximum") {
                    t.push_str(&format!(" <= {v}"));
                }
                t
            }
            Some("number") => {
                let mut t = format!("decimal{opt}");
                if let Some(v) = s.get("minimum") {
                    t.push_str(&format!(" >= {v}"));
                }
                if let Some(v) = s.get("maximum") {
                    t.push_str(&format!(" <= {v}"));
                }
                t
            }
            Some("boolean") => format!("boolean{opt}"),
            Some("array") => {
                self.unsupported(
                    "array",
                    at,
                    "Forge shapes have no list type; typed as json (opaque)",
                );
                format!("json{opt}")
            }
            Some("object") | None if s.get("properties").is_some() => {
                let name = format!("{}{}", pascal(parent), pascal(field));
                self.shape(&name, &s, at)?;
                format!("{name}{opt}")
            }
            Some("object") | None => format!("json{opt}"),
            Some(other) => {
                self.unsupported("type", at, &format!("unknown type {other}; skipped"));
                return Ok(None);
            }
        };
        Ok(Some(base))
    }

    fn shape(&mut self, name: &str, schema: &Value, at: &str) -> Result<(), String> {
        if self.shapes.contains_key(name) {
            return Ok(());
        }
        self.shapes.insert(name.to_string(), Vec::new()); // reserve (recursion guard)
        self.shape_order.push(name.to_string());
        let s = self.deref(schema, at)?;
        let required: BTreeSet<String> = s
            .get("required")
            .and_then(|r| r.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let mut lines = Vec::new();
        if let Some(Value::Object(props)) = s.get("properties") {
            for (k, v) in props {
                let fat = format!("{at}.{k}");
                let Some(t) = self.type_of(v, name, k, required.contains(k), &fat)? else {
                    continue;
                };
                let field = ident(k);
                if t.starts_with("text")
                    && (k.ends_with("_id") || (k.ends_with("Id") && k.len() > 2))
                {
                    self.report.foreign_identifiers.push(ForeignId {
                        shape: name.to_string(),
                        field: field.clone(),
                    });
                }
                lines.push(format!("  {field} : {t}"));
            }
        }
        self.shapes.insert(name.to_string(), lines);
        Ok(())
    }

    fn collect_enum_fields(&mut self, shape: &str, schema: &Value, at: &str) {
        let Ok(s) = self.deref(schema, at) else {
            return;
        };
        if let Some(Value::Object(props)) = s.get("properties") {
            for (k, v) in props {
                let Ok(d) = self.deref(v, at) else { continue };
                if let Some(Value::Array(vals)) = d.get("enum") {
                    let values: Vec<String> = vals
                        .iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect();
                    self.enum_field_counts
                        .entry(values)
                        .or_default()
                        .insert((shape.to_string(), k.clone()));
                }
                if d.get("properties").is_some() {
                    self.collect_enum_fields(&format!("{shape}{}", pascal(k)), &d, at);
                }
            }
        }
    }
}

fn json_str(s: &str) -> Value {
    Value::String(s.to_string())
}

fn json_media(content: &Value) -> Option<&Value> {
    content.get("application/json").or_else(|| {
        content
            .as_object()
            .and_then(|m| m.iter().find(|(k, _)| k.ends_with("+json")).map(|(_, v)| v))
    })
}

pub fn import_openapi(text: &str, opts: &ImportOptions) -> Result<ImportOutput, String> {
    let doc: Value = serde_json::from_str(text).map_err(|e| {
        format!("the document is not JSON ({e}); YAML is not supported, convert it first")
    })?;
    let openapi = doc
        .get("openapi")
        .and_then(|v| v.as_str())
        .ok_or("not an OpenAPI 3.x document (no `openapi` field)")?
        .to_string();
    if !openapi.starts_with("3.") {
        return Err(format!(
            "OpenAPI {openapi} is not supported (3.0 and 3.1 only)"
        ));
    }
    if opts.package.is_empty() {
        return Err("a package name is required (--package @vendor/name)".into());
    }
    // Pins: local files only, digest-checked when given.
    let mut pinned = BTreeMap::new();
    let mut pin_reports = Vec::new();
    for p in &opts.pins {
        let bytes = std::fs::read(&p.file)
            .map_err(|e| format!("pin {}: cannot read {}: {e}", p.url, p.file.display()))?;
        let digest = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        if let Some(expected) = &p.sha256
            && !expected.eq_ignore_ascii_case(&digest)
        {
            return Err(format!(
                "pin {}: sha256 mismatch (expected {expected}, file is {digest})",
                p.url
            ));
        }
        let v: Value = serde_json::from_slice(&bytes)
            .map_err(|e| format!("pin {}: {} is not JSON ({e})", p.url, p.file.display()))?;
        pinned.insert(p.url.clone(), v);
        pin_reports.push(PinReport {
            url: p.url.clone(),
            sha256: digest,
        });
    }
    let info = doc.get("info").cloned().unwrap_or(Value::Null);
    let mut imp = Importer {
        pinned,
        shapes: BTreeMap::new(),
        shape_order: Vec::new(),
        enums: BTreeMap::new(),
        enum_names: BTreeSet::new(),
        enum_field_counts: BTreeMap::new(),
        report: Report {
            version: "openapi-import/1".into(),
            package: opts.package.clone(),
            source: SourceInfo {
                title: info
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .into(),
                version: info
                    .get("version")
                    .and_then(|v| v.as_str())
                    .unwrap_or("0.0.0")
                    .into(),
                openapi: openapi.clone(),
            },
            hosts: Vec::new(),
            pins: pin_reports,
            operations: Vec::new(),
            skipped_operations: Vec::new(),
            unsupported: Vec::new(),
            foreign_identifiers: Vec::new(),
            callbacks: Vec::new(),
            security: Vec::new(),
        },
        doc,
    };

    // Servers: every URL must be an allowed public host.
    if let Some(Value::Array(servers)) = imp.doc.get("servers") {
        for s in servers {
            if let Some(u) = s.get("url").and_then(|v| v.as_str()) {
                if u.starts_with('/') {
                    continue; // relative to the document: no host
                }
                let host = check_host(u, &opts.allow_hosts)?;
                imp.report.hosts.push(host);
            }
        }
    }
    imp.report.hosts.sort();
    imp.report.hosts.dedup();
    // Security schemes: slots for the runtime's external binding, never credentials.
    if let Some(Value::Object(schemes)) = imp.doc.pointer("/components/securitySchemes") {
        for (name, s) in schemes {
            imp.report.security.push(serde_json::json!({ "scheme": name, "type": s.get("type"), "in": s.get("in"), "name": s.get("name") }));
        }
    }

    // Enum sharing needs a first pass over every component schema.
    let components: Vec<(String, Value)> = imp
        .doc
        .pointer("/components/schemas")
        .and_then(|v| v.as_object())
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    for (name, schema) in &components {
        imp.collect_enum_fields(&pascal(name), schema, &format!("components.schemas.{name}"));
    }
    // Component shapes (objects only), in document order for stable names.
    for (name, schema) in &components {
        let d = imp.deref(schema, &format!("components.schemas.{name}"))?;
        if d.get("properties").is_some() {
            imp.shape(&pascal(name), schema, &format!("components.schemas.{name}"))?;
        }
    }

    // Operations.
    let mut functions: Vec<String> = Vec::new();
    let paths: Vec<(String, Value)> = imp
        .doc
        .get("paths")
        .and_then(|v| v.as_object())
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    for (path, item) in &paths {
        let Some(methods) = item.as_object() else {
            continue;
        };
        for (method, op) in methods {
            if !["get", "post", "put", "patch", "delete"].contains(&method.as_str()) {
                continue;
            }
            let op_id = op
                .get("operationId")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| format!("{method}{}", pascal(path)));
            let at = format!("paths.{path}.{method}");
            let fname = pascal(&op_id);
            // Success response: the first 2xx with JSON content (or no content).
            let mut output: Option<String> = None;
            let mut errors: Vec<String> = Vec::new();
            let mut skip = false;
            if let Some(Value::Object(responses)) = op.get("responses") {
                for (code, res) in responses {
                    let res = imp.deref(res, &at)?;
                    let content = res.get("content");
                    if code.starts_with('2') {
                        if output.is_some() {
                            continue;
                        }
                        match content {
                            None => {}
                            Some(c) => match json_media(c).and_then(|m| m.get("schema")) {
                                Some(schema) => {
                                    if let Some(Value::String(r)) = schema.get("$ref") {
                                        output = Some(pascal(r.rsplit('/').next().unwrap_or(r)));
                                    } else {
                                        let d = imp.deref(schema, &at)?;
                                        if d.get("properties").is_some() {
                                            let n = format!("{fname}Output");
                                            imp.shape(
                                                &n,
                                                schema,
                                                &format!("{at}.responses.{code}"),
                                            )?;
                                            output = Some(n);
                                        } else {
                                            imp.unsupported(
                                                "response-schema",
                                                &format!("{at}.responses.{code}"),
                                                "non-object success body; output omitted",
                                            );
                                        }
                                    }
                                }
                                None => {
                                    let media: Vec<&String> = c
                                        .as_object()
                                        .map(|m| m.keys().collect())
                                        .unwrap_or_default();
                                    imp.unsupported(
                                        "binary-media",
                                        &format!("{at}.responses.{code}"),
                                        &format!("non-JSON media {:?}; operation skipped", media),
                                    );
                                    skip = true;
                                }
                            },
                        }
                    } else if code.starts_with('4') && code != "401" && code != "403" {
                        let desc = res
                            .get("description")
                            .and_then(|v| v.as_str())
                            .unwrap_or(code);
                        let e = pascal(desc);
                        if !e.is_empty() && !errors.contains(&e) {
                            errors.push(e);
                        }
                    }
                }
            }
            if skip {
                imp.report.skipped_operations.push(op_id.clone());
                continue;
            }
            // Input: path/query params + JSON body.
            let mut param_lines: Vec<String> = Vec::new();
            if let Some(Value::Array(params)) = op.get("parameters") {
                for p in params {
                    let p = imp.deref(p, &at)?;
                    let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("param");
                    let loc = p.get("in").and_then(|v| v.as_str()).unwrap_or("query");
                    let schema = p.get("schema").cloned().unwrap_or(Value::Null);
                    let pat = format!("{at}.parameters.{name}");
                    if loc == "header" || loc == "cookie" {
                        imp.unsupported(&format!("{loc}-parameter"), &pat, "header/cookie parameters are transport concerns; not part of the input shape");
                        continue;
                    }
                    if schema.get("type").and_then(|t| t.as_str()) == Some("array") {
                        imp.unsupported("query-array-form", &pat, "array query parameters (style/explode serialization) are not importable; parameter dropped");
                        continue;
                    }
                    let required = loc == "path"
                        || p.get("required").and_then(|v| v.as_bool()).unwrap_or(false);
                    if let Some(t) = imp.type_of(&schema, &fname, name, required, &pat)? {
                        param_lines.push(format!("  {} : {t}", ident(name)));
                    }
                }
            }
            let body_schema = op
                .get("requestBody")
                .and_then(|b| imp.deref(b, &at).ok())
                .and_then(|b| {
                    b.get("content")
                        .and_then(json_media)
                        .and_then(|m| m.get("schema"))
                        .cloned()
                });
            let has_non_json_body = op
                .get("requestBody")
                .and_then(|b| b.get("content"))
                .is_some_and(|c| json_media(c).is_none());
            if has_non_json_body {
                imp.unsupported(
                    "binary-media",
                    &format!("{at}.requestBody"),
                    "non-JSON request body; operation skipped",
                );
                imp.report.skipped_operations.push(op_id.clone());
                continue;
            }
            let input: Option<String> = match (&body_schema, param_lines.is_empty()) {
                (Some(schema), true) => match schema.get("$ref") {
                    Some(Value::String(r)) => Some(pascal(r.rsplit('/').next().unwrap_or(r))),
                    _ => {
                        let n = format!("{fname}Input");
                        imp.shape(&n, schema, &format!("{at}.requestBody"))?;
                        Some(n)
                    }
                },
                (Some(schema), false) => {
                    let n = format!("{fname}Input");
                    imp.shape(&n, schema, &format!("{at}.requestBody"))?;
                    let mut lines = param_lines.clone();
                    lines.extend(imp.shapes.get(&n).cloned().unwrap_or_default());
                    imp.shapes.insert(n.clone(), lines);
                    Some(n)
                }
                (None, false) => {
                    let n = format!("{fname}Input");
                    if !imp.shapes.contains_key(&n) {
                        imp.shape_order.push(n.clone());
                    }
                    imp.shapes.insert(n.clone(), param_lines.clone());
                    Some(n)
                }
                (None, true) => None,
            };
            // Callbacks: inbound contracts, recorded for a reviewed endpoint; runtime expressions stay symbolic.
            if let Some(Value::Object(cbs)) = op.get("callbacks") {
                for (cb_name, cb) in cbs {
                    if let Some(exprs) = cb.as_object() {
                        for (expr, item) in exprs {
                            let url = if expr.contains('{') {
                                None
                            } else {
                                Some(check_host(expr, &opts.allow_hosts)?)
                            };
                            let payload = item
                                .as_object()
                                .and_then(|m| m.values().next())
                                .and_then(|o| o.get("requestBody"))
                                .and_then(|b| b.get("content"))
                                .and_then(json_media)
                                .and_then(|m| m.get("schema"))
                                .and_then(|s| s.get("$ref"))
                                .and_then(|r| r.as_str())
                                .map(|r| pascal(r.rsplit('/').next().unwrap_or(r)));
                            imp.report.callbacks.push(Callback {
                                name: format!("{op_id}.{cb_name}"),
                                kind: "callback".into(),
                                url: url.or_else(|| Some(expr.clone())),
                                payload,
                            });
                        }
                    }
                }
            }
            let mut f = String::new();
            f.push_str(&format!(
                "export function {fname}\n  @http({}, {})\n{{\n",
                method.to_uppercase(),
                quote(path)
            ));
            if let Some(i) = &input {
                f.push_str(&format!("  input {i}\n"));
            }
            if let Some(o) = &output {
                f.push_str(&format!("  output {o}\n"));
            }
            if !errors.is_empty() {
                f.push_str("\n  errors {\n");
                for e in &errors {
                    f.push_str(&format!("    {e}\n"));
                }
                f.push_str("  }\n");
            }
            f.push_str("}\n");
            functions.push(f);
            imp.report.operations.push(ImportedOperation {
                operation_id: op_id,
                function: fname,
                method: method.to_uppercase(),
                path: path.clone(),
            });
        }
    }
    // Webhooks (3.1): inbound contracts without a URL.
    if let Some(Value::Object(hooks)) = imp.doc.get("webhooks") {
        for (name, item) in hooks {
            let payload = item
                .as_object()
                .and_then(|m| m.values().next())
                .and_then(|o| o.get("requestBody"))
                .and_then(|b| b.get("content"))
                .and_then(json_media)
                .and_then(|m| m.get("schema"))
                .and_then(|s| s.get("$ref"))
                .and_then(|r| r.as_str())
                .map(|r| pascal(r.rsplit('/').next().unwrap_or(r)));
            imp.report.callbacks.push(Callback {
                name: format!("webhook:{name}"),
                kind: "webhook".into(),
                url: None,
                payload,
            });
        }
    }

    // ---- render
    let mut src = String::new();
    src.push_str(&format!("// Imported from OpenAPI {} \"{}\" v{} by `forgec import-openapi`. Regenerate; do not edit.\n// Foreign identifiers are `text` (see FOREIGN_IDS.md); unsupported features are listed in import-report.json.\n\n", openapi, imp.report.source.title, imp.report.source.version));
    let mut enums: Vec<(&String, &Vec<String>)> = imp.enums.iter().map(|(v, n)| (n, v)).collect();
    enums.sort();
    for (name, values) in enums {
        src.push_str(&format!("export enum {name} {{\n"));
        let mut seen = BTreeSet::new();
        for v in values {
            let mut m = pascal(v);
            if m.is_empty() {
                m = "Empty".into();
            }
            while !seen.insert(m.clone()) {
                m.push('_');
            }
            src.push_str(&format!("  {m} = {}\n", quote(v)));
        }
        src.push_str("}\n\n");
    }
    for name in &imp.shape_order {
        let lines = &imp.shapes[name];
        src.push_str(&format!("export shape {name} {{\n"));
        if lines.is_empty() {
            src.push_str("  _ : json?\n"); // an empty shape is not valid Forge; keep the slot explicit
        }
        for l in lines {
            src.push_str(l);
            src.push('\n');
        }
        src.push_str("}\n\n");
    }
    for f in &functions {
        src.push_str(f);
        src.push('\n');
    }
    let toml = format!(
        "[package]\nname = \"{}\"\nversion = \"{}\"\nedition = \"2026\"\n\n[source]\nroot = \"src\"\nentry = \"src/index.forge\"\n\n[compatibility]\nprofile = \"portable-v1\"\ntargets = [\"cloudflare-d1\", \"aws-dynamodb\"]\n",
        opts.package, imp.report.source.version
    );
    let mut foreign = String::from(
        "# Foreign identifiers\n\nThese fields look like identifiers but belong to the vendor. They are imported as `text` and are\nnever Forge references: a string that happens to match a Forge `Customer` id is not that customer.\nTo relate one to a Forge resource, write a reviewed resolver function that looks the record up by an\nexplicit mapping (an external-id field or a mapping table) and returns the Forge reference.\n\n| shape | field |\n|---|---|\n",
    );
    for f in &imp.report.foreign_identifiers {
        foreign.push_str(&format!("| {} | {} |\n", f.shape, f.field));
    }
    if imp.report.foreign_identifiers.is_empty() {
        foreign.push_str("| (none) | |\n");
    }
    imp.report
        .unsupported
        .sort_by(|a, b| (&a.at, &a.feature).cmp(&(&b.at, &b.feature)));
    imp.report
        .foreign_identifiers
        .sort_by(|a, b| (&a.shape, &a.field).cmp(&(&b.shape, &b.field)));
    imp.report.skipped_operations.sort();
    let mut files = BTreeMap::new();
    files.insert("forge.toml".to_string(), toml);
    files.insert("src/index.forge".to_string(), src);
    files.insert("FOREIGN_IDS.md".to_string(), foreign);
    files.insert(
        "import-report.json".to_string(),
        serde_json::to_string_pretty(&imp.report).map_err(|e| e.to_string())? + "\n",
    );
    Ok(ImportOutput {
        files,
        report: imp.report,
    })
}
