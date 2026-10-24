//! WIT worlds for composable units (FORG-31, research). A function unit's interface comes from
//! DomainIR, so its WIT world is generated from the same declaration, never hand-written and
//! never taken from TS types. The world is `forge:unit/unit`: one export `run` taking the
//! declared input and returning the declared output, with the declared errors as the cases of a
//! `failure` variant, plus one imported interface per capability the unit declares.
//!
//! Nothing in the world names the unit itself, so two units with the same interface get
//! byte-identical WIT and one component can implement either. A JS module and a WASM component
//! that implement the same world share an interface hash; only their implementation differs.
//!
//! Alongside the WIT text this emits a *lowering*: for every WIT type, how a DomainIR wire value
//! maps onto it (field and case names, integers as `s64`). A linker uses it to adapt the JS glue
//! generated from the component (jco-style) to the wire values JS units exchange, so callers do
//! not change when a JS unit is swapped for a WASM one.
//!
//! Types WIT cannot carry faithfully fail with an `E-WIT-*` diagnostic rather than being
//! approximated: `json`, recursive shapes, names WIT cannot spell, and capabilities whose handle
//! has no lowering yet (resource writes, workflow waits and timers).

use crate::units::{CapabilityImport, Scope};
use forgegraph_semantic::ir::*;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// Version of the world layout and of the lowering below.
pub const WIT_ABI: &str = "forge-wit/1";
pub const LOWERING_VERSION: &str = "forge-wit-lowering/1";
pub const WIT_PACKAGE: &str = "forge:unit";
pub const WIT_WORLD: &str = "unit";
pub const WIT_EXPORT: &str = "run";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UnitWit {
    Ok {
        abi: String,
        /// `sha256:` + hex(sha256(world text)).
        digest: String,
        world: String,
        lowering: Value,
    },
    Unsupported {
        diagnostics: Vec<WitDiagnostic>,
    },
}

impl UnitWit {
    pub fn world(&self) -> Option<&str> {
        match self {
            UnitWit::Ok { world, .. } => Some(world),
            UnitWit::Unsupported { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct WitDiagnostic {
    pub code: String,
    /// Where in the signature: `input.lines[].sku`, `output`, `capability resource:…`.
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for WitDiagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "error[{}]: {}: {}", self.code, self.path, self.message)
    }
}

const KEYWORDS: &[&str] = &[
    "as",
    "async",
    "bool",
    "borrow",
    "char",
    "constructor",
    "enum",
    "error-context",
    "export",
    "f32",
    "f64",
    "flags",
    "from",
    "func",
    "future",
    "import",
    "include",
    "interface",
    "list",
    "option",
    "own",
    "package",
    "record",
    "resource",
    "result",
    "s16",
    "s32",
    "s64",
    "s8",
    "static",
    "stream",
    "string",
    "tuple",
    "type",
    "u16",
    "u32",
    "u64",
    "u8",
    "use",
    "variant",
    "with",
    "world",
];

/// `QuoteLine` -> `quote-line`, `taxRateBasisPoints` -> `tax-rate-basis-points`,
/// `HTTPCode` -> `http-code`, `line1` -> `line1`. None when WIT cannot spell it (no ASCII letter
/// to start with, or characters outside ASCII letters, digits, `_`, `-`, `.`, `#`).
pub fn kebab(name: &str) -> Option<String> {
    let chars: Vec<char> = name.chars().collect();
    let mut words: Vec<String> = Vec::new();
    let mut cur = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if matches!(c, '_' | '-' | '.' | '#' | ' ') {
            if !cur.is_empty() {
                words.push(std::mem::take(&mut cur));
            }
            continue;
        }
        if !c.is_ascii_alphanumeric() {
            return None;
        }
        if c.is_ascii_uppercase() && !cur.is_empty() {
            let prev = chars[i - 1];
            let next_lower = chars.get(i + 1).is_some_and(|n| n.is_ascii_lowercase());
            if prev.is_ascii_lowercase()
                || prev.is_ascii_digit()
                || (prev.is_ascii_uppercase() && next_lower)
            {
                words.push(std::mem::take(&mut cur));
            }
        }
        cur.push(c.to_ascii_lowercase());
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    // Every WIT word starts with a letter: a digit-led word joins the previous one.
    let mut out: Vec<String> = Vec::new();
    for w in words {
        if w.starts_with(|c: char| c.is_ascii_digit()) {
            out.last_mut()?.push_str(&w);
        } else {
            out.push(w);
        }
    }
    (!out.is_empty()).then(|| out.join("-"))
}

/// A kebab name as it appears in WIT source: keywords are `%`-escaped.
fn ident(kebab: &str) -> String {
    if KEYWORDS.contains(&kebab) {
        format!("%{kebab}")
    } else {
        kebab.to_string()
    }
}

/// The JS name jco gives a WIT field or function: lowerCamelCase of the kebab name.
fn js_name(kebab: &str) -> String {
    let mut out = String::new();
    for (i, w) in kebab.split('-').enumerate() {
        if i == 0 {
            out.push_str(w);
        } else {
            let mut c = w.chars();
            if let Some(f) = c.next() {
                out.push(f.to_ascii_uppercase());
                out.extend(c);
            }
        }
    }
    out
}

/// The declaration name of an id: `@acme/pricing/_/QuoteLine` -> `QuoteLine`.
fn last_segment(id: &str) -> &str {
    id.rsplit('/').next().unwrap_or(id)
}

struct Lowered {
    wit: String,
    lower: Value,
    /// The domain type when WIT erases it (`money<USD>` carried as a decimal string).
    note: Option<String>,
}

fn plain(wit: &str, t: &str, note: Option<String>) -> Lowered {
    Lowered {
        wit: wit.into(),
        lower: json!({ "t": t }),
        note,
    }
}

#[derive(Default)]
struct Gen<'a> {
    /// Type definitions in dependency order (a type follows everything it uses).
    defs: Vec<String>,
    /// WIT type name -> its lowering.
    types: BTreeMap<String, Value>,
    /// WIT name -> source key, to refuse two declarations that would share a WIT name.
    claimed: BTreeMap<String, String>,
    /// Source key -> WIT name for types already defined.
    done: BTreeMap<String, String>,
    visiting: BTreeSet<String>,
    diagnostics: Vec<WitDiagnostic>,
    scope: Option<&'a Scope<'a>>,
}

impl<'a> Gen<'a> {
    fn diag(&mut self, code: &str, path: &str, message: impl Into<String>) {
        self.diagnostics.push(WitDiagnostic {
            code: code.into(),
            path: path.into(),
            message: message.into(),
        });
    }

    fn scope(&self) -> &'a Scope<'a> {
        self.scope.expect("scope")
    }

    /// Claims `name` for `key`; a different key already holding it is a collision.
    fn claim(&mut self, name: &str, key: &str, path: &str) -> bool {
        match self.claimed.get(name) {
            Some(k) if k != key => {
                let other = k.clone();
                self.diag(
                    "E-WIT-003",
                    path,
                    format!(
                        "`{key}` and `{other}` both lower to the WIT name `{name}`; rename one (WIT names are kebab-case and package-free inside one world)"
                    ),
                );
                false
            }
            _ => {
                self.claimed.insert(name.into(), key.into());
                true
            }
        }
    }

    fn name_of(&mut self, source: &str, path: &str) -> Option<String> {
        let k = kebab(source);
        if k.is_none() {
            self.diag(
                "E-WIT-006",
                path,
                format!(
                    "`{source}` cannot be spelled as a WIT identifier (ASCII letters and digits, starting with a letter)"
                ),
            );
        }
        k
    }

    fn ty(&mut self, t: &TypeSpec, path: &str) -> Option<Lowered> {
        let inner = self.base(&t.base, path)?;
        Some(if t.optional {
            Lowered {
                wit: format!("option<{}>", inner.wit),
                lower: json!({ "t": "option", "of": inner.lower }),
                note: inner.note.map(|n| format!("{n}, optional")),
            }
        } else {
            inner
        })
    }

    fn base(&mut self, base: &TypeBase, path: &str) -> Option<Lowered> {
        let named = |name: String, note: Option<String>| Lowered {
            lower: json!({ "t": "ref", "name": name }),
            wit: ident(&name),
            note,
        };
        match base {
            TypeBase::Scalar { name, args } => {
                let with_args = if args.is_empty() {
                    name.clone()
                } else {
                    format!("{name}<{}>", args.join(", "))
                };
                match name.as_str() {
                    "id" | "text" | "email" | "url" | "timezone" | "countryCode" => {
                        let note = (name != "text").then(|| with_args.clone());
                        Some(plain("string", "string", note))
                    }
                    "integer" => Some(plain("s64", "s64", None)),
                    "boolean" => Some(plain("bool", "bool", None)),
                    // Exact decimals cross as their canonical wire string, never as a float.
                    "decimal" | "money" => Some(plain(
                        "string",
                        "string",
                        Some(format!("{with_args} as a decimal string")),
                    )),
                    "date" | "datetime" | "localTime" | "duration" => Some(plain(
                        "string",
                        "string",
                        Some(format!("{with_args} as ISO 8601 text")),
                    )),
                    "json" => {
                        self.diag(
                            "E-WIT-001",
                            path,
                            "`json` has no WIT type: an untyped value cannot cross a typed component boundary; declare a shape for it",
                        );
                        None
                    }
                    other => {
                        self.diag(
                            "E-WIT-001",
                            path,
                            format!("scalar `{other}` has no WIT lowering"),
                        );
                        None
                    }
                }
            }
            TypeBase::Reference { resource } | TypeBase::Identity { resource } => Some(plain(
                "string",
                "string",
                Some(format!("id of {}", last_segment(resource))),
            )),
            TypeBase::Collection {
                collection,
                element,
            } => {
                let e = self.ty(element, &format!("{path}[]"))?;
                Some(match collection {
                    CollectionKind::List => Lowered {
                        wit: format!("list<{}>", e.wit),
                        lower: json!({ "t": "list", "of": e.lower }),
                        note: None,
                    },
                    CollectionKind::Set => Lowered {
                        wit: format!("list<{}>", e.wit),
                        lower: json!({ "t": "list", "of": e.lower }),
                        note: Some("set: unique, in canonical order".into()),
                    },
                    CollectionKind::Map => Lowered {
                        wit: format!("list<tuple<string, {}>>", e.wit),
                        lower: json!({ "t": "map", "of": e.lower }),
                        note: Some("map: entries sorted by key".into()),
                    },
                })
            }
            TypeBase::Enum { id } => {
                let scope = self.scope();
                let Some(e) = scope.irs.iter().find_map(|ir| ir.find_enum(id)) else {
                    self.diag("E-WIT-002", path, format!("enum `{id}` does not resolve"));
                    return None;
                };
                let cases: Vec<(String, String)> = e
                    .members
                    .iter()
                    .map(|m| (m.name.clone(), m.value.clone()))
                    .collect();
                let name = self.enum_def(id, last_segment(id), &cases, path)?;
                Some(named(name, None))
            }
            TypeBase::Status { resource } => {
                let scope = self.scope();
                let Some(l) = scope.resource(resource).and_then(|r| r.lifecycle.as_ref()) else {
                    self.diag(
                        "E-WIT-002",
                        path,
                        format!("`{resource}` has no lifecycle, so its status does not resolve"),
                    );
                    return None;
                };
                let cases: Vec<(String, String)> =
                    l.states.iter().map(|s| (s.clone(), s.clone())).collect();
                let display = format!("{}Status", last_segment(resource));
                let name = self.enum_def(&format!("{resource}.Status"), &display, &cases, path)?;
                Some(named(name, None))
            }
            TypeBase::Shape { id } => {
                let scope = self.scope();
                let Some(s) = scope.irs.iter().find_map(|ir| ir.find_shape(id)) else {
                    self.diag("E-WIT-002", path, format!("shape `{id}` does not resolve"));
                    return None;
                };
                let name = self.record_def(id, last_segment(id), &s.fields, path)?;
                Some(named(name, None))
            }
            TypeBase::Record { resource } => {
                let name = self.resource_record(resource, path)?;
                Some(named(name, None))
            }
            TypeBase::Message { channel, message } => {
                let scope = self.scope();
                let Some(m) = scope
                    .channel(channel)
                    .and_then(|c| c.messages.iter().find(|m| &m.name == message))
                else {
                    self.diag(
                        "E-WIT-002",
                        path,
                        format!("message `{channel}#{message}` does not resolve"),
                    );
                    return None;
                };
                let display = format!("{}{}", last_segment(channel), message);
                let name =
                    self.record_def(&format!("{channel}#{message}"), &display, &m.fields, path)?;
                Some(named(name, None))
            }
        }
    }

    fn resource_record(&mut self, resource: &str, path: &str) -> Option<String> {
        let scope = self.scope();
        let Some(r) = scope.resource(resource) else {
            self.diag(
                "E-WIT-002",
                path,
                format!("resource `{resource}` does not resolve"),
            );
            return None;
        };
        let wire: Vec<Field> = r.fields.iter().filter(|f| !f.hidden).cloned().collect();
        let display = format!("{}Record", last_segment(resource));
        self.record_def(&format!("{resource}.Record"), &display, &wire, path)
    }

    fn enum_def(
        &mut self,
        key: &str,
        display: &str,
        cases: &[(String, String)],
        path: &str,
    ) -> Option<String> {
        if let Some(n) = self.done.get(key) {
            return Some(n.clone());
        }
        let name = self.name_of(display, path)?;
        if !self.claim(&name, key, path) {
            return None;
        }
        if cases.is_empty() {
            self.diag(
                "E-WIT-007",
                path,
                format!("`{key}` has no members; a WIT enum needs at least one case"),
            );
            return None;
        }
        let mut seen = BTreeMap::new();
        let mut lowered = Vec::new();
        let mut ok = true;
        for (case_name, wire) in cases {
            let Some(case) = self.name_of(case_name, &format!("{path} ({key}.{case_name})")) else {
                ok = false;
                continue;
            };
            if let Some(prev) = seen.insert(case.clone(), case_name.clone()) {
                self.diag(
                    "E-WIT-003",
                    path,
                    format!("members `{prev}` and `{case_name}` of `{key}` both lower to the WIT case `{case}`"),
                );
                ok = false;
            }
            lowered.push((case, wire.clone()));
        }
        if !ok {
            return None;
        }
        let body: Vec<String> = lowered
            .iter()
            .map(|(c, _)| format!("    {},", ident(c)))
            .collect();
        self.defs.push(format!(
            "  enum {} {{\n{}\n  }}",
            ident(&name),
            body.join("\n")
        ));
        self.types.insert(
            name.clone(),
            json!({ "kind": "enum", "cases": lowered.iter().map(|(c, w)| json!({ "case": c, "wire": w })).collect::<Vec<_>>() }),
        );
        self.done.insert(key.into(), name.clone());
        Some(name)
    }

    fn record_def(
        &mut self,
        key: &str,
        display: &str,
        fields: &[Field],
        path: &str,
    ) -> Option<String> {
        if let Some(n) = self.done.get(key) {
            return Some(n.clone());
        }
        if self.visiting.contains(key) {
            self.diag(
                "E-WIT-004",
                path,
                format!("`{key}` reaches itself; WIT types cannot be recursive"),
            );
            return None;
        }
        let name = self.name_of(display, path)?;
        if !self.claim(&name, key, path) {
            return None;
        }
        if fields.is_empty() {
            self.diag(
                "E-WIT-007",
                path,
                format!("`{key}` has no fields; a WIT record needs at least one"),
            );
            return None;
        }
        self.visiting.insert(key.into());
        let mut seen = BTreeMap::new();
        let mut body = Vec::new();
        let mut lowered = Vec::new();
        let mut ok = true;
        for f in fields {
            let fpath = format!("{path}.{}", f.name);
            let Some(field) = self.name_of(&f.name, &fpath) else {
                ok = false;
                continue;
            };
            if let Some(prev) = seen.insert(field.clone(), f.name.clone()) {
                self.diag(
                    "E-WIT-003",
                    &fpath,
                    format!(
                        "fields `{prev}` and `{}` of `{key}` both lower to the WIT field `{field}`",
                        f.name
                    ),
                );
                ok = false;
            }
            let Some(t) = self.ty(&f.ty, &fpath) else {
                ok = false;
                continue;
            };
            if let Some(n) = &t.note {
                body.push(format!("    /// {n}"));
            }
            body.push(format!("    {}: {},", ident(&field), t.wit));
            lowered.push(
                json!({ "wire": f.name, "wit": field, "js": js_name(&field), "type": t.lower }),
            );
        }
        self.visiting.remove(key);
        if !ok {
            return None;
        }
        self.defs.push(format!(
            "  record {} {{\n{}\n  }}",
            ident(&name),
            body.join("\n")
        ));
        self.types
            .insert(name.clone(), json!({ "kind": "record", "fields": lowered }));
        self.done.insert(key.into(), name.clone());
        Some(name)
    }

    /// `variant <name> { <error>(option<string>), …[, fault(fault)] }`; the payload is the detail.
    fn failure_def(
        &mut self,
        key: &str,
        name: &str,
        errors: &[String],
        fault: bool,
        path: &str,
    ) -> Option<String> {
        if !self.claim(name, key, path) {
            return None;
        }
        let mut cases = Vec::new();
        let mut seen = BTreeMap::new();
        let mut ok = true;
        for e in errors {
            let Some(case) = self.name_of(e, &format!("{path} error {e}")) else {
                ok = false;
                continue;
            };
            if fault && case == "fault" {
                self.diag(
                    "E-WIT-003",
                    path,
                    "error `Fault` collides with the `fault` case that carries capability failures",
                );
                ok = false;
            }
            if let Some(prev) = seen.insert(case.clone(), e.clone()) {
                self.diag(
                    "E-WIT-003",
                    path,
                    format!("errors `{prev}` and `{e}` both lower to the WIT case `{case}`"),
                );
                ok = false;
            }
            cases.push((case, e.clone()));
        }
        if !ok {
            return None;
        }
        let mut body: Vec<String> = cases
            .iter()
            .map(|(c, _)| format!("    {}(option<string>),", ident(c)))
            .collect();
        if fault {
            body.push(
                "    /// A capability handle failed (not found, conflict, forbidden, unavailable)."
                    .into(),
            );
            body.push("    fault(fault),".into());
        }
        self.defs.push(format!(
            "  variant {} {{\n{}\n  }}",
            ident(name),
            body.join("\n")
        ));
        self.types.insert(
            name.into(),
            json!({ "kind": "failure", "cases": cases.iter().map(|(c, w)| json!({ "case": c, "wire": w })).collect::<Vec<_>>(), "fault": fault }),
        );
        Some(name.into())
    }

    fn fault_def(&mut self) {
        if self.types.contains_key("fault") || !self.claim("fault", "forge:fault", "capabilities") {
            return;
        }
        self.defs.push(
            "  /// The runtime error a capability handle returned: its code and detail.\n  record fault {\n    code: string,\n    detail: option<string>,\n  }".into(),
        );
        self.types.insert(
            "fault".into(),
            json!({ "kind": "record", "fields": [
                { "wire": "code", "wit": "code", "js": "code", "type": { "t": "string" } },
                { "wire": "detail", "wit": "detail", "js": "detail", "type": { "t": "option", "of": { "t": "string" } } },
            ] }),
        );
    }
}

/// `func(<params>) -> <result>` with its lowering.
struct Signature {
    params: Vec<(String, Lowered)>,
    ok: Option<Lowered>,
    err: Option<String>,
}

impl Signature {
    fn wit(&self) -> String {
        let params: Vec<String> = self
            .params
            .iter()
            .map(|(n, t)| format!("{}: {}", ident(n), t.wit))
            .collect();
        let result = match (&self.ok, &self.err) {
            (Some(ok), Some(err)) => format!(" -> result<{}, {}>", ok.wit, ident(err)),
            (None, Some(err)) => format!(" -> result<_, {}>", ident(err)),
            (Some(ok), None) => format!(" -> {}", ok.wit),
            (None, None) => String::new(),
        };
        format!("func({}){result}", params.join(", "))
    }

    fn lowering(&self, name: &str) -> Value {
        json!({
            "name": name,
            "js": js_name(name),
            "params": self.params.iter().map(|(n, t)| json!({ "name": n, "type": t.lower })).collect::<Vec<_>>(),
            "result": self.ok.as_ref().map(|t| t.lower.clone()),
            "error": self.err,
        })
    }
}

struct ImportIface {
    capability: String,
    name: String,
    funcs: Vec<(String, Signature, String)>,
}

/// The WIT world of a function (or external) unit, from its DomainIR declaration and the
/// capability imports the planner bound for it.
pub(crate) fn function_world(scope: &Scope, f: &Function, imports: &[CapabilityImport]) -> UnitWit {
    let mut g = Gen {
        scope: Some(scope),
        ..Gen::default()
    };
    let input = f.input.as_ref().and_then(|t| g.ty(t, "input"));
    let input_ok = f.input.is_none() || input.is_some();
    let output = f.output.as_ref().and_then(|t| g.ty(t, "output"));
    let output_ok = f.output.is_none() || output.is_some();

    let mut ifaces: Vec<ImportIface> = Vec::new();
    for imp in imports {
        let cap = imp.capability.as_str();
        let path = format!("capability {cap}");
        if let Some(i) = import_iface(&mut g, cap, &path)
            && g.claim(&i.name, &format!("import:{cap}"), &path)
        {
            ifaces.push(i);
        }
    }
    if !ifaces.is_empty() {
        g.fault_def();
    }
    let mut errors = f.errors.clone();
    errors.sort();
    errors.dedup();
    let failure = if errors.is_empty() && ifaces.is_empty() {
        None
    } else {
        g.failure_def(
            "forge:failure",
            "failure",
            &errors,
            !ifaces.is_empty(),
            "errors",
        )
    };
    let failure_ok = (errors.is_empty() && ifaces.is_empty()) || failure.is_some();

    if !g.diagnostics.is_empty() || !input_ok || !output_ok || !failure_ok {
        g.diagnostics.sort();
        g.diagnostics.dedup();
        return UnitWit::Unsupported {
            diagnostics: g.diagnostics,
        };
    }

    let export = Signature {
        params: input
            .map(|t| ("input".to_string(), t))
            .into_iter()
            .collect(),
        ok: output,
        err: failure,
    };

    let mut text = String::new();
    text.push_str(&format!(
        "// Generated by forgec from DomainIR ({WIT_ABI}). Do not edit: change the .forge declaration.\n\
         // Errors are the cases of `failure`; each declared capability is an imported interface.\n\
         package {WIT_PACKAGE};\n"
    ));
    let mut type_names: Vec<&String> = g.types.keys().collect();
    type_names.sort();
    if !g.defs.is_empty() {
        text.push_str("\ninterface types {\n");
        text.push_str(&g.defs.join("\n\n"));
        text.push_str("\n}\n");
    }
    for i in &ifaces {
        let mut used: BTreeSet<String> = BTreeSet::new();
        for (_, sig, _) in &i.funcs {
            for (_, t) in &sig.params {
                collect_refs(&t.lower, &mut used);
            }
            if let Some(t) = &sig.ok {
                collect_refs(&t.lower, &mut used);
            }
            if let Some(e) = &sig.err {
                used.insert(e.clone());
            }
        }
        text.push_str(&format!(
            "\n/// `{}`\ninterface {} {{\n",
            i.capability,
            ident(&i.name)
        ));
        if !used.is_empty() {
            let list: Vec<String> = used.iter().map(|n| ident(n)).collect();
            text.push_str(&format!("  use types.{{{}}};\n", list.join(", ")));
        }
        for (name, sig, doc) in &i.funcs {
            text.push_str(&format!("  /// {doc}\n  {}: {};\n", ident(name), sig.wit()));
        }
        text.push_str("}\n");
    }
    text.push_str(&format!("\nworld {WIT_WORLD} {{\n"));
    let mut used: BTreeSet<String> = BTreeSet::new();
    for (_, t) in &export.params {
        collect_refs(&t.lower, &mut used);
    }
    if let Some(t) = &export.ok {
        collect_refs(&t.lower, &mut used);
    }
    if let Some(e) = &export.err {
        used.insert(e.clone());
    }
    if !used.is_empty() {
        let list: Vec<String> = used.iter().map(|n| ident(n)).collect();
        text.push_str(&format!("  use types.{{{}}};\n", list.join(", ")));
    }
    for i in &ifaces {
        text.push_str(&format!("  import {};\n", ident(&i.name)));
    }
    text.push_str(&format!("  export {WIT_EXPORT}: {};\n}}\n", export.wit()));

    let lowering = json!({
        "version": LOWERING_VERSION,
        "package": WIT_PACKAGE,
        "world": WIT_WORLD,
        "export": export.lowering(WIT_EXPORT),
        "types": g.types,
        "imports": ifaces.iter().map(|i| json!({
            "capability": i.capability,
            "interface": format!("{WIT_PACKAGE}/{}", i.name),
            "functions": i.funcs.iter().map(|(n, s, _)| s.lowering(n)).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    });
    UnitWit::Ok {
        abi: WIT_ABI.into(),
        digest: format!("sha256:{}", hash_hex(&text)),
        world: text,
        lowering,
    }
}

fn collect_refs(lower: &Value, out: &mut BTreeSet<String>) {
    match lower.get("t").and_then(Value::as_str) {
        Some("ref") => {
            if let Some(n) = lower.get("name").and_then(Value::as_str) {
                out.insert(n.into());
            }
        }
        Some("option" | "list" | "map") => {
            if let Some(of) = lower.get("of") {
                collect_refs(of, out);
            }
        }
        _ => {}
    }
}

fn id_param() -> (String, Lowered) {
    ("id".into(), plain("string", "string", None))
}

fn import_iface(g: &mut Gen, cap: &str, path: &str) -> Option<ImportIface> {
    let scope = g.scope();
    let unsupported = |g: &mut Gen, why: &str| {
        g.diag("E-WIT-005", path, why.to_string());
        None
    };
    if let Some(rest) = cap.strip_prefix("resource:") {
        let (resource, capability) = rest.split_once('#')?;
        if capability != "read" {
            return unsupported(
                g,
                &format!(
                    "`{capability}` handles have no WIT lowering yet (only `read`); implement this unit as a js-module"
                ),
            );
        }
        let record = g.resource_record(resource, path)?;
        let name = format!("resource-{}-read", g.name_of(last_segment(resource), path)?);
        return Some(ImportIface {
            capability: cap.into(),
            name,
            funcs: vec![(
                "get".into(),
                Signature {
                    params: vec![id_param()],
                    ok: Some(Lowered {
                        wit: ident(&record),
                        lower: json!({ "t": "ref", "name": record }),
                        note: None,
                    }),
                    err: Some("fault".into()),
                },
                format!(
                    "Reads one {} by id. Named finds and lists are not lowered yet.",
                    last_segment(resource)
                ),
            )],
        });
    }
    if let Some(op) = cap.strip_prefix("transition:") {
        let (resource, action) = op.split_once(".status.")?;
        let Some(t) = scope
            .resource(resource)
            .and_then(|r| r.lifecycle.as_ref())
            .and_then(|l| l.transitions.iter().find(|t| t.action == action))
        else {
            g.diag(
                "E-WIT-002",
                path,
                format!("transition `{op}` does not resolve"),
            );
            return None;
        };
        let record = g.resource_record(resource, path)?;
        let mut params = vec![
            id_param(),
            ("expected-version".into(), plain("s64", "s64", None)),
        ];
        if !t.input.is_empty() {
            let display = format!("{}-{action}-Input", last_segment(resource));
            let input = g.record_def(&format!("{op}#input"), &display, &t.input, path)?;
            params.push((
                "input".into(),
                Lowered {
                    wit: ident(&input),
                    lower: json!({ "t": "ref", "name": input }),
                    note: None,
                },
            ));
        }
        let name = format!(
            "transition-{}-{}",
            g.name_of(last_segment(resource), path)?,
            g.name_of(action, path)?
        );
        return Some(ImportIface {
            capability: cap.into(),
            name,
            funcs: vec![(
                "apply".into(),
                Signature {
                    params,
                    ok: Some(Lowered {
                        wit: ident(&record),
                        lower: json!({ "t": "ref", "name": record }),
                        note: None,
                    }),
                    err: Some("fault".into()),
                },
                format!(
                    "Applies the `{action}` transition to one {} at the expected version.",
                    last_segment(resource)
                ),
            )],
        });
    }
    if let Some(id) = cap.strip_prefix("function:") {
        let Some(callee) = scope.function(id) else {
            g.diag(
                "E-WIT-002",
                path,
                format!("function `{id}` does not resolve"),
            );
            return None;
        };
        let base = g.name_of(last_segment(id), path)?;
        let input = match &callee.input {
            Some(t) => Some(g.ty(t, &format!("{path} input"))?),
            None => None,
        };
        let output = match &callee.output {
            Some(t) => Some(g.ty(t, &format!("{path} output"))?),
            None => None,
        };
        let mut errors = callee.errors.clone();
        errors.sort();
        errors.dedup();
        g.fault_def();
        let err = if errors.is_empty() {
            "fault".to_string()
        } else {
            g.failure_def(
                &format!("{id}#failure"),
                &format!("{base}-failure"),
                &errors,
                true,
                path,
            )?
        };
        return Some(ImportIface {
            capability: cap.into(),
            name: format!("function-{base}"),
            funcs: vec![(
                "call".into(),
                Signature {
                    params: input
                        .map(|t| ("input".to_string(), t))
                        .into_iter()
                        .collect(),
                    ok: output,
                    err: Some(err),
                },
                format!("Calls {} through its unit binding.", last_segment(id)),
            )],
        });
    }
    if let Some(rest) = cap.strip_prefix("send:") {
        let (channel, message) = rest.split_once('#')?;
        let payload = g.base(
            &TypeBase::Message {
                channel: channel.into(),
                message: message.into(),
            },
            path,
        )?;
        let name = format!(
            "send-{}-{}",
            g.name_of(last_segment(channel), path)?,
            g.name_of(message, path)?
        );
        return Some(ImportIface {
            capability: cap.into(),
            name,
            funcs: vec![(
                "send".into(),
                Signature {
                    params: vec![("payload".into(), payload)],
                    ok: None,
                    err: Some("fault".into()),
                },
                "Stages the message; it is delivered with the unit's commit.".into(),
            )],
        });
    }
    unsupported(
        g,
        "workflow waits and timers have no WIT lowering; workflows run forge-native",
    )
}

fn spec(base: TypeBase) -> TypeSpec {
    TypeSpec {
        base,
        optional: false,
        normalizers: vec![],
        constraints: vec![],
        purpose: None,
        data_class: None,
    }
}

/// What a unit's capabilities present to its implementation, for its interface hash (FORG-36).
/// It follows `import_iface`: a resource handle answers with the resource's record, a transition
/// takes its input fields and answers with the record, a callee has its input, output and
/// errors, and a send carries the message. The same types reach the WIT world's imports, so a
/// change that changes the world changes the interface hash too. Returns the per-capability
/// signatures and the type roots they reach, which go into the interface's `types` with the
/// unit's own input and output. It covers every resource capability, including those WIT does not
/// lower yet (`write`): a JS implementation reaches the record through them all the same.
pub(crate) fn capability_surface(
    scope: &Scope,
    imports: &[CapabilityImport],
) -> (BTreeMap<String, Value>, Vec<TypeSpec>) {
    let mut surface = BTreeMap::new();
    let mut roots = Vec::new();
    let record = |resource: &str| {
        spec(TypeBase::Record {
            resource: resource.into(),
        })
    };
    for imp in imports {
        let cap = imp.capability.as_str();
        let entry = if let Some((resource, _)) = cap
            .strip_prefix("resource:")
            .and_then(|r| r.split_once('#'))
        {
            roots.push(record(resource));
            json!({ "record": format!("{resource}.Record") })
        } else if let Some((resource, action)) = cap
            .strip_prefix("transition:")
            .and_then(|op| op.split_once(".status."))
        {
            let input: Vec<Field> = scope
                .resource(resource)
                .and_then(|r| r.lifecycle.as_ref())
                .and_then(|l| l.transitions.iter().find(|t| t.action == action))
                .map(|t| t.input.clone())
                .unwrap_or_default();
            roots.push(record(resource));
            roots.extend(input.iter().map(|f| f.ty.clone()));
            json!({ "record": format!("{resource}.Record"), "input": input })
        } else if let Some(id) = cap.strip_prefix("function:") {
            match scope.function(id) {
                Some(callee) => {
                    roots.extend(callee.input.iter().chain(callee.output.iter()).cloned());
                    let mut errors = callee.errors.clone();
                    errors.sort();
                    errors.dedup();
                    json!({ "input": callee.input, "output": callee.output, "errors": errors })
                }
                None => json!({ "unresolved": true }),
            }
        } else if let Some((channel, message)) =
            cap.strip_prefix("send:").and_then(|s| s.split_once('#'))
        {
            roots.push(spec(TypeBase::Message {
                channel: channel.into(),
                message: message.into(),
            }));
            json!({ "payload": format!("{channel}#{message}") })
        } else {
            continue;
        };
        surface.insert(cap.to_string(), entry);
    }
    (surface, roots)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kebab_follows_wit_identifier_rules() {
        for (from, to) in [
            ("QuoteLine", Some("quote-line")),
            ("taxRateBasisPoints", Some("tax-rate-basis-points")),
            ("HTTPCode", Some("http-code")),
            ("line1", Some("line1")),
            ("utf8Bytes", Some("utf8-bytes")),
            ("line_2", Some("line2")),
            ("Order.Record", Some("order-record")),
            (
                "OrderEvents#OrderSubmitted",
                Some("order-events-order-submitted"),
            ),
            ("1st", None),
            ("caf\u{e9}", None),
            ("", None),
        ] {
            assert_eq!(kebab(from).as_deref(), to, "{from}");
        }
        assert_eq!(ident("type"), "%type");
        assert_eq!(ident("tier"), "tier");
        assert_eq!(js_name("tax-rate-basis-points"), "taxRateBasisPoints");
    }
}
