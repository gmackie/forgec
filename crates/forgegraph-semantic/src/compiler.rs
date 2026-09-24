//! Semantic passes: collect symbols, resolve references, elaborate decorators
//! and lifecycles, run the required checks (plan §7.3), and emit DomainIR.

use crate::diagnostics::{Diagnostic, Severity, line_col, suggest};
use crate::ir::*;
use crate::package::{Package, SourceFile};
use forgegraph_syntax::ast::{self, ArgValue, AstNode, Declaration, RefinementKind};
use forgegraph_syntax::{Parse, parse};
use std::collections::{BTreeMap, BTreeSet};

pub const SCALARS: &[&str] = &[
    "id",
    "text",
    "integer",
    "decimal",
    "money",
    "boolean",
    "date",
    "datetime",
    "localTime",
    "duration",
    "email",
    "timezone",
    "countryCode",
    "url",
    "json",
];
const RESOURCE_DECORATORS: &[&str] = &[
    "facet",
    "tenant",
    "timestamps",
    "softDelete",
    "appendOnly",
    "writeOnce",
    "versioned",
    "audited",
    "crud",
    "effectiveDated",
    "hierarchical",
    "label",
    "purposeScoped",
    "subject",
    "record",
];
const FIELD_DECORATORS: &[&str] = &["unique", "immutable", "label", "data", "sequence", "secret"];
/// Declarations and decorators that need `edition = "2027"`.
const EDITION_2027_DECORATORS: &[&str] = &["purposeScoped", "subject", "data", "record"];
const FUNCTION_DECORATORS: &[&str] = &["http", "label"];
const HTTP_METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE"];
const DEFAULT_MODULE: &str = "_";

pub struct Compilation {
    pub ir: Option<DomainIR>,
    pub diagnostics: Vec<Diagnostic>,
    /// Build-local UTF-8 spans, excluded from canonical DomainIR.
    pub source_index: BTreeMap<String, SourceSpan>,
    pub references: Vec<SourceReference>,
    pub(crate) files: Vec<SourceFile>,
    pub(crate) parsed: BTreeMap<String, Parse>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SourceSpan {
    pub file: String,
    pub start: usize,
    pub end: usize,
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SourceReference {
    pub span: SourceSpan,
    pub target: String,
}

impl Compilation {
    /// Stable, human-readable rendering: `severity[code]: file:line:col: message`.
    pub fn render(&self) -> String {
        let mut out = String::new();
        for d in &self.diagnostics {
            let text = self
                .files
                .iter()
                .find(|f| f.path == d.file)
                .map(|f| f.text.as_str())
                .unwrap_or("");
            let (line, col) = line_col(text, d.start);
            let sev = match d.severity {
                Severity::Error => "error",
                Severity::Warning => "warning",
            };
            out.push_str(&format!(
                "{sev}[{}]: {}:{line}:{col}: {}\n",
                d.code, d.file, d.message
            ));
            if let Some(s) = &d.suggestion {
                out.push_str(&format!("  help: {s}\n"));
            }
        }
        out
    }
}

struct ParsedFile {
    path: String,
    parse: Parse,
    module: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SymKind {
    Enum,
    Type,
    Shape,
    Facet,
    Resource,
    Blob,
    Cache,
    View,
    Projection,
    Function,
    Channel,
    Source,
    Workflow,
    WorkQueue,
    Actor,
    Purpose,
    DataClass,
}

struct Symbol {
    kind: SymKind,
    exported: bool,
    file: usize,
    decl: Declaration,
}

struct Ctx<'a> {
    pkg: &'a Package,
    deps: BTreeMap<String, &'a DomainIR>,
    diags: Vec<Diagnostic>,
    files: Vec<ParsedFile>,
    symbols: BTreeMap<(String, String), Symbol>,
    /// Import aliases visible per module.
    imports: BTreeMap<String, BTreeSet<String>>,
    /// Resources whose fields are being derived right now (recursion guard).
    resolving: Vec<String>,
    facet_origins: BTreeMap<String, String>,
    references: Vec<SourceReference>,
    type_depth: usize,
}

#[derive(Debug, Clone, PartialEq)]
/// Per-workflow lowering state: declared step ids, names bound so far, declared errors.
struct WfScope {
    ids: Vec<String>,
    bound: Vec<String>,
    errors: Vec<String>,
    /// Types of `input` and completed steps, for argument checking (E-WF-008).
    types: Vec<(String, TypeSpec)>,
}

enum Resolved {
    Type(TypeBase),
    Function(String),
    Channel(String),
    Transition { resource: String, action: String },
}

pub fn compile(pkg: &Package, deps: &[&DomainIR]) -> Compilation {
    compile_with_parser(pkg, deps, &mut |text| parse(text))
}

pub(crate) fn compile_with_parser(
    pkg: &Package,
    deps: &[&DomainIR],
    parser: &mut impl FnMut(&str) -> Parse,
) -> Compilation {
    let mut files: Vec<&SourceFile> = pkg.files.iter().collect();
    files.sort_by_key(|a| norm_path(&a.path));

    let mut ctx = Ctx {
        pkg,
        deps: BTreeMap::new(),
        diags: Vec::new(),
        files: Vec::new(),
        symbols: BTreeMap::new(),
        imports: BTreeMap::new(),
        resolving: Vec::new(),
        facet_origins: BTreeMap::new(),
        references: Vec::new(),
        type_depth: 0,
    };
    for (alias, name) in &pkg.dependencies {
        match deps.iter().find(|d| &d.package.name == name) {
            Some(d) => {
                ctx.deps.insert(alias.clone(), d);
            }
            None => ctx.diags.push(Diagnostic {
                code: "E-IMP-002".into(),
                severity: Severity::Error,
                message: format!(
                    "dependency `{alias}` (`{name}`) was not provided to the compiler"
                ),
                file: "forge.toml".into(),
                start: 0,
                end: 0,
                suggestion: None,
            }),
        }
    }

    // 1. parse
    for f in &files {
        let path = norm_path(&f.path);
        let parse = parser(&f.text);
        for e in parse.errors() {
            ctx.diags.push(Diagnostic {
                code: "E-SYN-001".into(),
                severity: Severity::Error,
                message: e.message.clone(),
                file: path.clone(),
                start: e.range.start,
                end: e.range.end,
                suggestion: None,
            });
        }
        let module = parse
            .root()
            .declarations()
            .find_map(|d| {
                if let Declaration::Module(m) = d {
                    m.path().map(|p| p.text())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| DEFAULT_MODULE.into());
        ctx.files.push(ParsedFile {
            path,
            parse,
            module,
        });
    }

    // 2. collect symbols and imports
    ctx.collect();
    // 3. elaborate + check
    let ir = ctx.build();
    let has_errors = ctx.diags.iter().any(|d| d.is_error());
    ctx.diags
        .sort_by(|a, b| (&a.file, a.start, &a.code).cmp(&(&b.file, b.start, &b.code)));
    let mut source_index = BTreeMap::new();
    for ((module, name), symbol) in &ctx.symbols {
        let id = ctx.id(module, name);
        let span = |range: (usize, usize)| SourceSpan {
            file: ctx.files[symbol.file].path.clone(),
            start: range.0,
            end: range.1,
        };
        source_index.insert(
            id.clone(),
            span((
                u32::from(symbol.decl.syntax().text_range().start()) as usize,
                u32::from(symbol.decl.syntax().text_range().end()) as usize,
            )),
        );
        for node in symbol
            .decl
            .syntax()
            .children()
            .filter(|n| n.kind() == forgegraph_syntax::SyntaxKind::FIELD_DECL)
        {
            let field = ast::FieldDecl::cast(node).unwrap();
            if let Some(name) = field.name() {
                source_index.insert(
                    format!("{id}#field:{}", name.text()),
                    span(range_of(&field)),
                );
            }
        }
        if let Declaration::Resource(resource) = &symbol.decl {
            for node in resource
                .syntax()
                .descendants()
                .filter(|n| n.kind() == forgegraph_syntax::SyntaxKind::NAME_EXPR)
            {
                if let Some(q) = node.children().find_map(ast::QualifiedName::cast)
                    && let [field] = q.segments().as_slice()
                {
                    let anchor = format!("{id}#field:{field}");
                    if let Some(target) = ctx.facet_origins.get(&anchor) {
                        ctx.references.push(SourceReference {
                            span: span(range_of(&q)),
                            target: target.clone(),
                        });
                    }
                }
            }
        }
    }
    for (effective, origin) in &ctx.facet_origins {
        if let Some(span) = source_index.get(origin).cloned() {
            source_index.insert(effective.clone(), span);
        }
    }
    ctx.references.sort_by(|a, b| {
        (&a.span.file, a.span.start, a.span.end, &a.target).cmp(&(
            &b.span.file,
            b.span.start,
            b.span.end,
            &b.target,
        ))
    });
    ctx.references.dedup();
    Compilation {
        source_index,
        references: ctx.references,
        parsed: ctx
            .files
            .iter()
            .map(|f| (f.path.clone(), f.parse.clone()))
            .collect(),
        ir: if has_errors { None } else { Some(ir) },
        diagnostics: ctx.diags,
        files: files
            .into_iter()
            .map(|f| SourceFile {
                path: norm_path(&f.path),
                text: f.text.clone(),
            })
            .collect(),
    }
}

fn norm_path(p: &str) -> String {
    p.replace('\\', "/")
}

fn range_of<N: AstNode>(n: &N) -> (usize, usize) {
    let r = n.range();
    (r.start().into(), r.end().into())
}
fn tok_range(t: &forgegraph_syntax::SyntaxToken) -> (usize, usize) {
    let r = t.text_range();
    (r.start().into(), r.end().into())
}
fn camel(parts: &[String]) -> String {
    let mut s = String::from("by");
    for p in parts {
        let mut c = p.chars();
        if let Some(f) = c.next() {
            s.push(f.to_ascii_uppercase());
            s.push_str(c.as_str());
        }
    }
    s
}
fn kebab(parts: &[String]) -> String {
    let mut s = String::from("by");
    for p in parts {
        s.push('-');
        s.push_str(
            &p.chars()
                .flat_map(|c| {
                    if c.is_ascii_uppercase() {
                        vec!['-', c.to_ascii_lowercase()]
                    } else {
                        vec![c]
                    }
                })
                .collect::<String>(),
        );
    }
    s
}

impl<'a> Ctx<'a> {
    fn err(
        &mut self,
        code: &str,
        file: usize,
        range: (usize, usize),
        msg: impl Into<String>,
        suggestion: Option<String>,
    ) {
        let severity = if code.starts_with('W') {
            Severity::Warning
        } else {
            Severity::Error
        };
        self.diags.push(Diagnostic {
            code: code.into(),
            severity,
            message: msg.into(),
            file: self.files[file].path.clone(),
            start: range.0,
            end: range.1,
            suggestion,
        });
    }
    fn id(&self, module: &str, name: &str) -> String {
        format!("{}/{}/{}", self.pkg.name, module, name)
    }

    // ------------------------------------------------------------ collect
    fn collect(&mut self) {
        for fi in 0..self.files.len() {
            let module = self.files[fi].module.clone();
            let decls: Vec<Declaration> = self.files[fi].parse.root().declarations().collect();
            for d in decls {
                let kind = match &d {
                    Declaration::Enum(_) => SymKind::Enum,
                    Declaration::Type(_) => SymKind::Type,
                    Declaration::Shape(_) => SymKind::Shape,
                    Declaration::Facet(_) => SymKind::Facet,
                    Declaration::Resource(_) => SymKind::Resource,
                    Declaration::Blob(_) => SymKind::Blob,
                    Declaration::Cache(_) => SymKind::Cache,
                    Declaration::View(_) => SymKind::View,
                    Declaration::Projection(_) => SymKind::Projection,
                    Declaration::Function(_) => SymKind::Function,
                    Declaration::Channel(_) => SymKind::Channel,
                    Declaration::Source(_) => SymKind::Source,
                    Declaration::Actor(_) => SymKind::Actor,
                    Declaration::WorkQueue(_) => SymKind::WorkQueue,
                    Declaration::Workflow(_) => SymKind::Workflow,
                    Declaration::Purpose(_) => SymKind::Purpose,
                    Declaration::DataClass(_) => SymKind::DataClass,
                    Declaration::Import(i) => {
                        let Some(path) = i.path() else { continue };
                        let alias = i
                            .alias()
                            .map(|a| a.text().to_string())
                            .unwrap_or_else(|| path.text());
                        if !self.deps.contains_key(&path.text()) {
                            let known: Vec<&str> = self.deps.keys().map(|s| s.as_str()).collect();
                            self.err(
                                "E-IMP-001",
                                fi,
                                range_of(&path),
                                format!(
                                    "`{}` is not a declared dependency in forge.toml",
                                    path.text()
                                ),
                                suggest(&path.text(), known)
                                    .map(|s| format!("did you mean `{s}`?")),
                            );
                        }
                        self.imports
                            .entry(module.clone())
                            .or_default()
                            .insert(alias);
                        continue;
                    }
                    Declaration::Module(_) | Declaration::Subscription(_) => continue,
                };
                let Some(name_tok) = d.name() else { continue };
                let name = name_tok.text().to_string();
                if SCALARS.contains(&name.as_str()) {
                    self.err(
                        "E-SYM-004",
                        fi,
                        tok_range(&name_tok),
                        format!("`{name}` shadows a builtin type"),
                        None,
                    );
                    continue;
                }
                let key = (module.clone(), name.clone());
                if self.symbols.contains_key(&key) {
                    self.err(
                        "E-SYM-002",
                        fi,
                        tok_range(&name_tok),
                        format!("`{name}` is declared more than once in module `{module}`"),
                        None,
                    );
                    continue;
                }
                self.symbols.insert(
                    key,
                    Symbol {
                        kind,
                        exported: d.is_exported(),
                        file: fi,
                        decl: d,
                    },
                );
            }
        }
    }

    fn local_names(&self, module: &str) -> Vec<&str> {
        self.symbols
            .keys()
            .filter(|(m, _)| m == module)
            .map(|(_, n)| n.as_str())
            .collect()
    }
    fn sym(&self, module: &str, name: &str) -> Option<&Symbol> {
        self.symbols.get(&(module.to_string(), name.to_string()))
    }
    fn is_import(&self, module: &str, alias: &str) -> bool {
        self.imports.get(module).is_some_and(|s| s.contains(alias)) && self.deps.contains_key(alias)
    }

    // ------------------------------------------------------------ resolve
    /// Resolve a qualified name in type/value position.
    fn resolve(
        &mut self,
        segs: &[String],
        module: &str,
        file: usize,
        range: (usize, usize),
    ) -> Option<Resolved> {
        let resolved = self.resolve_inner(segs, module, file, range);
        let target = match &resolved {
            Some(Resolved::Function(id) | Resolved::Channel(id)) => Some(id.clone()),
            Some(Resolved::Transition { resource, action }) => {
                Some(format!("{resource}#lifecycle:status/transition:{action}"))
            }
            Some(Resolved::Type(ty)) => match ty {
                TypeBase::Enum { id } | TypeBase::Shape { id } => Some(id.clone()),
                TypeBase::Reference { resource }
                | TypeBase::Record { resource }
                | TypeBase::Identity { resource }
                | TypeBase::Status { resource } => Some(resource.clone()),
                TypeBase::Message { channel, message } => {
                    Some(format!("{channel}#message:{message}"))
                }
                _ => None,
            },
            None => None,
        };
        // Preserve the declared alias as the navigation target, even when it lowers to a scalar.
        let target = if let [name] = segs {
            self.sym(module, name)
                .filter(|s| s.kind == SymKind::Type)
                .map(|_| self.id(module, name))
                .or(target)
        } else {
            target
        };
        if let Some(target) = target {
            self.references.push(SourceReference {
                span: SourceSpan {
                    file: self.files[file].path.clone(),
                    start: range.0,
                    end: range.1,
                },
                target,
            });
        }
        resolved
    }

    fn resolve_inner(
        &mut self,
        segs: &[String],
        module: &str,
        file: usize,
        range: (usize, usize),
    ) -> Option<Resolved> {
        let text = segs.join(".");
        match segs {
            [a] => {
                if SCALARS.contains(&a.as_str()) {
                    return Some(Resolved::Type(TypeBase::Scalar {
                        name: a.clone(),
                        args: vec![],
                    }));
                }
                if let Some(s) = self.sym(module, a) {
                    let id = self.id(module, a);
                    return Some(match s.kind {
                        SymKind::Enum => Resolved::Type(TypeBase::Enum { id }),
                        SymKind::Shape => Resolved::Type(TypeBase::Shape { id }),
                        SymKind::Resource | SymKind::Blob => {
                            Resolved::Type(TypeBase::Reference { resource: id })
                        }
                        SymKind::Function => Resolved::Function(id),
                        SymKind::Channel => Resolved::Channel(id),
                        SymKind::Type => Resolved::Type(self.alias_base(module, a)),
                        SymKind::Facet
                        | SymKind::Source
                        | SymKind::Cache
                        | SymKind::View
                        | SymKind::Projection
                        | SymKind::Actor
                        | SymKind::WorkQueue
                        | SymKind::Workflow
                        | SymKind::Purpose
                        | SymKind::DataClass => {
                            self.err(
                                "E-SYM-005",
                                file,
                                range,
                                format!("`{a}` cannot be used as a type or dependency here"),
                                None,
                            );
                            return None;
                        }
                    });
                }
                let mut cands: Vec<&str> = SCALARS.to_vec();
                cands.extend(self.local_names(module));
                let sugg = suggest(a, cands).map(|s| format!("did you mean `{s}`?"));
                self.err(
                    "E-SYM-001",
                    file,
                    range,
                    format!("unknown name `{text}`"),
                    sugg,
                );
                None
            }
            [a, b] => {
                if let Some(s) = self.sym(module, a) {
                    let id = self.id(module, a);
                    match s.kind {
                        SymKind::Resource | SymKind::Blob => {
                            return match b.as_str() {
                                "Record" => Some(Resolved::Type(TypeBase::Record { resource: id })),
                                "Id" => Some(Resolved::Type(TypeBase::Identity { resource: id })),
                                "Status" => Some(Resolved::Type(TypeBase::Status { resource: id })),
                                _ => {
                                    self.err(
                                        "E-SYM-001",
                                        file,
                                        range,
                                        format!("unknown name `{text}`"),
                                        Some(
                                            "resources expose `.Record`, `.Id` and `.Status`"
                                                .into(),
                                        ),
                                    );
                                    None
                                }
                            };
                        }
                        SymKind::Channel => {
                            let Declaration::Channel(c) = s.decl.clone() else {
                                unreachable!()
                            };
                            let (contract, messages) = self.channel_contract(&c, module, file);
                            if messages.iter().any(|m| m == b) {
                                return Some(Resolved::Type(TypeBase::Message {
                                    channel: contract,
                                    message: b.clone(),
                                }));
                            }
                            let sugg = suggest(b, messages.iter().map(|s| s.as_str()))
                                .map(|s| format!("did you mean `{a}.{s}`?"));
                            self.err(
                                "E-SYM-001",
                                file,
                                range,
                                format!("channel `{a}` has no message `{b}`"),
                                sugg,
                            );
                            return None;
                        }
                        _ => {}
                    }
                }
                if self.is_import(module, a) {
                    return self.resolve_in_dep(a, &segs[1..], file, range);
                }
                let sugg =
                    suggest(a, self.local_names(module)).map(|s| format!("did you mean `{s}`?"));
                self.err(
                    "E-SYM-001",
                    file,
                    range,
                    format!("unknown name `{text}`"),
                    sugg,
                );
                None
            }
            [a, b, c] => {
                if let Some(s) = self.sym(module, a)
                    && s.kind == SymKind::Resource
                    && b == "status"
                {
                    let Declaration::Resource(r) = &s.decl else {
                        unreachable!()
                    };
                    let actions: Vec<String> = r
                        .lifecycle()
                        .map(|l| {
                            l.transitions()
                                .filter_map(|t| t.action().map(|a| a.text().to_string()))
                                .collect()
                        })
                        .unwrap_or_default();
                    if actions.iter().any(|x| x == c) {
                        return Some(Resolved::Transition {
                            resource: self.id(module, a),
                            action: c.clone(),
                        });
                    }
                    let sugg = suggest(c, actions.iter().map(|s| s.as_str()))
                        .map(|s| format!("did you mean `{a}.status.{s}`?"));
                    self.err(
                        "E-SYM-001",
                        file,
                        range,
                        format!("resource `{a}` has no lifecycle action `{c}`"),
                        sugg,
                    );
                    return None;
                }
                if self.is_import(module, a) {
                    return self.resolve_in_dep(a, &segs[1..], file, range);
                }
                self.err(
                    "E-SYM-001",
                    file,
                    range,
                    format!("unknown name `{text}`"),
                    None,
                );
                None
            }
            _ => {
                self.err(
                    "E-SYM-001",
                    file,
                    range,
                    format!("unknown name `{text}`"),
                    None,
                );
                None
            }
        }
    }

    fn alias_base(&self, module: &str, name: &str) -> TypeBase {
        self.alias_base_bounded(module, name, 0)
    }
    fn alias_base_bounded(&self, module: &str, name: &str, depth: usize) -> TypeBase {
        // The normal type expansion reports the cycle; base lookup must not overflow first.
        if depth >= 32 {
            return TypeBase::Scalar {
                name: "text".into(),
                args: vec![],
            };
        }
        // A type alias contributes its base; refinements are merged by the caller.
        if let Some(Symbol {
            decl: Declaration::Type(t),
            ..
        }) = self.sym(module, name)
            && let Some(te) = t.type_expr()
            && let Some(n) = te.type_ref().and_then(|r| r.name())
        {
            let segs = n.segments();
            if let [a] = segs.as_slice() {
                if SCALARS.contains(&a.as_str()) {
                    return TypeBase::Scalar {
                        name: a.clone(),
                        args: te.type_ref().map(|r| r.args()).unwrap_or_default(),
                    };
                }
                if let Some(s) = self.sym(module, a) {
                    let id = self.id(module, a);
                    return match s.kind {
                        SymKind::Enum => TypeBase::Enum { id },
                        SymKind::Shape => TypeBase::Shape { id },
                        SymKind::Resource | SymKind::Blob => TypeBase::Reference { resource: id },
                        SymKind::Type => self.alias_base_bounded(module, a, depth + 1),
                        _ => TypeBase::Scalar {
                            name: "text".into(),
                            args: vec![],
                        },
                    };
                }
            }
        }
        TypeBase::Scalar {
            name: "text".into(),
            args: vec![],
        }
    }

    fn resolve_in_dep(
        &mut self,
        alias: &str,
        rest: &[String],
        file: usize,
        range: (usize, usize),
    ) -> Option<Resolved> {
        let dep = self.deps[alias];
        let text = format!("{alias}.{}", rest.join("."));
        let name = &rest[0];
        let mut found_private = false;
        for m in &dep.modules {
            if let Some(e) = m.enums.iter().find(|e| &e.name == name) {
                if e.exported {
                    return Some(Resolved::Type(TypeBase::Enum { id: e.id.clone() }));
                } else {
                    found_private = true;
                }
            }
            if let Some(s) = m.shapes.iter().find(|e| &e.name == name) {
                if s.exported {
                    return Some(Resolved::Type(TypeBase::Shape { id: s.id.clone() }));
                } else {
                    found_private = true;
                }
            }
            if let Some(t) = m.types.iter().find(|e| &e.name == name) {
                if t.exported {
                    return Some(Resolved::Type(t.ty.base.clone()));
                } else {
                    found_private = true;
                }
            }
            if let Some(r) = m.resources.iter().find(|e| &e.name == name) {
                if r.exported {
                    return Some(match rest.get(1).map(|s| s.as_str()) {
                        None => Resolved::Type(TypeBase::Reference {
                            resource: r.id.clone(),
                        }),
                        Some("Record") => Resolved::Type(TypeBase::Record {
                            resource: r.id.clone(),
                        }),
                        Some("Id") => Resolved::Type(TypeBase::Identity {
                            resource: r.id.clone(),
                        }),
                        Some("Status") => Resolved::Type(TypeBase::Status {
                            resource: r.id.clone(),
                        }),
                        Some(_) => {
                            self.err(
                                "E-SYM-001",
                                file,
                                range,
                                format!("unknown name `{text}`"),
                                None,
                            );
                            return None;
                        }
                    });
                } else {
                    found_private = true;
                }
            }
            if let Some(f) = m.functions.iter().find(|e| &e.name == name) {
                if f.exported {
                    return Some(Resolved::Function(f.id.clone()));
                } else {
                    found_private = true;
                }
            }
            if let Some(c) = m.channels.iter().find(|e| &e.name == name) {
                if c.exported {
                    return Some(match rest.get(1) {
                        None => Resolved::Channel(c.id.clone()),
                        Some(msg) if c.messages.iter().any(|m| &m.name == msg) => {
                            Resolved::Type(TypeBase::Message {
                                channel: c.id.clone(),
                                message: msg.clone(),
                            })
                        }
                        Some(msg) => {
                            self.err(
                                "E-SYM-001",
                                file,
                                range,
                                format!("channel `{alias}.{name}` has no message `{msg}`"),
                                None,
                            );
                            return None;
                        }
                    });
                } else {
                    found_private = true;
                }
            }
        }
        if found_private {
            self.err(
                "E-SYM-003",
                file,
                range,
                format!(
                    "`{text}` exists in `{}` but is not exported",
                    dep.package.name
                ),
                Some("imports provide only exported contracts".into()),
            );
        } else {
            self.err(
                "E-SYM-001",
                file,
                range,
                format!(
                    "`{}` has no exported declaration named `{name}`",
                    dep.package.name
                ),
                None,
            );
        }
        None
    }

    /// (contract id, message names) for a local channel declaration.
    fn channel_contract(
        &mut self,
        c: &ast::ChannelDecl,
        module: &str,
        _file: usize,
    ) -> (String, Vec<String>) {
        let name = c.name().map(|t| t.text().to_string()).unwrap_or_default();
        if let Some(from) = c.from() {
            let segs = from.segments();
            if let [alias, up] = segs.as_slice()
                && self.is_import(module, alias)
            {
                let dep = self.deps[alias];
                if let Some(ch) = dep
                    .modules
                    .iter()
                    .flat_map(|m| m.channels.iter())
                    .find(|x| &x.name == up && x.exported)
                {
                    return (
                        ch.id.clone(),
                        ch.messages.iter().map(|m| m.name.clone()).collect(),
                    );
                }
            }
            return (self.id(module, &name), vec![]);
        }
        (
            self.id(module, &name),
            c.messages()
                .filter_map(|m| m.name().map(|t| t.text().to_string()))
                .collect(),
        )
    }

    // ------------------------------------------------------------ types
    fn type_spec(&mut self, te: &ast::TypeExpr, module: &str, file: usize) -> Option<TypeSpec> {
        if self.type_depth >= 32 {
            self.err(
                "E-COLLECTION-003",
                file,
                range_of(te),
                "type expansion exceeds the maximum depth or contains a recursive alias",
                None,
            );
            return None;
        }
        self.type_depth += 1;
        let result = self.type_spec_inner(te, module, file);
        self.type_depth -= 1;
        result
    }
    fn type_spec_inner(
        &mut self,
        te: &ast::TypeExpr,
        module: &str,
        file: usize,
    ) -> Option<TypeSpec> {
        let tr = te.type_ref()?;
        let name = tr.name()?;
        let segs = name.segments();
        let collection = segs.len() == 1 && matches!(segs[0].as_str(), "list" | "set" | "map");
        let res = if collection {
            let types = tr.element_types();
            let map = segs[0] == "map";
            if types.len() != if map { 2 } else { 1 } {
                self.err(
                    "E-COLLECTION-001",
                    file,
                    range_of(&tr),
                    "list/set require one element type; map requires text and a value type",
                    None,
                );
                return None;
            }
            if map && types[0].syntax().text().to_string().trim() != "text" {
                self.err(
                    "E-COLLECTION-001",
                    file,
                    range_of(&tr),
                    "map keys must be text",
                    None,
                );
                return None;
            }
            let element = self.type_spec(types.last().unwrap(), module, file)?;
            Resolved::Type(TypeBase::Collection {
                collection: match segs[0].as_str() {
                    "list" => CollectionKind::List,
                    "set" => CollectionKind::Set,
                    _ => CollectionKind::Map,
                },
                element: Box::new(element),
            })
        } else {
            self.resolve(&segs, module, file, range_of(&name))?
        };
        let Resolved::Type(mut base) = res else {
            self.err(
                "E-TYPE-001",
                file,
                range_of(&name),
                format!("`{}` is not a type", name.text()),
                None,
            );
            return None;
        };
        let args = tr.args();
        if let TypeBase::Scalar { args: a, .. } = &mut base {
            if !args.is_empty() {
                *a = args;
            }
        } else if !args.is_empty() && !collection {
            self.err(
                "E-TYPE-002",
                file,
                range_of(&tr),
                "only scalar types take arguments",
                None,
            );
        }
        // Inherit alias refinements.
        let (mut normalizers, mut constraints) = (Vec::new(), Vec::new());
        let mut inherited_data = None;
        if let [a] = segs.as_slice()
            && let Some(Symbol {
                decl: Declaration::Type(t),
                ..
            }) = self.sym(module, a)
            && let Some(inner) = t.type_expr()
        {
            let inner = inner.clone();
            if let Some(spec) = self.type_spec(&inner, module, file) {
                normalizers = spec.normalizers;
                constraints = spec.constraints;
                base = spec.base;
                inherited_data = spec.data_class;
            }
        }
        for r in te.refinements() {
            match r.kind() {
                Some(RefinementKind::Normalizer(n)) => normalizers.push(n),
                Some(RefinementKind::LengthRange { min, max }) => {
                    constraints.push(Constraint::Length {
                        min: Some(min),
                        max: Some(max),
                    })
                }
                Some(RefinementKind::LengthCompare { op, bound }) => {
                    constraints.push(match op.as_str() {
                        "<=" => Constraint::Length {
                            min: None,
                            max: Some(bound),
                        },
                        "<" => Constraint::Length {
                            min: None,
                            max: Some(bound.saturating_sub(1)),
                        },
                        ">=" => Constraint::Length {
                            min: Some(bound),
                            max: None,
                        },
                        ">" => Constraint::Length {
                            min: Some(bound + 1),
                            max: None,
                        },
                        "==" => Constraint::Length {
                            min: Some(bound),
                            max: Some(bound),
                        },
                        _ => {
                            self.err(
                                "E-TYPE-003",
                                file,
                                range_of(&r),
                                "`length !=` is not a supported constraint",
                                None,
                            );
                            continue;
                        }
                    })
                }
                Some(RefinementKind::Compare { op, literal }) => {
                    constraints.push(Constraint::Compare {
                        op,
                        value: literal_of(&literal),
                    })
                }
                Some(RefinementKind::Pattern(p)) => {
                    constraints.push(Constraint::Pattern { value: p })
                }
                None => self.err(
                    "E-TYPE-004",
                    file,
                    range_of(&r),
                    "unrecognized refinement",
                    None,
                ),
            }
        }
        if let TypeBase::Collection { element, .. } = &base {
            let upper = constraints
                .iter()
                .filter_map(|c| {
                    if let Constraint::Length { max, .. } = c {
                        *max
                    } else {
                        None
                    }
                })
                .min();
            let lower = constraints
                .iter()
                .filter_map(|c| {
                    if let Constraint::Length { min, .. } = c {
                        *min
                    } else {
                        None
                    }
                })
                .max()
                .unwrap_or(0);
            if upper.is_none_or(|n| n > 1024 || n < lower)
                || constraints
                    .iter()
                    .any(|c| !matches!(c, Constraint::Length { .. }))
                || !normalizers.is_empty()
            {
                self.err("E-COLLECTION-002",file,range_of(te),"collections require consistent length bounds with an upper bound at most 1024 and no scalar refinements",None);
            }
            let mut depth = 1;
            let mut nested = &element.base;
            while let TypeBase::Collection { element, .. } = nested {
                depth += 1;
                nested = &element.base;
            }
            if depth > 4 {
                self.err(
                    "E-COLLECTION-003",
                    file,
                    range_of(te),
                    "collection nesting exceeds the portable depth of four",
                    None,
                );
            }
        }
        if let [a] = segs.as_slice()
            && let Some(Symbol {
                decl: Declaration::Type(alias),
                ..
            }) = self.sym(module, a)
        {
            let alias = alias.clone();
            if let Some(d) = alias
                .decorators()
                .find(|d| d.name().is_some_and(|n| n.text() == "data"))
                && let Some(ArgValue::Name(path)) = d.args().first().and_then(|a| a.value())
            {
                inherited_data = self.resolve_data_class_or_path(&path, module, file, range_of(&d));
            }
        }
        Some(TypeSpec {
            base,
            optional: te.is_optional(),
            normalizers,
            constraints,
            purpose: None,
            data_class: inherited_data,
        })
    }

    // ------------------------------------------------------------ fields
    fn field(
        &mut self,
        fd: &ast::FieldDecl,
        module: &str,
        file: usize,
        scope: Option<&str>,
        allowed_decorators: &[&str],
    ) -> Option<Field> {
        let name_tok = fd.name()?;
        let name = name_tok.text().to_string();
        let mut immutable = false;
        let mut unique = false;
        let mut data_class: Option<String> = None;
        for d in fd.decorators() {
            let Some(dn) = d.name() else { continue };
            match dn.text() {
                "immutable" if allowed_decorators.contains(&"immutable") => immutable = true,
                "unique" if allowed_decorators.contains(&"unique") => unique = true,
                "data" if allowed_decorators.contains(&"data") => {
                    self.require_edition_2027(file, tok_range(&dn), "`@data`");
                    match d.args().first().and_then(|a| a.value()) {
                        Some(ArgValue::Name(segs)) => {
                            data_class =
                                self.resolve_data_class_or_path(&segs, module, file, range_of(&d))
                        }
                        _ => self.err(
                            "E-DEC-002",
                            file,
                            range_of(&d),
                            "`@data` requires a data class or taxonomy path",
                            None,
                        ),
                    }
                }
                "secret" if allowed_decorators.contains(&"secret") => {}
                "sequence" if allowed_decorators.contains(&"sequence") => {}
                "label" => {}
                other => {
                    let sugg = suggest(other, allowed_decorators.iter().copied())
                        .map(|s| format!("did you mean `@{s}`?"));
                    self.err(
                        "E-DEC-001",
                        file,
                        tok_range(&dn),
                        format!("unknown field decorator `@{other}`"),
                        sugg,
                    );
                }
            }
        }
        let _ = unique;
        if let Some(expr) = fd.derived() {
            if fd.decorators().next().is_some() {
                self.err(
                    "E-DEC-003",
                    file,
                    range_of(fd),
                    format!("derived field `{name}` cannot carry decorators"),
                    None,
                );
            }
            let ir = self.expr(&expr, module, file, scope);
            let ty = ir
                .as_ref()
                .and_then(|e| self.infer(e, module, scope))
                .unwrap_or(TypeSpec {
                    base: TypeBase::Scalar {
                        name: "json".into(),
                        args: vec![],
                    },
                    optional: false,
                    normalizers: vec![],
                    constraints: vec![],
                    purpose: None,
                    data_class: None,
                });
            return Some(Field {
                name,
                ty,
                default: None,
                derived: ir,
                sequence: None,
                secret: false,
                immutable: true,
                server_owned: true,
                synthesized: false,
                hidden: false,
                doc: fd.doc(),
            });
        }
        let te = fd.type_expr()?;
        let mut ty = self.type_spec(&te, module, file)?;
        // A field's own @data wins; otherwise the alias's classification flows through.
        if let Some(c) = data_class {
            ty.data_class = Some(c);
        } else if ty.data_class.is_none()
            && let Some(n) = te.type_ref().and_then(|r| r.name())
            && let [a] = n.segments().as_slice()
            && let Some(Symbol {
                decl: Declaration::Type(t),
                ..
            }) = self.sym(module, a)
        {
            let t = t.clone();
            if let Some(dec) = t
                .decorators()
                .find(|d| d.name().is_some_and(|n| n.text() == "data"))
                && let Some(ArgValue::Name(segs)) = dec.args().first().and_then(|a| a.value())
            {
                ty.data_class =
                    self.resolve_data_class_or_path(&segs, module, file, range_of(&dec));
            }
        }
        let default = match fd.default() {
            Some(e) => self.default_literal(&e, &ty, module, file),
            None => None,
        };
        Some(Field {
            name,
            ty,
            default,
            derived: None,
            sequence: None,
            secret: false,
            immutable,
            server_owned: false,
            synthesized: false,
            hidden: false,
            doc: fd.doc(),
        })
    }

    fn default_literal(
        &mut self,
        e: &ast::Expr,
        ty: &TypeSpec,
        module: &str,
        file: usize,
    ) -> Option<Literal> {
        match e {
            ast::Expr::Literal(l) => {
                let lit = literal_of(&l.text());
                if let (Literal::Null, false) = (&lit, ty.optional) {
                    self.err(
                        "E-TYPE-011",
                        file,
                        range_of(l),
                        "`null` default on a required field",
                        None,
                    );
                }
                Some(lit)
            }
            ast::Expr::Name(n) => {
                let segs = n.segments();
                if let ([en, member], TypeBase::Enum { id }) = (segs.as_slice(), &ty.base) {
                    let members: Vec<String> = self
                        .enum_members(id, module)
                        .into_iter()
                        .map(|m| m.name)
                        .collect();
                    if members.iter().any(|m| m == member) {
                        return Some(Literal::EnumMember {
                            r#enum: id.clone(),
                            member: member.clone(),
                        });
                    }
                    let sugg = suggest(member, members.iter().map(|s| s.as_str()))
                        .map(|s| format!("did you mean `{en}.{s}`?"));
                    self.err(
                        "E-TYPE-010",
                        file,
                        range_of(n),
                        format!("`{}` is not a member of enum `{en}`", segs.join(".")),
                        sugg,
                    );
                    return None;
                }
                self.err(
                    "E-TYPE-012",
                    file,
                    range_of(n),
                    "defaults must be literals or enum members",
                    None,
                );
                None
            }
            _ => {
                self.err(
                    "E-TYPE-012",
                    file,
                    expr_range(e),
                    "defaults must be literals or enum members",
                    None,
                );
                None
            }
        }
    }

    fn enum_members(&self, id: &str, module: &str) -> Vec<EnumMember> {
        let local_prefix = format!("{}/{}/", self.pkg.name, module);
        if let Some(name) = id.strip_prefix(&local_prefix)
            && let Some(Symbol {
                decl: Declaration::Enum(e),
                ..
            }) = self.sym(module, name)
        {
            return e
                .members()
                .filter_map(|m| {
                    Some(EnumMember {
                        name: m.name()?.text().to_string(),
                        value: m
                            .value()
                            .unwrap_or_else(|| m.name().unwrap().text().to_string()),
                        doc: m.doc(),
                    })
                })
                .collect();
        }
        for d in self.deps.values() {
            if let Some(e) = d.find_enum(id) {
                return e.members.clone();
            }
        }
        vec![]
    }

    // ------------------------------------------------------------ exprs
    fn expr(
        &mut self,
        e: &ast::Expr,
        module: &str,
        file: usize,
        scope: Option<&str>,
    ) -> Option<Expr> {
        Some(match e {
            ast::Expr::Binary(b) => Expr::Binary {
                op: b.op()?,
                lhs: Box::new(self.expr(&b.lhs()?, module, file, scope)?),
                rhs: Box::new(self.expr(&b.rhs()?, module, file, scope)?),
            },
            ast::Expr::Unary(u) => Expr::Unary {
                op: u.op()?,
                operand: Box::new(self.expr(&u.operand()?, module, file, scope)?),
            },
            ast::Expr::Paren(p) => self.expr(&p.inner()?, module, file, scope)?,
            ast::Expr::Literal(l) => Expr::Literal {
                literal: literal_of(&l.text()),
            },
            ast::Expr::Call(c) => {
                let callee = c.callee()?.segments();
                let mut args = Vec::new();
                for a in c.args() {
                    args.push(self.expr(&a, module, file, scope)?);
                }
                Expr::Call { callee, args }
            }
            ast::Expr::Name(n) => {
                let path = n.segments();
                if let Some(res) = scope {
                    self.check_path(&path, res, module, file, range_of(n))?;
                } else if path.len() == 2 {
                    // Enum member in a rule without scope.
                }
                Expr::Name { path }
            }
        })
    }

    fn is_purpose_scoped(&self, resource_id: &str, module: &str) -> bool {
        let local_prefix = format!("{}/{}/", self.pkg.name, module);
        if let Some(name) = resource_id.strip_prefix(&local_prefix)
            && let Some(Symbol {
                decl: Declaration::Resource(r),
                ..
            }) = self.sym(module, name)
        {
            return r
                .decorators()
                .any(|d| d.name().is_some_and(|n| n.text() == "purposeScoped"));
        }
        self.deps.values().any(|d| {
            d.find_resource(resource_id)
                .is_some_and(|r| r.decorators.purpose_scoped)
        })
    }

    fn require_edition_2027(&mut self, file: usize, range: (usize, usize), what: &str) {
        if self.pkg.edition != "2027" {
            self.err("E-ED-001", file, range, format!("{what} requires `edition = \"2027\"` in forge.toml (this package is edition {})", self.pkg.edition), Some("see specs/language/next-edition.md".into()));
        }
    }

    /// Purpose id for `Name` (local) or `alias.Name` (imported, exported only).
    fn resolve_purpose(
        &mut self,
        segs: &[String],
        module: &str,
        file: usize,
        range: (usize, usize),
    ) -> Option<String> {
        match segs {
            [a] => {
                if self
                    .sym(module, a)
                    .is_some_and(|s| s.kind == SymKind::Purpose)
                {
                    return Some(self.id(module, a));
                }
            }
            [a, b] if self.is_import(module, a) => {
                let dep = self.deps[a];
                if let Some(p) = dep
                    .modules
                    .iter()
                    .flat_map(|m| &m.purposes)
                    .find(|p| &p.name == b)
                {
                    if p.exported {
                        return Some(p.id.clone());
                    }
                    self.err(
                        "E-SYM-003",
                        file,
                        range,
                        format!(
                            "purpose `{}` exists in `{}` but is not exported",
                            b, dep.package.name
                        ),
                        None,
                    );
                    return None;
                }
            }
            _ => {}
        }
        let known: Vec<String> = self
            .symbols
            .iter()
            .filter(|((m, _), s)| m == module && s.kind == SymKind::Purpose)
            .map(|((_, n), _)| n.clone())
            .collect();
        let sugg = suggest(&segs.join("."), known.iter().map(|s| s.as_str()))
            .map(|s| format!("did you mean `{s}`?"));
        self.err(
            "E-GOV-003",
            file,
            range,
            format!("unknown purpose `{}`", segs.join(".")),
            sugg,
        );
        None
    }

    /// `@data(Class)` (declared) or `@data(data.a.b)` (taxonomy path).
    fn resolve_data_class_or_path(
        &mut self,
        segs: &[String],
        module: &str,
        file: usize,
        range: (usize, usize),
    ) -> Option<String> {
        if segs.first().map(|s| s.as_str()) == Some("data") {
            let id = segs.join(".");
            if Taxonomy::core().node(&id).is_none() {
                self.err(
                    "E-GOV-006",
                    file,
                    range,
                    format!("unknown taxonomy node `{id}`"),
                    None,
                );
                return None;
            }
            return Some(id);
        }
        self.resolve_data_class(segs, module, file, range)
    }

    fn resolve_data_class(
        &mut self,
        segs: &[String],
        module: &str,
        file: usize,
        range: (usize, usize),
    ) -> Option<String> {
        match segs {
            [a] if self
                .sym(module, a)
                .is_some_and(|s| s.kind == SymKind::DataClass) =>
            {
                return Some(self.id(module, a));
            }
            [a, b] if self.is_import(module, a) => {
                let dep = self.deps[a];
                if let Some(d) = dep
                    .modules
                    .iter()
                    .flat_map(|m| &m.data_classes)
                    .find(|d| &d.name == b && d.exported)
                {
                    return Some(d.id.clone());
                }
            }
            _ => {}
        }
        self.err(
            "E-GOV-006",
            file,
            range,
            format!("unknown data class `{}`", segs.join(".")),
            None,
        );
        None
    }

    /// Validate resource paths against the runtime's single-reference-hop profile.
    fn check_path(
        &mut self,
        path: &[String],
        resource_id: &str,
        module: &str,
        file: usize,
        range: (usize, usize),
    ) -> Option<()> {
        let mut current = resource_id.to_string();
        for (i, seg) in path.iter().enumerate() {
            let fields = self.resource_fields(&current, module);
            let Some(f) = fields.iter().find(|f| &f.name == seg) else {
                // `Enum.Member` is allowed as a value.
                if i == 0
                    && path.len() == 2
                    && self
                        .sym(module, seg)
                        .is_some_and(|s| s.kind == SymKind::Enum)
                {
                    return Some(());
                }
                // `Resource.Status.Member`: a lifecycle state literal.
                if i == 0
                    && path.len() == 3
                    && path[1] == "Status"
                    && self
                        .sym(module, seg)
                        .is_some_and(|s| s.kind == SymKind::Resource)
                    && let Some(Symbol {
                        decl: Declaration::Resource(rd),
                        ..
                    }) = self.sym(module, seg)
                {
                    let states: Vec<String> = rd
                        .lifecycle()
                        .map(|l| {
                            let mut v: Vec<String> = Vec::new();
                            for x in l
                                .initials()
                                .filter_map(|x| x.state())
                                .chain(l.terminals().filter_map(|x| x.state()))
                            {
                                v.push(x.text().to_string());
                            }
                            for t in l.transitions() {
                                for x in t.sources() {
                                    v.push(x.text().to_string());
                                }
                                if let Some(t2) = t.target() {
                                    v.push(t2.text().to_string());
                                }
                            }
                            v
                        })
                        .unwrap_or_default();
                    if states.iter().any(|x| x == &path[2]) {
                        return Some(());
                    }
                    let sugg = suggest(&path[2], states.iter().map(|s| s.as_str()))
                        .map(|s| format!("did you mean `{seg}.Status.{s}`?"));
                    self.err(
                        "E-SYM-001",
                        file,
                        range,
                        format!("`{}` is not a state of `{seg}`", path[2]),
                        sugg,
                    );
                    return None;
                }
                let sugg = suggest(seg, fields.iter().map(|f| f.name.as_str()))
                    .map(|s| format!("did you mean `{s}`?"));
                self.err(
                    "E-SYM-001",
                    file,
                    range,
                    format!("unknown field `{}` on `{}`", seg, short(&current)),
                    sugg,
                );
                return None;
            };
            if i + 1 < path.len() {
                match &f.ty.base {
                    TypeBase::Reference { resource } => {
                        if i > 0 {
                            self.err(
                                "E-EXPR-003",
                                file,
                                range,
                                "expressions support only one reference hop; bind a direct reference instead",
                                None,
                            );
                            return None;
                        }
                        current = resource.clone();
                    }
                    _ => {
                        self.err(
                            "E-EXPR-002",
                            file,
                            range,
                            format!(
                                "`{seg}` is not a reference; cannot access `{}`",
                                path[i + 1]
                            ),
                            None,
                        );
                        return None;
                    }
                }
            }
        }
        Some(())
    }

    /// Declared + synthesized fields of a resource, by id (local or imported).
    fn resource_fields(&mut self, id: &str, module: &str) -> Vec<Field> {
        let local_prefix = format!("{}/{}/", self.pkg.name, module);
        if let Some(name) = id.strip_prefix(&local_prefix) {
            let decl = match self.sym(module, name) {
                Some(Symbol {
                    decl: Declaration::Resource(r),
                    file,
                    ..
                }) => Some((r.clone(), *file, false)),
                Some(Symbol {
                    decl: Declaration::Blob(b),
                    file,
                    ..
                }) => Some((b.as_resource(), *file, true)),
                _ => None,
            };
            if let Some((r, file, is_blob)) = decl {
                let mut out = Vec::new();
                let saved = self.diags.len();
                let rid = self.id(module, name);
                // Derived fields infer their type through resource_fields of the same resource; the nested
                // call sees declared (non-derived) fields only, which bounds the recursion.
                let nested = self.resolving.contains(&rid);
                if !nested {
                    self.resolving.push(rid.clone());
                }
                for fd in r.fields() {
                    if nested && fd.derived().is_some() {
                        continue;
                    }
                    if let Some(f) =
                        self.field(&fd, module, file, Some(rid.as_str()), FIELD_DECORATORS)
                    {
                        out.push(f);
                    }
                }
                if !nested {
                    self.resolving.pop();
                }
                out.extend(self.applied_facets(&r, module, file));
                self.diags.truncate(saved); // reported by the owning pass, not here
                out.extend(self.synthesized_fields(
                    &self.decorators_of(&r),
                    r.lifecycle().is_some(),
                    &rid,
                ));
                if is_blob {
                    out.extend(blob_fields());
                }
                return out;
            }
        }
        for d in self.deps.values() {
            if let Some(r) = d.find_resource(id) {
                return r.fields.clone();
            }
        }
        vec![]
    }

    fn infer(&mut self, e: &Expr, module: &str, scope: Option<&str>) -> Option<TypeSpec> {
        let scalar = |n: &str| TypeSpec {
            base: TypeBase::Scalar {
                name: n.into(),
                args: vec![],
            },
            optional: false,
            normalizers: vec![],
            constraints: vec![],
            purpose: None,
            data_class: None,
        };
        Some(match e {
            Expr::Binary { op, lhs, .. } => match op.as_str() {
                "+" | "-" | "*" | "/" => self.infer(lhs, module, scope)?,
                _ => scalar("boolean"),
            },
            Expr::Unary { op, operand } => {
                if op == "!" {
                    scalar("boolean")
                } else {
                    self.infer(operand, module, scope)?
                }
            }
            Expr::Literal { literal } => match literal {
                Literal::Int(_) => scalar("integer"),
                Literal::Decimal(_) => scalar("decimal"),
                Literal::String(_) => scalar("text"),
                Literal::Bool(_) => scalar("boolean"),
                _ => scalar("json"),
            },
            Expr::Name { path } => {
                let res = scope?;
                let mut current = res.to_string();
                let mut ty = None;
                for (i, seg) in path.iter().enumerate() {
                    let fields = self.resource_fields(&current, module);
                    let f = fields.into_iter().find(|f| &f.name == seg)?;
                    if i + 1 < path.len()
                        && let TypeBase::Reference { resource } = &f.ty.base
                    {
                        current = resource.clone();
                    }
                    ty = Some(TypeSpec {
                        base: f.ty.base.clone(),
                        optional: f.ty.optional,
                        normalizers: vec![],
                        constraints: vec![],
                        purpose: None,
                        data_class: None,
                    });
                }
                ty?
            }
            Expr::Call { .. } => scalar("json"),
        })
    }

    /// Validate templates even when unused. Facets cannot supply derived fields or uniqueness.
    fn facet_fields(&mut self, facet: &ast::FacetDecl, module: &str, file: usize) -> Vec<Field> {
        let mut fields = Vec::new();
        let mut names = BTreeSet::new();
        for fd in facet.fields() {
            let name = fd.name().map(|n| n.text().to_string()).unwrap_or_default();
            if !names.insert(name.clone()) || name == "id" || fd.derived().is_some() {
                self.err("E-FACET-002", file, range_of(&fd), format!("facet field `{name}` must be a distinct declared non-identity field; derived fields are not supported"), None);
                continue;
            }
            if let Some(field) =
                self.field(&fd, module, file, None, &["immutable", "label", "data"])
            {
                fields.push(field);
            }
        }
        fields.sort_by(|a, b| a.name.cmp(&b.name));
        fields
    }

    fn applied_facets(
        &mut self,
        resource: &ast::ResourceDecl,
        module: &str,
        file: usize,
    ) -> Vec<Field> {
        let mut out = Vec::new();
        let mut seen = BTreeSet::new();
        for dec in resource
            .decorators()
            .filter(|d| d.name().is_some_and(|n| n.text() == "facet"))
        {
            self.require_edition_2027(file, range_of(&dec), "`@facet`");
            if dec.args().is_empty() {
                self.err(
                    "E-FACET-001",
                    file,
                    range_of(&dec),
                    "@facet requires at least one facet name",
                    None,
                );
            }
            for arg in dec.args() {
                let Some(ArgValue::Name(parts)) = arg.value().filter(|_| arg.label().is_none())
                else {
                    self.err(
                        "E-FACET-001",
                        file,
                        range_of(&arg),
                        "@facet expects positional facet names",
                        None,
                    );
                    continue;
                };
                let resolved = match parts.as_slice() {
                    [name] => match self.sym(module, name) {
                        Some(Symbol {
                            decl: Declaration::Facet(facet),
                            file: origin,
                            ..
                        }) => {
                            let facet = facet.clone();
                            let origin = *origin;
                            Some((
                                self.id(module, name),
                                self.facet_fields(&facet, module, origin),
                            ))
                        }
                        _ => None,
                    },
                    [alias, rest @ ..]
                        if self
                            .imports
                            .get(module)
                            .is_some_and(|imports| imports.contains(alias)) =>
                    {
                        self.deps.get(alias).and_then(|dep| {
                            dep.modules.iter().find_map(|m| {
                                let name = match rest {
                                    [n] if m.id == "_" => n,
                                    [mo, n] if mo == &m.id => n,
                                    _ => return None,
                                };
                                m.facets
                                    .iter()
                                    .find(|f| f.name == *name && f.exported)
                                    .map(|f| (f.id.clone(), f.fields.clone()))
                            })
                        })
                    }
                    _ => None,
                };
                let Some((facet_id, fields)) = resolved else {
                    self.err(
                        "E-FACET-001",
                        file,
                        range_of(&arg),
                        format!("`{}` is not a visible facet", parts.join(".")),
                        None,
                    );
                    continue;
                };
                let (start, end) = range_of(&arg);
                self.references.push(SourceReference {
                    span: SourceSpan {
                        file: self.files[file].path.clone(),
                        start,
                        end,
                    },
                    target: facet_id.clone(),
                });
                if !seen.insert(facet_id.clone()) {
                    self.err(
                        "E-FACET-003",
                        file,
                        range_of(&arg),
                        format!("facet `{facet_id}` is applied more than once"),
                        None,
                    );
                    continue;
                }
                let resource_id = self.id(module, resource.name().unwrap().text());
                for field in fields {
                    self.facet_origins.insert(
                        format!("{resource_id}#field:{}", field.name),
                        format!("{facet_id}#field:{}", field.name),
                    );
                    out.push(field);
                }
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    // ------------------------------------------------------------ resources
    fn decorators_of(&self, r: &ast::ResourceDecl) -> ResourceDecorators {
        let mut d = ResourceDecorators::default();
        for dec in r.decorators() {
            let Some(n) = dec.name() else { continue };
            match n.text() {
                "tenant" => d.tenant = true,
                "timestamps" => d.timestamps = true,
                "softDelete" => d.soft_delete = true,
                "appendOnly" => d.append_only = true,
                "writeOnce" => d.write_once = true,
                "versioned" => d.versioned = true,
                "audited" => d.audited = true,
                "hierarchical" => d.hierarchical = true,
                "purposeScoped" => d.purpose_scoped = true,
                "subject" => {
                    let args = dec.args();
                    let arg = args.first();
                    d.subject = match (arg.and_then(|a| a.label()), arg.and_then(|a| a.value())) {
                        (Some(l), Some(ArgValue::Name(n))) if l == "from" => n
                            .first()
                            .cloned()
                            .map(|f| SubjectBinding::From { field: f }),
                        (None, Some(ArgValue::Name(n))) => {
                            n.first().cloned().map(|k| SubjectBinding::Kind { kind: k })
                        }
                        _ => None,
                    };
                }
                "record" => {
                    d.record_context = dec.args().first().and_then(|a| a.value()).and_then(|v| {
                        if let ArgValue::Name(n) = v {
                            n.first().cloned()
                        } else {
                            None
                        }
                    });
                }
                "crud" => {
                    let args = dec.args();
                    if let Some(ArgValue::Literal(p)) = args.first().and_then(|a| a.value()) {
                        let names = |label: &str| {
                            args.iter()
                                .find(|a| a.label().as_deref() == Some(label))
                                .and_then(|a| a.value())
                                .and_then(|v| {
                                    if let ArgValue::List(l) = v {
                                        Some(
                                            l.into_iter()
                                                .filter_map(|x| {
                                                    if let ArgValue::Name(n) = x {
                                                        n.first().cloned()
                                                    } else {
                                                        None
                                                    }
                                                })
                                                .collect::<Vec<String>>(),
                                        )
                                    } else {
                                        None
                                    }
                                })
                        };
                        d.crud = Some(CrudBinding {
                            path: unq(&p),
                            operations: names("operations"),
                            actions: names("actions").unwrap_or_default(),
                        });
                    }
                }
                "effectiveDated" => {
                    let by = dec
                        .args()
                        .iter()
                        .find(|a| a.label().as_deref() == Some("uniqueBy"))
                        .and_then(|a| a.value())
                        .and_then(|v| {
                            if let ArgValue::List(l) = v {
                                Some(
                                    l.into_iter()
                                        .filter_map(|x| {
                                            if let ArgValue::Name(n) = x {
                                                n.first().cloned()
                                            } else {
                                                None
                                            }
                                        })
                                        .collect(),
                                )
                            } else {
                                None
                            }
                        })
                        .unwrap_or_default();
                    d.effective_dated = Some(EffectiveDated { unique_by: by });
                }
                "label" => {
                    if let Some(ArgValue::Literal(p)) = dec.args().first().and_then(|a| a.value()) {
                        d.label = Some(unq(&p));
                    }
                }
                _ => {}
            }
        }
        d
    }

    fn synthesized_fields(
        &self,
        d: &ResourceDecorators,
        has_lifecycle: bool,
        resource_id: &str,
    ) -> Vec<Field> {
        let scalar = |n: &str, optional: bool| TypeSpec {
            base: TypeBase::Scalar {
                name: n.into(),
                args: vec![],
            },
            optional,
            normalizers: vec![],
            constraints: vec![],
            purpose: None,
            data_class: None,
        };
        let mk = |name: &str, ty: TypeSpec| Field {
            name: name.into(),
            ty,
            default: None,
            derived: None,
            sequence: None,
            secret: false,
            immutable: false,
            server_owned: true,
            synthesized: true,
            hidden: false,
            doc: None,
        };
        let mut out = Vec::new();
        if d.versioned {
            out.push(mk("version", scalar("integer", false)));
        }
        if d.timestamps {
            out.push(mk("createdAt", scalar("datetime", false)));
            out.push(mk("updatedAt", scalar("datetime", false)));
        }
        if d.soft_delete {
            out.push(mk("deletedAt", scalar("datetime", true)));
        }
        if has_lifecycle {
            out.push(mk(
                "status",
                TypeSpec {
                    base: TypeBase::Status {
                        resource: resource_id.into(),
                    },
                    optional: false,
                    normalizers: vec![],
                    constraints: vec![],
                    purpose: None,
                    data_class: None,
                },
            ));
        }
        if d.effective_dated.is_some() {
            // Authored by the caller (§18): required start, optional end; validated and guarded at commit.
            out.push(Field {
                name: "effectiveFrom".into(),
                ty: scalar("datetime", false),
                default: None,
                derived: None,
                sequence: None,
                secret: false,
                immutable: false,
                server_owned: false,
                synthesized: true,
                hidden: false,
                doc: None,
            });
            out.push(Field {
                name: "effectiveUntil".into(),
                ty: scalar("datetime", true),
                default: None,
                derived: None,
                sequence: None,
                secret: false,
                immutable: false,
                server_owned: false,
                synthesized: true,
                hidden: false,
                doc: None,
            });
        }
        if d.hierarchical {
            out.push(Field {
                name: "parent".into(),
                ty: TypeSpec {
                    base: TypeBase::Reference {
                        resource: resource_id.into(),
                    },
                    optional: true,
                    normalizers: vec![],
                    constraints: vec![],
                    purpose: None,
                    data_class: None,
                },
                default: None,
                derived: None,
                sequence: None,
                secret: false,
                immutable: false,
                server_owned: false,
                synthesized: true,
                hidden: false,
                doc: None,
            });
        }
        out
    }

    fn resource(
        &mut self,
        r: &ast::ResourceDecl,
        module: &str,
        file: usize,
        exported: bool,
        enums_out: &mut Vec<EnumDecl>,
        blob: Option<&ast::BlobDecl>,
    ) -> Option<Resource> {
        let name = r.name()?.text().to_string();
        let id = self.id(module, &name);
        let content = match blob {
            Some(b) => Some(self.content_policy(b, file)?),
            None => None,
        };

        // decorators
        for dec in r.decorators() {
            let Some(n) = dec.name() else { continue };
            if !RESOURCE_DECORATORS.contains(&n.text()) {
                let sugg = suggest(n.text(), RESOURCE_DECORATORS.iter().copied())
                    .map(|s| format!("did you mean `@{s}`?"));
                self.err(
                    "E-DEC-001",
                    file,
                    tok_range(&n),
                    format!("unknown resource decorator `@{}`", n.text()),
                    sugg,
                );
            } else if n.text() == "crud"
                && !matches!(
                    dec.args().first().and_then(|a| a.value()),
                    Some(ArgValue::Literal(_))
                )
            {
                self.err(
                    "E-DEC-002",
                    file,
                    range_of(&dec),
                    "`@crud` requires a route path, e.g. `@crud(\"/v1/customers\")`",
                    None,
                );
            } else if n.text() == "effectiveDated"
                && !dec
                    .args()
                    .iter()
                    .any(|a| a.label().as_deref() == Some("uniqueBy"))
            {
                self.err(
                    "E-DEC-002",
                    file,
                    range_of(&dec),
                    "`@effectiveDated` requires `uniqueBy: [..]`",
                    None,
                );
            }
        }
        let decorators = self.decorators_of(r);

        // fields
        let mut fields: Vec<Field> = Vec::new();
        let mut declared_names: BTreeSet<String> = BTreeSet::new();
        let mut unique_fields: Vec<String> = Vec::new();
        for fd in r.fields() {
            let Some(nt) = fd.name() else { continue };
            if !declared_names.insert(nt.text().to_string()) {
                self.err(
                    "E-RES-003",
                    file,
                    tok_range(&nt),
                    format!("field `{}` is declared twice", nt.text()),
                    None,
                );
                continue;
            }
            if fd
                .decorators()
                .any(|d| d.name().is_some_and(|n| n.text() == "unique"))
            {
                unique_fields.push(nt.text().to_string());
            }
            if let Some(f) = self.field(&fd, module, file, Some(&id), FIELD_DECORATORS) {
                fields.push(f);
            }
        }
        for fd in r.fields() {
            for decorator in fd
                .decorators()
                .filter(|d| d.name().is_some_and(|n| n.text() == "sequence"))
            {
                let field_name = fd.name()?.text().to_string();
                let mut sequence = Sequence {
                    partition: None,
                    start: 1,
                    max: 9_007_199_254_740_991,
                };
                let mut labels = BTreeSet::new();
                for arg in decorator.args() {
                    let label = arg.label().unwrap_or_default();
                    if !labels.insert(label.clone()) {
                        self.err(
                            "E-SEQ-001",
                            file,
                            range_of(&decorator),
                            "duplicate sequence argument",
                            None,
                        );
                    }
                    match (label.as_str(), arg.value()) {
                        ("partition", Some(ArgValue::Name(names))) if names.len() == 1 => {
                            sequence.partition = Some(names[0].clone())
                        }
                        ("start" | "max", Some(ArgValue::Literal(value))) => {
                            if let Ok(n) = value.parse::<u64>() {
                                if label == "start" {
                                    sequence.start = n;
                                } else {
                                    sequence.max = n;
                                }
                            } else {
                                self.err(
                                    "E-SEQ-001",
                                    file,
                                    range_of(&decorator),
                                    "sequence bounds must be positive safe integers",
                                    None,
                                );
                            }
                        }
                        _ => self.err(
                            "E-SEQ-001",
                            file,
                            range_of(&decorator),
                            "expected partition: field, start: integer or max: integer",
                            None,
                        ),
                    }
                }
                if sequence.start == 0
                    || sequence.start > sequence.max
                    || sequence.max > 9_007_199_254_740_991
                {
                    self.err(
                        "E-SEQ-001",
                        file,
                        range_of(&decorator),
                        "sequence bounds must satisfy 1 <= start <= max <= 9007199254740991",
                        None,
                    );
                }
                if let Some(partition) = &sequence.partition {
                    match fields.iter_mut().find(|f| &f.name==partition && f.name!=field_name) {
                        Some(f) if !f.ty.optional && !f.server_owned && f.derived.is_none() && (matches!(&f.ty.base, TypeBase::Reference {..} | TypeBase::Enum {..}) || matches!(&f.ty.base, TypeBase::Scalar {name,..} if name == "text" || name == "id")) => { f.immutable=true; }
                        _ => self.err("E-SEQ-002",file,range_of(&decorator),"sequence partition must be a required text/id field distinct from the allocated field",None),
                    }
                }
                if let Some(f) = fields.iter_mut().find(|f| f.name == field_name) {
                    if f.sequence.is_some()
                        || f.ty.optional
                        || f.default.is_some()
                        || f.derived.is_some()
                        || !matches!(&f.ty.base,TypeBase::Scalar {name,..} if name=="integer")
                        || !f.ty.constraints.is_empty()
                    {
                        self.err("E-SEQ-003",file,range_of(&decorator),"sequence requires a plain required integer field without a default, derivation or second sequence",None);
                    }
                    f.sequence = Some(sequence);
                    f.immutable = true;
                    f.server_owned = true;
                }
            }
        }
        for fd in r.fields() {
            if let Some(secret) = fd
                .decorators()
                .find(|d| d.name().is_some_and(|n| n.text() == "secret"))
            {
                let field_name = fd.name()?.text().to_string();
                if !secret.args().is_empty()
                    || declared_names.contains(&format!("{field_name}Present"))
                    || !decorators.versioned
                {
                    self.err("E-SECRET-001",file,range_of(&secret),"@secret requires a versioned resource, no arguments and an unused <field>Present name",None);
                }
                if let Some(field) = fields.iter_mut().find(|f| f.name == field_name) {
                    if field.name == "id"
                        || field.default.is_some()
                        || field.derived.is_some()
                        || field.sequence.is_some()
                        || !field.ty.normalizers.is_empty()
                        || !matches!(&field.ty.base,TypeBase::Scalar {name,..} if name=="text")
                    {
                        self.err("E-SECRET-001",file,range_of(&secret),"@secret requires a text field without a default, derivation or sequence",None);
                    }
                    field.secret = true;
                    field.hidden = true;
                }
            }
        }
        for f in self.applied_facets(r, module, file) {
            if !declared_names.insert(f.name.clone()) {
                self.err("E-FACET-003", file, range_of(r), format!("facet field `{}` collides with another field on `{name}`; overrides are not allowed", f.name), None);
            } else {
                fields.push(f);
            }
        }
        if blob.is_some() && !declared_names.contains("id") {
            // Blobs synthesize their id.
            fields.insert(
                0,
                Field {
                    name: "id".into(),
                    ty: TypeSpec {
                        base: TypeBase::Scalar {
                            name: "id".into(),
                            args: vec![],
                        },
                        optional: false,
                        normalizers: vec![],
                        constraints: vec![],
                        purpose: None,
                        data_class: None,
                    },
                    default: None,
                    derived: None,
                    sequence: None,
                    secret: false,
                    immutable: true,
                    server_owned: true,
                    synthesized: true,
                    hidden: false,
                    doc: None,
                },
            );
            declared_names.insert("id".into());
        }
        if !declared_names.contains("id") {
            self.err(
                "E-RES-002",
                file,
                range_of(r),
                format!("resource `{name}` must declare `id : id`"),
                None,
            );
        } else if let Some(f) = fields.iter_mut().find(|f| f.name == "id") {
            f.server_owned = true;
            f.immutable = true;
            if !matches!(&f.ty.base, TypeBase::Scalar { name, .. } if name == "id") {
                self.err(
                    "E-RES-004",
                    file,
                    range_of(r),
                    "`id` must have type `id`",
                    None,
                );
            }
        }
        let mut decorators = decorators;
        if blob.is_some() {
            decorators.timestamps = true;
            decorators.versioned = true;
        }
        let mut synthesized = self.synthesized_fields(&decorators, r.lifecycle().is_some(), &id);
        if blob.is_some() {
            synthesized.extend(blob_fields());
        }
        for s in &synthesized {
            if declared_names.contains(&s.name) {
                let span = r
                    .fields()
                    .find_map(|f| f.name().filter(|t| t.text() == s.name))
                    .map(|t| tok_range(&t))
                    .unwrap_or_else(|| range_of(r));
                self.err("E-RES-001", file, span, format!("field `{}` collides with a field synthesized by the resource's decorators or lifecycle", s.name), None);
            }
        }
        fields.extend(synthesized);
        let field_names: Vec<String> = fields.iter().map(|f| f.name.clone()).collect();

        // lifecycle
        let lifecycle = r
            .lifecycle()
            .and_then(|l| self.lifecycle(&l, module, file, &id, exported, enums_out));

        if decorators.write_once
            && (blob.is_none()
                || decorators.soft_delete
                || decorators.hierarchical
                || lifecycle.is_some())
        {
            self.err(
                "E-SEAL-001",
                file,
                range_of(r),
                "@writeOnce requires a blob without soft deletion, hierarchy or lifecycle",
                None,
            );
        }
        if decorators.append_only {
            if decorators.soft_delete
                || decorators.hierarchical
                || lifecycle.is_some()
                || blob.is_some()
            {
                self.err("E-APPEND-001", file, range_of(r), "@appendOnly cannot combine with soft deletion, hierarchy, lifecycle or blob mutation", None);
            }
            for field in &mut fields {
                field.immutable = true;
            }
        }

        // uniques
        let mut uniques: Vec<Unique> = unique_fields
            .iter()
            .map(|f| Unique {
                name: f.clone(),
                condition: None,
                fields: vec![f.clone()],
                within: vec![],
            })
            .collect();
        for u in r.uniques() {
            let (fs, within) = (u.fields(), u.within());
            for f in fs.iter().chain(within.iter()) {
                if !field_names.contains(f) {
                    self.err(
                        "E-QRY-002",
                        file,
                        range_of(&u),
                        format!("unknown field `{f}` in unique constraint"),
                        suggest(f, field_names.iter().map(|s| s.as_str()))
                            .map(|s| format!("did you mean `{s}`?")),
                    );
                }
            }
            let mut n = fs.join("_");
            if !within.is_empty() {
                n.push_str("_within_");
                n.push_str(&within.join("_"));
            }
            let condition = u.condition().map(|(predicate, values)| {
                if !decorators.versioned {
                    self.err("E-EXCLUSIVE-005",file,range_of(&u),"conditional uniqueness requires @versioned so stale updates cannot release another commit's claim",None);
                }
                let known = match fields.iter().find(|f| f.name == predicate).map(|f| &f.ty.base) {
                    Some(TypeBase::Enum {id}) => self.enum_members(id,module).into_iter().map(|m|(m.name,m.value)).collect::<BTreeMap<_,_>>(),
                    Some(TypeBase::Status { .. }) => lifecycle.as_ref().map(|l| l.states.iter().map(|s|(s.clone(),s.clone())).collect()).unwrap_or_default(),
                    _ => { self.err("E-EXCLUSIVE-001",file,range_of(&u),"conditional uniqueness requires an enum or lifecycle status field",None); BTreeMap::new() },
                };
                let mut wire_values = Vec::new();
                for value in values {
                    if let Some(wire) = known.get(&value) {wire_values.push(wire.clone());}
                    else {self.err("E-EXCLUSIVE-002",file,range_of(&u),format!("unknown conditional uniqueness member `{value}`"),None);}
                }
                for key in fs.iter().chain(within.iter()) {
                    if fields.iter().find(|f| &f.name == key).is_some_and(|f| f.ty.optional || matches!(f.ty.base,TypeBase::Shape {..}|TypeBase::Record {..}|TypeBase::Message {..}|TypeBase::Collection {..})) {
                        self.err("E-EXCLUSIVE-003",file,range_of(&u),"conditional uniqueness keys must be required scalar, enum or identity fields",None);
                    }
                }
                wire_values.sort(); wire_values.dedup();
                UniqueCondition {field:predicate,values:wire_values}
            });
            if let Some(predicate) = &condition {
                n.push_str("_when_");
                n.push_str(&hash_hex(&serde_json::to_string(predicate).unwrap())[..12]);
            }
            uniques.push(Unique {
                condition,
                name: n,
                fields: fs,
                within,
            });
        }
        uniques.sort_by(|a, b| a.name.cmp(&b.name));
        for pair in uniques.windows(2) {
            if pair[0].name == pair[1].name {
                self.err(
                    "E-EXCLUSIVE-004",
                    file,
                    range_of(r),
                    format!(
                        "duplicate uniqueness key `{}`; combine its conditions in one declaration",
                        pair[0].name
                    ),
                    None,
                );
            }
        }

        // finds
        let mut finds = Vec::new();
        for fd in r.finds() {
            let Some(fl) = fd.fields() else { continue };
            let fs = fl.names();
            let mut ok = true;
            for (f, t) in fs.iter().zip(fl.name_tokens()) {
                if !field_names.contains(f) {
                    ok = false;
                    self.err(
                        "E-QRY-002",
                        file,
                        tok_range(&t),
                        format!("unknown field `{f}` in `find by`"),
                        suggest(f, field_names.iter().map(|s| s.as_str()))
                            .map(|s| format!("did you mean `{s}`?")),
                    );
                }
            }
            if !ok {
                continue;
            }
            let set: BTreeSet<&String> = fs.iter().collect();
            match uniques.iter().find(|u| u.condition.is_none() && u.fields.iter().chain(u.within.iter()).collect::<BTreeSet<_>>() == set) {
                Some(u) => finds.push(Find { name: camel(&fs), fields: fs.clone(), covered_by: u.name.clone() }),
                None => self.err("E-QRY-001", file, range_of(&fd), format!("`find by {}` is not covered by a unique constraint, so it cannot return zero-or-one", fs.join(", ")), Some(format!("declare `unique {}` or use `list by`", fs.join(", ")))),
            }
        }
        finds.sort_by(|a, b| a.name.cmp(&b.name));

        // lists
        let mut lists = Vec::new();
        for ld in r.lists() {
            let Some(fl) = ld.fields() else { continue };
            let fs = fl.names();
            for (f, t) in fs.iter().zip(fl.name_tokens()) {
                if !field_names.contains(f) {
                    self.err(
                        "E-QRY-002",
                        file,
                        tok_range(&t),
                        format!("unknown field `{f}` in `list by`"),
                        suggest(f, field_names.iter().map(|s| s.as_str()))
                            .map(|s| format!("did you mean `{s}`?")),
                    );
                }
            }
            let mut order: Vec<OrderKey> = ld
                .order()
                .into_iter()
                .map(|(field, direction)| OrderKey { field, direction })
                .collect();
            for o in &order {
                if !field_names.contains(&o.field) {
                    self.err(
                        "E-QRY-002",
                        file,
                        range_of(&ld),
                        format!("unknown field `{}` in `order by`", o.field),
                        suggest(&o.field, field_names.iter().map(|s| s.as_str()))
                            .map(|s| format!("did you mean `{s}`?")),
                    );
                }
            }
            if !order.iter().any(|o| o.field == "id") {
                // Deterministic tie-breaker. Its direction follows the declared keys so a
                // key-value store can serve the page with one reversed range scan.
                let dir = order
                    .last()
                    .map(|o| o.direction.clone())
                    .unwrap_or_else(|| "asc".into());
                order.push(OrderKey {
                    field: "id".into(),
                    direction: dir,
                });
            }
            let search_mode = ld.search_mode();
            if let Some(mode) = &search_mode {
                if mode != "exact" {
                    self.err("E-SEARCH-001",file,range_of(&ld),"this profile supports only indexed exact search; prefix/tokenized/ranked modes need a certified provider plan",None);
                }
                if !fs.iter().any(|name| {
                    fields.iter().any(|f| {
                        &f.name == name
                            && !f.ty.optional
                            && matches!(&f.ty.base,TypeBase::Scalar {name,..} if name=="text")
                    })
                }) {
                    self.err(
                        "E-SEARCH-002",
                        file,
                        range_of(&ld),
                        "exact search requires a nonoptional text search field",
                        None,
                    );
                }
            }
            lists.push(List {
                name: if search_mode.is_some() {
                    format!("search_{}", camel(&fs))
                } else {
                    camel(&fs)
                },
                search_mode,
                fields: fs,
                order,
            });
        }
        // Every resource has a bounded default browse: tenant-scoped, paged, ordered by id.
        lists.push(List {
            search_mode: None,
            name: "all".into(),
            fields: vec![],
            order: vec![OrderKey {
                field: "id".into(),
                direction: "asc".into(),
            }],
        });
        lists.sort_by(|a, b| a.name.cmp(&b.name));

        // rules
        let mut rules = Vec::new();
        if let Some(rb) = r.rules() {
            for rule in rb.rules() {
                let Some(e) = rule.expr() else { continue };
                if let Some(ir) = self.expr(&e, module, file, Some(&id)) {
                    if !matches!(&ir, Expr::Binary { op, .. } if matches!(op.as_str(), "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||"))
                        && !matches!(&ir, Expr::Unary { op, .. } if op == "!")
                    {
                        self.err(
                            "E-EXPR-001",
                            file,
                            range_of(&rule),
                            "a rule must be a boolean expression",
                            None,
                        );
                    }
                    rules.push(ir);
                }
            }
        }

        // operations
        let mut operations = Vec::new();
        let crud = decorators.crud.clone();
        let allowed = |op: &str| {
            crud.as_ref()
                .and_then(|c| c.operations.as_ref())
                .is_none_or(|ops| ops.iter().any(|o| o == op))
        };
        let http = |method: &str, suffix: &str| {
            crud.as_ref().map(|c| HttpBinding {
                method: method.into(),
                path: format!("{}{}", c.path, suffix),
            })
        };
        let mut push = |kind: &str,
                        query: Option<String>,
                        action: Option<String>,
                        http: Option<HttpBinding>| {
            let op = match (kind, &query, &action) {
                (_, Some(q), _) => format!("{kind}.{q}"),
                (_, _, Some(a)) => format!("status.{a}"),
                _ => kind.to_string(),
            };
            operations.push(Operation {
                id: format!("{id}.{op}"),
                kind: kind.into(),
                query,
                action,
                http,
            });
        };
        push(
            "create",
            None,
            None,
            if allowed("create") {
                http("POST", "")
            } else {
                None
            },
        );
        push(
            "get",
            None,
            None,
            if allowed("get") {
                http("GET", "/{id}")
            } else {
                None
            },
        );
        push(
            "update",
            None,
            None,
            if allowed("update") {
                http("PATCH", "/{id}")
            } else {
                None
            },
        );
        push(
            "delete",
            None,
            None,
            if allowed("delete") {
                http("DELETE", "/{id}")
            } else {
                None
            },
        );
        if decorators.soft_delete {
            push(
                "restore",
                None,
                None,
                if allowed("restore") {
                    http("POST", "/{id}/restore")
                } else {
                    None
                },
            );
        }
        for f in &finds {
            push(
                "find",
                Some(f.name.clone()),
                None,
                if allowed("find") {
                    http("GET", &format!("/queries/{}", kebab(&f.fields)))
                } else {
                    None
                },
            );
        }
        for l in &lists {
            let path = if l.search_mode.is_some() {
                format!("/search/{}", kebab(&l.fields))
            } else if l.fields.is_empty() {
                String::new()
            } else {
                format!("/queries/{}", kebab(&l.fields))
            };
            push(
                "list",
                Some(l.name.clone()),
                None,
                if allowed("list") {
                    http("GET", &path)
                } else {
                    None
                },
            );
        }
        if let Some(ed) = &decorators.effective_dated {
            for f in &ed.unique_by {
                if !field_names.contains(f) {
                    self.err(
                        "E-QRY-002",
                        file,
                        range_of(r),
                        format!("unknown field `{f}` in `@effectiveDated(uniqueBy)`"),
                        suggest(f, field_names.iter().map(|s| s.as_str()))
                            .map(|s| format!("did you mean `{s}`?")),
                    );
                }
            }
            // `effective(<uniqueBy>, at)` returns zero-or-one by contract (§18)
            push(
                "effective",
                Some(camel(&ed.unique_by)),
                None,
                if allowed("effective") {
                    http("GET", &format!("/effective/{}", kebab(&ed.unique_by)))
                } else {
                    None
                },
            );
        }
        if decorators.hierarchical {
            push(
                "move",
                None,
                None,
                if allowed("move") {
                    http("POST", "/{id}/move")
                } else {
                    None
                },
            );
            push(
                "children",
                None,
                None,
                if allowed("children") {
                    http("GET", "/{id}/children")
                } else {
                    None
                },
            );
            push(
                "ancestors",
                None,
                None,
                if allowed("ancestors") {
                    http("GET", "/{id}/ancestors")
                } else {
                    None
                },
            );
        }
        if blob.is_some() {
            push(
                "beginUpload",
                None,
                None,
                if allowed("beginUpload") {
                    http("POST", "/{id}/upload")
                } else {
                    None
                },
            );
            push(
                "finalizeUpload",
                None,
                None,
                if allowed("finalizeUpload") {
                    http("POST", "/{id}/finalize")
                } else {
                    None
                },
            );
            push(
                "download",
                None,
                None,
                if allowed("download") {
                    http("GET", "/{id}/content")
                } else {
                    None
                },
            );
        }
        if let Some(lc) = &lifecycle {
            for t in &lc.transitions {
                let exposed = crud
                    .as_ref()
                    .is_some_and(|c| c.actions.iter().any(|a| a == &t.action));
                push(
                    "transition",
                    None,
                    Some(t.action.clone()),
                    if exposed {
                        http("POST", &format!("/{{id}}/actions/{}", t.action))
                    } else {
                        None
                    },
                );
            }
        }
        if let Some(c) = &crud {
            let known: Vec<String> = lifecycle
                .as_ref()
                .map(|l| l.transitions.iter().map(|t| t.action.clone()).collect())
                .unwrap_or_default();
            for a in &c.actions {
                if !known.contains(a) {
                    let sugg = suggest(a, known.iter().map(|s| s.as_str()))
                        .map(|s| format!("did you mean `{s}`?"));
                    self.err(
                        "E-DEC-004",
                        file,
                        range_of(r),
                        format!("`@crud` exposes unknown lifecycle action `{a}`"),
                        sugg,
                    );
                }
            }
        }

        if decorators.write_once {
            operations.retain(|op| {
                !matches!(
                    op.kind.as_str(),
                    "update" | "delete" | "restore" | "move" | "transition"
                )
            });
        }
        if decorators.append_only {
            operations.retain(|op| {
                matches!(
                    op.kind.as_str(),
                    "create" | "get" | "find" | "list" | "effective"
                )
            });
        }

        // ---- edition 2027: governance surface
        for dec in r.decorators() {
            if let Some(n) = dec.name()
                && EDITION_2027_DECORATORS.contains(&n.text())
            {
                self.require_edition_2027(file, tok_range(&n), &format!("`@{}`", n.text()));
            }
        }
        match &decorators.subject {
            Some(SubjectBinding::Kind { kind: k })
                if !matches!(k.as_str(), "person" | "organization" | "device") =>
            {
                self.err("E-GOV-005", file, range_of(r), "`@subject` kind must be `person`, `organization` or `device`, or `@subject(from: field)`", None);
            }
            Some(SubjectBinding::From { field }) => {
                // The referenced record carries the subject; a bounded access path must exist so one subject's
                // records can be located without a scan (PAR-094).
                match fields.iter().find(|f| &f.name == field) {
                    Some(f) if matches!(f.ty.base, TypeBase::Reference { .. }) => {
                        if !lists
                            .iter()
                            .any(|l| l.fields.len() == 1 && &l.fields[0] == field)
                        {
                            self.err("E-GOV-007", file, range_of(r), format!("`@subject(from: {field})` needs `list by {field}` so a subject's records are locatable without a scan"), None);
                        }
                    }
                    _ => self.err(
                        "E-GOV-005",
                        file,
                        range_of(r),
                        format!(
                            "`@subject(from: {field})` must name a reference field of `{name}`"
                        ),
                        None,
                    ),
                }
            }
            _ => {}
        }
        if let Some(ctx) = &decorators.record_context
            && !Taxonomy::core().record_contexts.iter().any(|c| c == ctx)
        {
            self.err(
                "E-GOV-008",
                file,
                range_of(r),
                format!(
                    "unknown record context `{ctx}`; known: {}",
                    Taxonomy::core().record_contexts.join(", ")
                ),
                None,
            );
        }
        let field_names: Vec<String> = fields.iter().map(|f| f.name.clone()).collect();
        let action_names: Vec<String> = lifecycle
            .as_ref()
            .map(|l| {
                l.transitions
                    .iter()
                    .map(|t| format!("status.{}", t.action))
                    .collect()
            })
            .unwrap_or_default();
        let cap_names: Vec<String> = r
            .capabilities()
            .filter_map(|c| c.name().map(|t| t.text().to_string()))
            .collect();
        let mut capabilities: Vec<Capability> = Vec::new();
        for c in r.capabilities() {
            let Some(cn) = c.name() else { continue };
            self.require_edition_2027(file, tok_range(&cn), "`capability`");
            let mut includes = Vec::new();
            let mut atoms = Vec::new();
            for item in c.items() {
                if let Some(inc) = item.includes() {
                    if !cap_names.iter().any(|x| x == inc.text()) {
                        let sugg = suggest(inc.text(), cap_names.iter().map(|s| s.as_str()))
                            .map(|s| format!("did you mean `{s}`?"));
                        self.err(
                            "E-GOV-001",
                            file,
                            tok_range(&inc),
                            format!(
                                "capability `{}` includes unknown capability `{}`",
                                cn.text(),
                                inc.text()
                            ),
                            sugg,
                        );
                        continue;
                    }
                    if inc.text() == cn.text() {
                        self.err(
                            "E-GOV-001",
                            file,
                            tok_range(&inc),
                            format!("capability `{}` cannot include itself", cn.text()),
                            None,
                        );
                        continue;
                    }
                    includes.push(inc.text().to_string());
                    continue;
                }
                let Some(verb) = item.verb() else { continue };
                let names: Vec<String> = item.names().iter().map(|q| q.text()).collect();
                for (q, tok) in item.names().iter().zip(item.name_tokens()) {
                    let ok = match verb.text() {
                        "actions" => {
                            action_names.iter().any(|a| *a == q.text()) || q.text() == "export"
                        }
                        _ => field_names.iter().any(|f| *f == q.text()),
                    };
                    if !ok {
                        let cands: Vec<&str> = if verb.text() == "actions" {
                            action_names
                                .iter()
                                .map(|s| s.as_str())
                                .chain(std::iter::once("export"))
                                .collect()
                        } else {
                            field_names.iter().map(|s| s.as_str()).collect()
                        };
                        let sugg =
                            suggest(&q.text(), cands).map(|s| format!("did you mean `{s}`?"));
                        self.err(
                            "E-GOV-002",
                            file,
                            tok_range(&tok),
                            format!(
                                "capability `{}`: `{}` is not a {} of `{name}`",
                                cn.text(),
                                q.text(),
                                if verb.text() == "actions" {
                                    "lifecycle action"
                                } else {
                                    "field"
                                }
                            ),
                            sugg,
                        );
                    }
                }
                atoms.push(CapabilityAtom {
                    deny: item.deny(),
                    verb: verb.text().to_string(),
                    names,
                });
            }
            capabilities.push(Capability {
                name: cn.text().to_string(),
                includes,
                atoms,
            });
        }
        for cyc in crate::capability::inclusion_cycles(&Resource {
            id: id.clone(),
            name: name.clone(),
            kind: "resource".into(),
            exported,
            doc: None,
            decorators: decorators.clone(),
            fields: vec![],
            uniques: vec![],
            finds: vec![],
            lists: vec![],
            rules: vec![],
            lifecycle: None,
            content: None,
            operations: vec![],
            capabilities: capabilities.clone(),
            purpose_bindings: vec![],
        }) {
            self.err("E-GOV-009", file, range_of(r), format!("capability `{cyc}` includes itself (directly or through another fragment); inclusion must be acyclic"), None);
        }
        let mut purpose_bindings = Vec::new();
        for b in r.purpose_bindings() {
            let Some(p) = b.purpose() else { continue };
            self.require_edition_2027(file, range_of(&p), "`for Purpose { use .. }`");
            let Some(purpose) = self.resolve_purpose(&p.segments(), module, file, range_of(&p))
            else {
                continue;
            };
            for u in b.uses() {
                if !cap_names.iter().any(|x| x == u.text()) {
                    let sugg = suggest(u.text(), cap_names.iter().map(|s| s.as_str()))
                        .map(|s| format!("did you mean `{s}`?"));
                    self.err(
                        "E-GOV-004",
                        file,
                        tok_range(&u),
                        format!("`for {}` uses unknown capability `{}`", p.text(), u.text()),
                        sugg,
                    );
                    continue;
                }
                purpose_bindings.push(PurposeBinding {
                    purpose: purpose.clone(),
                    capability: u.text().to_string(),
                });
            }
        }
        Some(Resource {
            id,
            name,
            kind: if blob.is_some() {
                "blob".into()
            } else {
                "resource".into()
            },
            exported,
            doc: ast::doc_of(r.syntax()),
            decorators,
            fields,
            uniques,
            finds,
            lists,
            rules,
            lifecycle,
            content,
            operations,
            capabilities,
            purpose_bindings,
        })
    }

    fn content_policy(&mut self, b: &ast::BlobDecl, file: usize) -> Option<ContentPolicy> {
        let Some(cb) = b.content() else {
            self.err(
                "E-BLOB-002",
                file,
                range_of(b),
                "a blob must declare a `content { mediaTypes [...] maxBytes N }` block",
                None,
            );
            return None;
        };
        let mut media_types = Vec::new();
        let mut max_bytes: Option<u64> = None;
        for (key, values) in cb.items() {
            match key.as_str() {
                "mediaTypes" => media_types = values,
                "maxBytes" => max_bytes = values.first().and_then(|v| v.parse().ok()),
                other => self.err(
                    "E-BLOB-003",
                    file,
                    range_of(&cb),
                    format!("unknown content policy key `{other}`"),
                    Some("known keys: mediaTypes, maxBytes".into()),
                ),
            }
        }
        let max_bytes = match max_bytes {
            Some(n) if n > 0 => n,
            _ => {
                self.err(
                    "E-BLOB-001",
                    file,
                    range_of(&cb),
                    "content policy needs `maxBytes` greater than zero",
                    None,
                );
                return None;
            }
        };
        if media_types.is_empty() {
            self.err(
                "E-BLOB-001",
                file,
                range_of(&cb),
                "content policy needs at least one media type",
                None,
            );
            return None;
        }
        Some(ContentPolicy {
            media_types,
            max_bytes,
        })
    }

    fn lifecycle(
        &mut self,
        l: &ast::LifecycleBlock,
        module: &str,
        file: usize,
        resource_id: &str,
        exported: bool,
        enums_out: &mut Vec<EnumDecl>,
    ) -> Option<Lifecycle> {
        let field = l.field_name()?.text().to_string();
        let mut states: Vec<String> = Vec::new();
        let add = |s: &str, states: &mut Vec<String>| {
            if !states.iter().any(|x| x == s) {
                states.push(s.to_string());
            }
        };
        let initials: Vec<_> = l.initials().filter_map(|i| i.state()).collect();
        let terminals: Vec<_> = l.terminals().filter_map(|i| i.state()).collect();
        for t in &initials {
            add(t.text(), &mut states);
        }
        for t in &terminals {
            add(t.text(), &mut states);
        }
        let mut transitions: Vec<Transition> = Vec::new();
        let mut seen_actions: BTreeMap<String, (Vec<String>, String)> = BTreeMap::new();
        for t in l.transitions() {
            let Some(action) = t.action() else { continue };
            let sources: Vec<String> = t.sources().iter().map(|s| s.text().to_string()).collect();
            let Some(target) = t.target() else { continue };
            for s in &sources {
                add(s, &mut states);
            }
            add(target.text(), &mut states);
            if sources.iter().any(|s| s == target.text()) {
                self.err(
                    "E-LC-021",
                    file,
                    range_of(&t),
                    format!(
                        "transition `{}` targets one of its own source states",
                        action.text()
                    ),
                    None,
                );
            }
            let mut input = Vec::new();
            if let Some(ib) = t.input() {
                for fd in ib.fields() {
                    if let Some(f) = self.field(&fd, module, file, None, &[]) {
                        input.push(f);
                    }
                }
            }
            let key = action.text().to_string();
            if let Some((prev_sources, prev_target)) = seen_actions.get(&key) {
                if prev_target != target.text() || prev_sources.iter().any(|s| sources.contains(s))
                {
                    self.err(
                        "E-LC-003",
                        file,
                        tok_range(&action),
                        format!("duplicate lifecycle action `{key}`"),
                        None,
                    );
                    continue;
                }
                self.err(
                    "E-LC-006",
                    file,
                    tok_range(&action),
                    format!("action `{key}` is declared more than once"),
                    None,
                );
                continue;
            }
            seen_actions.insert(key.clone(), (sources.clone(), target.text().to_string()));
            transitions.push(Transition {
                action: key,
                from: sources,
                to: target.text().to_string(),
                input,
                doc: t.doc(),
            });
        }
        let initial = match initials.as_slice() {
            [one] => one.text().to_string(),
            [] => {
                self.err(
                    "E-LC-001",
                    file,
                    range_of(l),
                    "lifecycle needs exactly one `initial` state",
                    Some(
                        "add `initial <State>` so creation defaults cannot change silently".into(),
                    ),
                );
                return None;
            }
            [_, second, ..] => {
                self.err(
                    "E-LC-001",
                    file,
                    tok_range(second),
                    "lifecycle declares more than one `initial` state",
                    None,
                );
                return None;
            }
        };
        let terminal_names: Vec<String> = terminals.iter().map(|t| t.text().to_string()).collect();
        for t in &transitions {
            for s in &t.from {
                if terminal_names.contains(s) {
                    self.err(
                        "E-LC-002",
                        file,
                        range_of(l),
                        format!(
                            "terminal state `{s}` has an outgoing transition `{}`",
                            t.action
                        ),
                        None,
                    );
                }
            }
        }
        // reachability from initial
        let mut reach: BTreeSet<String> = BTreeSet::from([initial.clone()]);
        loop {
            let before = reach.len();
            for t in &transitions {
                if t.from.iter().any(|s| reach.contains(s)) {
                    reach.insert(t.to.clone());
                }
            }
            if reach.len() == before {
                break;
            }
        }
        for s in &states {
            if !reach.contains(s) {
                self.err(
                    "E-LC-004",
                    file,
                    range_of(l),
                    format!("state `{s}` is unreachable from `{initial}`"),
                    None,
                );
            }
        }
        // suspicious spellings
        for (i, a) in states.iter().enumerate() {
            for b in &states[i + 1..] {
                if crate::diagnostics::levenshtein(a, b) == 1 {
                    self.err("W-LC-011", file, range_of(l), format!("states `{a}` and `{b}` differ by one character; inferred state sets cannot prove intent"), None);
                }
            }
        }
        let enum_id = format!("{resource_id}.Status");
        enums_out.push(EnumDecl {
            id: enum_id.clone(),
            name: format!("{}.Status", short(resource_id)),
            exported,
            synthesized: true,
            doc: None,
            members: states
                .iter()
                .map(|s| EnumMember {
                    name: s.clone(),
                    value: s.clone(),
                    doc: None,
                })
                .collect(),
        });
        Some(Lifecycle {
            field,
            enum_id,
            states,
            initial,
            terminals: terminal_names,
            transitions,
        })
    }

    // ------------------------------------------------------------ functions
    fn function(
        &mut self,
        f: &ast::FunctionDecl,
        module: &str,
        file: usize,
        exported: bool,
    ) -> Option<Function> {
        let name = f.name()?.text().to_string();
        let id = self.id(module, &name);
        let input = f.input().and_then(|n| self.type_ref_spec(&n, module, file));
        let output = f
            .output()
            .and_then(|n| self.type_ref_spec(&n, module, file));
        let mut http = None;
        for d in f.decorators() {
            let Some(n) = d.name() else { continue };
            match n.text() {
                "http" => {
                    let args = d.args();
                    let method = args.first().and_then(|a| a.value()).and_then(|v| {
                        if let ArgValue::Name(m) = v {
                            m.first().cloned()
                        } else {
                            None
                        }
                    });
                    let path = args.get(1).and_then(|a| a.value()).and_then(|v| {
                        if let ArgValue::Literal(p) = v {
                            Some(unq(&p))
                        } else {
                            None
                        }
                    });
                    match (method, path) {
                        (Some(m), Some(p)) if HTTP_METHODS.contains(&m.as_str()) => {
                            let input_fields: Vec<String> = input
                                .as_ref()
                                .map(|t| self.fields_of_type(&t.base, module))
                                .unwrap_or_default();
                            for param in p.split('{').skip(1).filter_map(|s| s.split('}').next()) {
                                if !input_fields.iter().any(|f| f == param) {
                                    self.err("E-HTTP-001", file, range_of(&d), format!("path parameter `{{{param}}}` is not a field of the function input"), None);
                                }
                            }
                            http = Some(HttpBinding { method: m, path: p });
                        }
                        _ => self.err(
                            "E-DEC-002",
                            file,
                            range_of(&d),
                            "`@http` requires a method and a path, e.g. `@http(POST, \"/v1/x\")`",
                            None,
                        ),
                    }
                }
                "label" => {}
                other => {
                    let sugg = suggest(other, FUNCTION_DECORATORS.iter().copied())
                        .map(|s| format!("did you mean `@{s}`?"));
                    self.err(
                        "E-DEC-001",
                        file,
                        tok_range(&n),
                        format!("unknown function decorator `@{other}`"),
                        sugg,
                    );
                }
            }
        }
        let mut uses = Vec::new();
        for u in f.uses() {
            let Some(t) = u.target() else { continue };
            let segs = t.segments();
            match self.resolve(&segs, module, file, range_of(&t)) {
                Some(Resolved::Type(TypeBase::Reference { resource })) => {
                    uses.push(Use::Resource {
                        resource,
                        capability: u.capability().unwrap_or_else(|| "read".into()),
                    })
                }
                Some(Resolved::Transition { resource, action }) => {
                    uses.push(Use::Transition { resource, action })
                }
                Some(Resolved::Function(function)) => uses.push(Use::Function {
                    function,
                    purpose: None,
                }),
                Some(_) => self.err(
                    "E-USE-001",
                    file,
                    range_of(&t),
                    format!("`{}` cannot be used as a dependency", t.text()),
                    None,
                ),
                None => {}
            }
        }
        let mut sends = Vec::new();
        for s in f.sends() {
            let (Some(m), Some(ch)) = (s.message(), s.channel()) else {
                continue;
            };
            let segs = ch.segments();
            if let Some(Resolved::Channel(channel)) =
                self.resolve(&segs, module, file, range_of(&ch))
            {
                let (messages, direction) = self.channel_info(&channel, module);
                if !messages.iter().any(|x| x == m.text()) {
                    let sugg = suggest(m.text(), messages.iter().map(|s| s.as_str()))
                        .map(|s| format!("did you mean `{s}`?"));
                    self.err(
                        "E-SYM-001",
                        file,
                        tok_range(&m),
                        format!("channel `{}` has no message `{}`", ch.text(), m.text()),
                        sugg,
                    );
                } else if direction.as_deref() == Some("recv-only") {
                    self.err(
                        "E-CH-001",
                        file,
                        range_of(&s),
                        format!(
                            "`{}` is `recv-only`; this function cannot send to it",
                            ch.text()
                        ),
                        None,
                    );
                } else {
                    sends.push(Send {
                        message: m.text().to_string(),
                        channel,
                    });
                }
            } else if self.sym(module, &segs[0]).is_some() {
                self.err(
                    "E-USE-002",
                    file,
                    range_of(&ch),
                    format!("`{}` is not a channel", ch.text()),
                    None,
                );
            }
        }
        let purpose = match f.purpose() {
            Some(q) => {
                self.require_edition_2027(file, range_of(&q), "`purpose` in a function");
                self.resolve_purpose(&q.segments(), module, file, range_of(&q))
            }
            None => None,
        };
        let mut output = output;
        // A purpose-scoped resource's record can only leave a purposed function through a scoped surface (plan §8.4).
        if purpose.is_some()
            && f.output_purpose().is_none()
            && let Some(TypeSpec {
                base: TypeBase::Record { resource },
                ..
            }) = &output
            && self.is_purpose_scoped(resource, module)
        {
            self.err("E-GOV-010", file, range_of(f), format!("`{}` runs under a purpose but returns an unscoped `{}.Record`; declare `{}.Record<Purpose>` or a privileged maintenance surface", name, short(resource), short(resource)), None);
        }
        if let Some(q) = f.output_purpose() {
            self.require_edition_2027(file, range_of(&q), "`Record<Purpose>`");
            if let Some(p) = self.resolve_purpose(&q.segments(), module, file, range_of(&q))
                && let Some(o) = output.as_mut()
            {
                o.purpose = Some(p);
            }
        }
        for (u, ir_use) in f.uses().iter().zip(uses.iter_mut()) {
            if let Some(q) = u.purpose() {
                self.require_edition_2027(file, range_of(&q), "`for Purpose` on a dependency");
                if let Some(p) = self.resolve_purpose(&q.segments(), module, file, range_of(&q))
                    && let Use::Function { purpose, .. } = ir_use
                {
                    *purpose = Some(p);
                }
            }
        }
        let errors: Vec<String> = f.errors().iter().map(|t| t.text().to_string()).collect();
        let slo = f
            .slo()
            .iter()
            .filter_map(|s| s.parts())
            .map(|(k, target, within, window)| {
                if k == "latency" {
                    Slo::Latency {
                        target,
                        within: within.unwrap_or_default(),
                        window,
                    }
                } else {
                    Slo::Availability { target, window }
                }
            })
            .collect();
        Some(Function {
            id,
            name,
            exported,
            doc: ast::doc_of(f.syntax()),
            input,
            output,
            uses,
            sends,
            errors,
            slo,
            http,
            generated: false,
            purpose,
        })
    }

    fn type_ref_spec(
        &mut self,
        n: &ast::QualifiedName,
        module: &str,
        file: usize,
    ) -> Option<TypeSpec> {
        match self.resolve(&n.segments(), module, file, range_of(n))? {
            Resolved::Type(base) => Some(TypeSpec {
                base,
                optional: false,
                normalizers: vec![],
                constraints: vec![],
                purpose: None,
                data_class: None,
            }),
            _ => {
                self.err(
                    "E-TYPE-001",
                    file,
                    range_of(n),
                    format!("`{}` is not a type", n.text()),
                    None,
                );
                None
            }
        }
    }

    fn fields_of_type(&mut self, base: &TypeBase, module: &str) -> Vec<String> {
        match base {
            TypeBase::Shape { id } => {
                let local_prefix = format!("{}/{}/", self.pkg.name, module);
                if let Some(name) = id.strip_prefix(&local_prefix)
                    && let Some(Symbol {
                        decl: Declaration::Shape(s),
                        ..
                    }) = self.sym(module, name)
                {
                    return s
                        .fields()
                        .filter_map(|f| f.name().map(|t| t.text().to_string()))
                        .collect();
                }
                self.deps
                    .values()
                    .find_map(|d| d.find_shape(id))
                    .map(|s| s.fields.iter().map(|f| f.name.clone()).collect())
                    .unwrap_or_default()
            }
            TypeBase::Record { resource } | TypeBase::Reference { resource } => self
                .resource_fields(resource, module)
                .into_iter()
                .map(|f| f.name)
                .collect(),
            TypeBase::Message { channel, message } => {
                let local_prefix = format!("{}/{}/", self.pkg.name, module);
                if let Some(name) = channel.strip_prefix(&local_prefix)
                    && let Some(Symbol {
                        decl: Declaration::Channel(c),
                        ..
                    }) = self.sym(module, name)
                {
                    return c
                        .messages()
                        .find(|m| m.name().is_some_and(|t| t.text() == message))
                        .map(|m| {
                            m.fields()
                                .filter_map(|f| f.name().map(|t| t.text().to_string()))
                                .collect()
                        })
                        .unwrap_or_default();
                }
                self.deps
                    .values()
                    .find_map(|d| d.find_channel(channel))
                    .and_then(|c| c.messages.iter().find(|m| &m.name == message))
                    .map(|m| m.fields.iter().map(|f| f.name.clone()).collect())
                    .unwrap_or_default()
            }
            _ => vec![],
        }
    }

    /// (message names, direction) for a channel id, local or imported.
    fn channel_info(&mut self, id: &str, module: &str) -> (Vec<String>, Option<String>) {
        let local_prefix = format!("{}/{}/", self.pkg.name, module);
        if let Some(name) = id.strip_prefix(&local_prefix)
            && let Some(Symbol {
                decl: Declaration::Channel(c),
                file,
                ..
            }) = self.sym(module, name)
        {
            let (c, file) = (c.clone(), *file);
            let (_, messages) = self.channel_contract(&c, module, file);
            return (messages, c.direction());
        }
        for d in self.deps.values() {
            if let Some(c) = d.find_channel(id) {
                return (
                    c.messages.iter().map(|m| m.name.clone()).collect(),
                    c.direction.clone(),
                );
            }
        }
        (vec![], None)
    }

    // ------------------------------------------------------------ workflows
    fn workflow(
        &mut self,
        w: &ast::WorkflowDecl,
        module: &str,
        file: usize,
        exported: bool,
    ) -> Option<Workflow> {
        let name = w.name()?.text().to_string();
        let id = self.id(module, &name);
        let input = w.input().and_then(|n| self.type_ref_spec(&n, module, file));
        let output = w
            .output()
            .and_then(|n| self.type_ref_spec(&n, module, file));
        let errors: Vec<String> = w.errors().iter().map(|t| t.text().to_string()).collect();
        let Some(version) = w.version().and_then(|t| t.text().parse::<u32>().ok()) else {
            self.err(
                "E-WF-004",
                file,
                range_of(w),
                "a workflow must pin `version N`; in-flight instances are bound to it",
                None,
            );
            return None;
        };
        let mut http = None;
        for d in w.decorators() {
            let Some(n) = d.name() else { continue };
            match n.text() {
                "http" => {
                    let args = d.args();
                    let method = args.first().and_then(|a| a.value()).and_then(|v| {
                        if let ArgValue::Name(m) = v {
                            m.first().cloned()
                        } else {
                            None
                        }
                    });
                    let path = args.get(1).and_then(|a| a.value()).and_then(|v| {
                        if let ArgValue::Literal(p) = v {
                            Some(unq(&p))
                        } else {
                            None
                        }
                    });
                    match (method, path) {
                        (Some(m), Some(p)) if HTTP_METHODS.contains(&m.as_str()) => {
                            let input_fields: Vec<String> = input
                                .as_ref()
                                .map(|t| self.fields_of_type(&t.base, module))
                                .unwrap_or_default();
                            for param in p.split('{').skip(1).filter_map(|s| s.split('}').next()) {
                                if !input_fields.iter().any(|f| f == param) {
                                    self.err("E-HTTP-001", file, range_of(&d), format!("path parameter `{{{param}}}` is not a field of the workflow input"), None);
                                }
                            }
                            http = Some(HttpBinding { method: m, path: p });
                        }
                        _ => self.err(
                            "E-DEC-002",
                            file,
                            range_of(&d),
                            "`@http` requires a method and a path, e.g. `@http(POST, \"/v1/x\")`",
                            None,
                        ),
                    }
                }
                "label" => {}
                other => self.err(
                    "E-DEC-001",
                    file,
                    tok_range(&n),
                    format!("unknown workflow decorator `@{other}`"),
                    None,
                ),
            }
        }
        let mut scope = WfScope {
            ids: Vec::new(),
            bound: vec!["input".into()],
            errors: errors.clone(),
            types: input
                .iter()
                .map(|t| ("input".to_string(), t.clone()))
                .collect(),
        };
        let steps = self.workflow_items(&w.items(), module, file, &mut scope);
        let graph_hash = hash_hex(&serde_json::to_string(&(version, &steps)).unwrap_or_default());
        Some(Workflow {
            id,
            name,
            exported,
            doc: ast::doc_of(w.syntax()),
            version,
            input,
            output,
            errors,
            http,
            steps,
            graph_hash,
        })
    }

    fn workflow_items(
        &mut self,
        items: &[ast::StepItem],
        module: &str,
        file: usize,
        scope: &mut WfScope,
    ) -> Vec<Step> {
        let mut out = Vec::new();
        for item in items {
            match item {
                ast::StepItem::Step(s) => {
                    let Some(name_tok) = s.name() else { continue };
                    let sid = name_tok.text().to_string();
                    if scope.ids.contains(&sid) {
                        self.err("E-WF-001", file, tok_range(&name_tok), format!("duplicate step id `{sid}`; step ids are stable semantic identifiers"), None);
                        continue;
                    }
                    scope.ids.push(sid.clone());
                    let Some(body) = s.body() else { continue };
                    let step = match body {
                        ast::StepBody::Map(m) => self.workflow_map(&sid, &m, module, file, scope),
                        ast::StepBody::Sleep(sl) => sl.duration().map(|d| Step::Sleep {
                            id: sid.clone(),
                            duration: d.text().to_string(),
                        }),
                        ast::StepBody::Wait(wt) => {
                            self.workflow_wait(&sid, &wt, module, file, scope)
                        }
                        ast::StepBody::Call(c) => self.workflow_call(&sid, &c, module, file, scope),
                    };
                    // The step's result is bound for everything after it.
                    if let Some(Step::Call { target, .. }) = &step {
                        let ty = match target {
                            CallTarget::Function { function } => {
                                self.function_output(function, module)
                            }
                            CallTarget::Transition { resource, .. } => Some(TypeSpec {
                                base: TypeBase::Record {
                                    resource: resource.clone(),
                                },
                                optional: false,
                                normalizers: vec![],
                                constraints: vec![],
                                purpose: None,
                                data_class: None,
                            }),
                        };
                        if let Some(t) = ty {
                            scope.types.push((sid.clone(), t));
                        }
                    }
                    scope.bound.push(sid);
                    if let Some(st) = step {
                        out.push(st);
                    }
                }
                ast::StepItem::Choice(c) => {
                    let Some(cond) = c
                        .condition()
                        .and_then(|e| self.workflow_expr(&e, module, file, scope))
                    else {
                        continue;
                    };
                    let then_items = c.then_items();
                    let else_items = c.else_items();
                    let first = |items: &[ast::StepItem]| {
                        items.iter().find_map(|i| {
                            if let ast::StepItem::Step(s) = i {
                                s.name().map(|t| t.text().to_string())
                            } else {
                                None
                            }
                        })
                    };
                    let id = first(&then_items)
                        .or_else(|| first(&else_items))
                        .unwrap_or_else(|| format!("{}", scope.ids.len()));
                    let then = self.workflow_items(&then_items, module, file, scope);
                    let otherwise = self.workflow_items(&else_items, module, file, scope);
                    out.push(Step::Choice {
                        id,
                        condition: cond,
                        then,
                        otherwise,
                    });
                }
                ast::StepItem::Parallel(p) => {
                    let items = p.items();
                    let names: Vec<String> = items
                        .iter()
                        .filter_map(|i| {
                            if let ast::StepItem::Step(s) = i {
                                s.name().map(|t| t.text().to_string())
                            } else {
                                None
                            }
                        })
                        .collect();
                    // Each branch is one step; branches see the same bindings and never each other's.
                    let mut branches = Vec::new();
                    let before = scope.bound.clone();
                    for i in &items {
                        scope.bound = before.clone();
                        branches.push(self.workflow_items(
                            std::slice::from_ref(i),
                            module,
                            file,
                            scope,
                        ));
                    }
                    scope.bound = before;
                    scope.bound.extend(names.iter().cloned());
                    out.push(Step::Parallel {
                        id: names.join("+"),
                        branches,
                    });
                }
                ast::StepItem::Return(r) => {
                    if let Some(v) = r
                        .value()
                        .and_then(|e| self.workflow_expr(&e, module, file, scope))
                    {
                        out.push(Step::Return { value: v });
                    }
                }
                ast::StepItem::Fail(f) => {
                    if let Some(e) = self.workflow_fail(f, file, scope) {
                        out.push(Step::Fail { error: e });
                    }
                }
            }
        }
        out
    }

    fn workflow_fail(&mut self, f: &ast::FailDecl, file: usize, scope: &WfScope) -> Option<String> {
        let t = f.error()?;
        if !scope.errors.iter().any(|e| e == t.text()) {
            let sugg = suggest(t.text(), scope.errors.iter().map(|s| s.as_str()))
                .map(|s| format!("did you mean `{s}`?"));
            self.err(
                "E-WF-003",
                file,
                tok_range(&t),
                format!("`{}` is not a declared workflow error", t.text()),
                sugg,
            );
            return None;
        }
        Some(t.text().to_string())
    }

    fn workflow_terminal(
        &mut self,
        t: &ast::WorkflowTerminal,
        module: &str,
        file: usize,
        scope: &WfScope,
    ) -> Option<Terminal> {
        match t {
            ast::WorkflowTerminal::Return(r) => r
                .value()
                .and_then(|e| self.workflow_expr(&e, module, file, scope))
                .map(|value| Terminal::Return { value }),
            ast::WorkflowTerminal::Fail(f) => self
                .workflow_fail(f, file, scope)
                .map(|error| Terminal::Fail { error }),
        }
    }

    /// Bindings resolve to `input` or a step completed earlier on the path; literals and enum members pass through.
    fn workflow_expr(
        &mut self,
        e: &ast::Expr,
        module: &str,
        file: usize,
        scope: &WfScope,
    ) -> Option<Expr> {
        Some(match e {
            ast::Expr::Binary(b) => Expr::Binary {
                op: b.op()?,
                lhs: Box::new(self.workflow_expr(&b.lhs()?, module, file, scope)?),
                rhs: Box::new(self.workflow_expr(&b.rhs()?, module, file, scope)?),
            },
            ast::Expr::Unary(u) => Expr::Unary {
                op: u.op()?,
                operand: Box::new(self.workflow_expr(&u.operand()?, module, file, scope)?),
            },
            ast::Expr::Paren(p) => self.workflow_expr(&p.inner()?, module, file, scope)?,
            ast::Expr::Literal(l) => Expr::Literal {
                literal: literal_of(&l.text()),
            },
            ast::Expr::Call(c) => {
                self.err(
                    "E-WF-005",
                    file,
                    range_of(c),
                    "calls are steps, not expressions; bind the result with `step name = ...`",
                    None,
                );
                return None;
            }
            ast::Expr::Name(n) => {
                let path = n.segments();
                let head = path.first()?;
                let is_enum = path.len() >= 2
                    && self
                        .sym(module, head)
                        .is_some_and(|s| matches!(s.kind, SymKind::Enum | SymKind::Resource));
                if !scope.bound.iter().any(|b| b == head) && !is_enum {
                    let sugg = suggest(head, scope.bound.iter().map(|s| s.as_str()))
                        .map(|s| format!("did you mean `{s}`?"));
                    self.err(
                        "E-SYM-001",
                        file,
                        range_of(n),
                        format!("`{head}` is not `input` or a step completed before this point"),
                        sugg,
                    );
                    return None;
                }
                Expr::Name { path }
            }
        })
    }

    fn workflow_wait(
        &mut self,
        sid: &str,
        wt: &ast::StepWait,
        module: &str,
        file: usize,
        scope: &WfScope,
    ) -> Option<Step> {
        let msg = wt.message()?;
        let segs = msg.segments();
        let Some(Resolved::Type(TypeBase::Message {
            channel: contract,
            message,
        })) = self.resolve(&segs, module, file, range_of(&msg))
        else {
            return None;
        };
        // Route on the local channel binding; the contract identifies the message shape.
        let channel = if segs.len() == 2 && self.sym(module, &segs[0]).is_some() {
            self.id(module, &segs[0])
        } else {
            contract.clone()
        };
        let fields = self.fields_of_type(
            &TypeBase::Message {
                channel: contract,
                message: message.clone(),
            },
            module,
        );
        let mut correlate = None;
        if let Some(c) = wt.correlate() {
            let (Some(f), Some(v)) = (c.field(), c.value()) else {
                return None;
            };
            if !fields.iter().any(|x| x == f.text()) {
                let sugg = suggest(f.text(), fields.iter().map(|s| s.as_str()))
                    .map(|s| format!("did you mean `{s}`?"));
                self.err(
                    "E-WF-002",
                    file,
                    tok_range(&f),
                    format!(
                        "message `{}` has no field `{}` to correlate on",
                        message,
                        f.text()
                    ),
                    sugg,
                );
                return None;
            }
            correlate = Some(Correlation {
                field: f.text().to_string(),
                value: self.workflow_expr(&v, module, file, scope)?,
            });
        }
        let mut timeout = None;
        if let Some(t) = wt.timeout() {
            let (Some(d), Some(then)) = (t.duration(), t.then()) else {
                return None;
            };
            let then = self.workflow_terminal(&then, module, file, scope)?;
            timeout = Some(Timeout {
                duration: d.text().to_string(),
                then,
            });
        }
        Some(Step::Wait {
            id: sid.to_string(),
            channel,
            message,
            correlate,
            timeout,
        })
    }

    fn workflow_map(
        &mut self,
        sid: &str,
        m: &ast::StepMap,
        module: &str,
        file: usize,
        scope: &mut WfScope,
    ) -> Option<Step> {
        let concurrency = m.concurrency()?.text().parse::<u32>().unwrap_or(0);
        let source = m.source()?;
        let Some(source_type) = self.workflow_expr_type(&source, module, scope) else {
            self.err(
                "E-WF-MAP-001",
                file,
                range_of(m),
                "map input must resolve to a declared bounded list",
                None,
            );
            return None;
        };
        let TypeBase::Collection {
            collection: CollectionKind::List,
            element,
        } = source_type.base
        else {
            self.err(
                "E-WF-MAP-001",
                file,
                range_of(m),
                "map requires a bounded list input",
                None,
            );
            return None;
        };
        let max_items = source_type
            .constraints
            .iter()
            .filter_map(|c| {
                if let Constraint::Length { max, .. } = c {
                    *max
                } else {
                    None
                }
            })
            .min()
            .unwrap_or(0);
        if concurrency == 0
            || concurrency > 32
            || max_items == 0
            || max_items > 1024
            || source_type.optional
        {
            self.err(
                "E-WF-MAP-001",
                file,
                range_of(m),
                "map requires a nonoptional bounded list and concurrency 1..32",
                None,
            );
            return None;
        }
        let binding = m.binding()?.text().to_string();
        if scope.bound.contains(&binding) {
            self.err(
                "E-WF-MAP-002",
                file,
                range_of(m),
                "map binding shadows an existing workflow binding",
                None,
            );
            return None;
        }
        let value = self.workflow_expr(&source, module, file, scope)?;
        let mut child_scope = scope.clone();
        child_scope.bound.push(binding.clone());
        child_scope.types.push((binding.clone(), *element));
        let call = self.workflow_call(sid, &m.call()?, module, file, &child_scope)?;
        if let Step::Call {
            target: CallTarget::Function { function },
            ..
        } = &call
            && let Some(element) = self.function_output(function, module)
        {
            scope.types.push((
                sid.into(),
                TypeSpec {
                    base: TypeBase::Collection {
                        collection: CollectionKind::List,
                        element: Box::new(element),
                    },
                    optional: false,
                    constraints: vec![Constraint::Length {
                        min: Some(0),
                        max: Some(max_items),
                    }],
                    normalizers: vec![],
                    purpose: None,
                    data_class: None,
                },
            ));
        }
        Some(Step::Map {
            id: sid.into(),
            binding,
            source: value,
            concurrency,
            max_items: max_items as u32,
            call: Box::new(call),
        })
    }

    fn workflow_call(
        &mut self,
        sid: &str,
        c: &ast::StepCall,
        module: &str,
        file: usize,
        scope: &WfScope,
    ) -> Option<Step> {
        let t = c.target()?;
        let segs = t.segments();
        let (target, allowed, declared_errors): (CallTarget, Vec<String>, Vec<String>) =
            match self.resolve(&segs, module, file, range_of(&t))? {
                Resolved::Function(function) => {
                    let (fields, errors) = self.function_contract(&function, module);
                    (CallTarget::Function { function }, fields, errors)
                }
                Resolved::Transition { resource, action } => {
                    let mut fields = vec!["id".to_string(), "expectedVersion".to_string()];
                    fields.extend(self.transition_input_fields(&resource, &action, module));
                    (
                        CallTarget::Transition { resource, action },
                        fields,
                        vec!["InvalidTransition".into(), "VersionConflict".into()],
                    )
                }
                _ => {
                    self.err(
                        "E-USE-001",
                        file,
                        range_of(&t),
                        format!("`{}` is not callable from a workflow step", t.text()),
                        None,
                    );
                    return None;
                }
            };
        let param_types: Vec<(String, TypeSpec)> = match &target {
            CallTarget::Function { function } => self.function_input_types(function, module),
            CallTarget::Transition { .. } => vec![], // id/expectedVersion/action inputs are checked at runtime by the transition contract
        };
        let mut args = Vec::new();
        for a in c.args() {
            let (Some(n), Some(v)) = (a.name(), a.value()) else {
                continue;
            };
            if !allowed.iter().any(|x| x == n.text()) {
                let sugg = suggest(n.text(), allowed.iter().map(|s| s.as_str()))
                    .map(|s| format!("did you mean `{s}`?"));
                self.err(
                    "E-WF-006",
                    file,
                    tok_range(&n),
                    format!("`{}` does not accept an argument `{}`", t.text(), n.text()),
                    sugg,
                );
                continue;
            }
            // PAR-118: the callee's declared type decides; a Forge reference never satisfies a foreign
            // identifier (`text`) by structural coincidence, and scalar families must agree.
            if let Some((_, expected)) = param_types.iter().find(|(name, _)| name == n.text())
                && let Some(actual) = self.workflow_expr_type(&v, module, scope)
                && let Some(why) = type_mismatch(expected, &actual, module, &self.pkg.name)
            {
                self.err("E-WF-008", file, expr_range(&v), format!("argument `{}` of `{}` is `{}`; {why}", n.text(), t.text(), describe_type(expected)), Some("map it explicitly: pass a field of the right type (a mapping/external-id field) or the result of a reviewed resolver step".into()));
            }
            if let Some(value) = self.workflow_expr(&v, module, file, scope) {
                args.push(NamedArg {
                    name: n.text().to_string(),
                    value,
                });
            }
        }
        let mut catches = Vec::new();
        for k in c.catches() {
            let (Some(e), Some(then)) = (k.error(), k.then()) else {
                continue;
            };
            if !declared_errors.iter().any(|x| x == e.text()) {
                let sugg = suggest(e.text(), declared_errors.iter().map(|s| s.as_str()))
                    .map(|s| format!("did you mean `{s}`?"));
                self.err(
                    "E-WF-007",
                    file,
                    tok_range(&e),
                    format!("`{}` does not declare error `{}`", t.text(), e.text()),
                    sugg,
                );
                continue;
            }
            if let Some(then) = self.workflow_terminal(&then, module, file, scope) {
                catches.push(Catch {
                    error: e.text().to_string(),
                    then,
                });
            }
        }
        Some(Step::Call {
            id: sid.to_string(),
            target,
            args,
            catches,
        })
    }

    /// Typed input fields of a function, local or imported.
    fn function_input_types(&mut self, id: &str, module: &str) -> Vec<(String, TypeSpec)> {
        let local_prefix = format!("{}/{}/", self.pkg.name, module);
        if let Some(name) = id.strip_prefix(&local_prefix)
            && let Some(Symbol {
                decl: Declaration::Function(f),
                file,
                ..
            }) = self.sym(module, name)
        {
            let (f, file) = (f.clone(), *file);
            return f
                .input()
                .and_then(|n| self.type_ref_spec(&n, module, file))
                .map(|t| self.typed_fields_of(&t.base, module))
                .unwrap_or_default();
        }
        for d in self.deps.values() {
            if let Some(f) = d
                .modules
                .iter()
                .flat_map(|m| &m.functions)
                .find(|f| f.id == id)
            {
                let base = f.input.as_ref().map(|t| t.base.clone());
                return base
                    .map(|b| self.typed_fields_of(&b, module))
                    .unwrap_or_default();
            }
        }
        vec![]
    }

    fn function_output(&mut self, id: &str, module: &str) -> Option<TypeSpec> {
        let local_prefix = format!("{}/{}/", self.pkg.name, module);
        if let Some(name) = id.strip_prefix(&local_prefix)
            && let Some(Symbol {
                decl: Declaration::Function(f),
                file,
                ..
            }) = self.sym(module, name)
        {
            let (f, file) = (f.clone(), *file);
            return f
                .output()
                .and_then(|n| self.type_ref_spec(&n, module, file));
        }
        self.deps.values().find_map(|d| {
            d.modules
                .iter()
                .flat_map(|m| &m.functions)
                .find(|f| f.id == id)
                .and_then(|f| f.output.clone())
        })
    }

    /// Fields with their types for a shape, record/reference or message.
    fn typed_fields_of(&mut self, base: &TypeBase, module: &str) -> Vec<(String, TypeSpec)> {
        match base {
            TypeBase::Shape { id } => {
                let local_prefix = format!("{}/{}/", self.pkg.name, module);
                if let Some(name) = id.strip_prefix(&local_prefix)
                    && let Some(Symbol {
                        decl: Declaration::Shape(sh),
                        file,
                        ..
                    }) = self.sym(module, name)
                {
                    let (sh, file) = (sh.clone(), *file);
                    let saved = self.diags.len();
                    let out: Vec<(String, TypeSpec)> = sh
                        .fields()
                        .filter_map(|fd| self.field(&fd, module, file, None, &["immutable"]))
                        .map(|f| (f.name, f.ty))
                        .collect();

                    self.diags.truncate(saved); // reported once where the shape is lowered
                    return out;
                }
                self.deps
                    .values()
                    .find_map(|d| d.find_shape(id))
                    .map(|sh| {
                        sh.fields
                            .iter()
                            .map(|f| (f.name.clone(), f.ty.clone()))
                            .collect()
                    })
                    .unwrap_or_default()
            }
            TypeBase::Record { resource } | TypeBase::Reference { resource } => self
                .resource_fields(resource, module)
                .into_iter()
                .map(|f| (f.name, f.ty))
                .collect(),
            _ => vec![],
        }
    }

    /// Static type of a workflow expression when it is knowable (names through bindings, literals).
    fn workflow_expr_type(
        &mut self,
        e: &ast::Expr,
        module: &str,
        scope: &WfScope,
    ) -> Option<TypeSpec> {
        let scalar = |name: &str| TypeSpec {
            base: TypeBase::Scalar {
                name: name.into(),
                args: vec![],
            },
            optional: false,
            normalizers: vec![],
            constraints: vec![],
            purpose: None,
            data_class: None,
        };
        match e {
            ast::Expr::Literal(l) => Some(match literal_of(&l.text()) {
                Literal::Int(_) => scalar("integer"),
                Literal::Decimal(_) => scalar("decimal"),
                Literal::String(_) => scalar("text"),
                Literal::Bool(_) => scalar("boolean"),
                _ => return None,
            }),
            ast::Expr::Paren(p) => self.workflow_expr_type(&p.inner()?, module, scope),
            ast::Expr::Name(n) => {
                let path = n.segments();
                let head = path.first()?;
                let mut ty = scope.types.iter().rev().find(|(b, _)| b == head)?.1.clone();
                for seg in &path[1..] {
                    let fields = self.typed_fields_of(&ty.base, module);
                    ty = fields.into_iter().find(|(f, _)| f == seg)?.1;
                }
                Some(ty)
            }
            _ => None,
        }
    }

    /// (input field names, declared error names) of a function, local or imported.
    fn function_contract(&mut self, id: &str, module: &str) -> (Vec<String>, Vec<String>) {
        let local_prefix = format!("{}/{}/", self.pkg.name, module);
        if let Some(name) = id.strip_prefix(&local_prefix)
            && let Some(Symbol {
                decl: Declaration::Function(f),
                file,
                ..
            }) = self.sym(module, name)
        {
            let (f, file) = (f.clone(), *file);
            let fields = f
                .input()
                .and_then(|n| self.type_ref_spec(&n, module, file))
                .map(|t| self.fields_of_type(&t.base, module))
                .unwrap_or_default();
            return (
                fields,
                f.errors().iter().map(|t| t.text().to_string()).collect(),
            );
        }
        for d in self.deps.values() {
            if let Some(f) = d
                .modules
                .iter()
                .flat_map(|m| &m.functions)
                .find(|f| f.id == id)
            {
                let fields = f
                    .input
                    .as_ref()
                    .map(|t| self.fields_of_type(&t.base, module))
                    .unwrap_or_default();
                return (fields, f.errors.clone());
            }
        }
        (vec![], vec![])
    }

    fn transition_input_fields(
        &mut self,
        resource: &str,
        action: &str,
        module: &str,
    ) -> Vec<String> {
        let local_prefix = format!("{}/{}/", self.pkg.name, module);
        if let Some(name) = resource.strip_prefix(&local_prefix)
            && let Some(Symbol {
                decl: Declaration::Resource(r),
                ..
            }) = self.sym(module, name)
        {
            let r = r.clone();
            if let Some(lc) = r.lifecycle() {
                for t in lc.transitions() {
                    if t.action().is_some_and(|a| a.text() == action) {
                        return t
                            .input()
                            .map(|i| {
                                i.fields()
                                    .filter_map(|f| f.name().map(|n| n.text().to_string()))
                                    .collect()
                            })
                            .unwrap_or_default();
                    }
                }
            }
        }
        vec![]
    }

    // ------------------------------------------------------------ channels
    fn channel(
        &mut self,
        c: &ast::ChannelDecl,
        module: &str,
        file: usize,
        exported: bool,
    ) -> Option<Channel> {
        let name = c.name()?.text().to_string();
        let id = self.id(module, &name);
        let mut contract = None;
        let mut messages: Vec<Message> = Vec::new();
        if let Some(from) = c.from() {
            let segs = from.segments();
            match self.resolve(&segs, module, file, range_of(&from)) {
                Some(Resolved::Channel(up)) => {
                    contract = Some(up.clone());
                    if let Some(upc) = self.deps.values().find_map(|d| d.find_channel(&up)) {
                        messages = upc.messages.clone();
                    }
                    if c.messages().next().is_some() {
                        self.err("E-CH-002", file, range_of(c), "a channel declared `from` an upstream contract cannot declare its own messages", None);
                    }
                }
                Some(_) => self.err(
                    "E-USE-002",
                    file,
                    range_of(&from),
                    format!("`{}` is not a channel", from.text()),
                    None,
                ),
                None => {}
            }
        } else {
            for m in c.messages() {
                let Some(mn) = m.name() else { continue };
                let mut fields = Vec::new();
                for fd in m.fields() {
                    if let Some(f) = self.field(&fd, module, file, None, &[]) {
                        fields.push(f);
                    }
                }
                messages.push(Message {
                    name: mn.text().to_string(),
                    doc: m.doc(),
                    fields,
                });
            }
            messages.sort_by(|a, b| a.name.cmp(&b.name));
        }
        let mut websocket = None;
        for d in c.decorators() {
            let Some(n) = d.name() else { continue };
            match n.text() {
                "websocket" => {
                    let path = d.args().first().and_then(|a| a.value()).and_then(|v| {
                        if let ArgValue::Literal(p) = v {
                            Some(unq(&p))
                        } else {
                            None
                        }
                    });
                    match path {
                        Some(p) if p.starts_with('/') => websocket = Some(WebSocketBinding { path: p }),
                        _ => self.err("E-DEC-002", file, range_of(&d), "`@websocket` requires a path literal, e.g. `@websocket(\"/v1/live/orders\")`", None),
                    }
                }
                "label" => {}
                other => self.err(
                    "E-DEC-001",
                    file,
                    tok_range(&n),
                    format!("unknown channel decorator `@{other}`"),
                    Some("channels accept `@websocket(path)` and `@label`".into()),
                ),
            }
        }
        Some(Channel {
            id,
            name,
            exported,
            contract,
            distribution: c.distribution().unwrap_or_else(|| "broadcast".into()),
            delivery: c.delivery().unwrap_or_else(|| "at-least-once".into()),
            direction: c.direction(),
            messages,
            websocket,
        })
    }

    // ------------------------------------------------------------ build
    fn build(&mut self) -> DomainIR {
        let mut modules: BTreeMap<String, Module> = BTreeMap::new();
        let keys: Vec<(String, String)> = self.symbols.keys().cloned().collect();
        for (module, name) in keys {
            let (kind, exported, file, decl) = {
                let s = &self.symbols[&(module.clone(), name.clone())];
                (s.kind, s.exported, s.file, s.decl.clone())
            };
            let m = modules.entry(module.clone()).or_insert_with(|| Module {
                id: module.clone(),
                ..Default::default()
            });
            let id = format!("{}/{}/{}", self.pkg.name, module, name);
            let mut extra_enums = Vec::new();
            match (kind, &decl) {
                (SymKind::Enum, Declaration::Enum(e)) => {
                    let mut members = Vec::new();
                    let mut values: BTreeMap<String, String> = BTreeMap::new();
                    for mem in e.members() {
                        let Some(n) = mem.name() else { continue };
                        let value = mem.value().unwrap_or_else(|| n.text().to_string());
                        if let Some(prev) = values.get(&value) {
                            self.err(
                                "E-ENUM-001",
                                file,
                                range_of(&mem),
                                format!("wire value `{value}` is already used by member `{prev}`"),
                                None,
                            );
                        }
                        values.insert(value.clone(), n.text().to_string());
                        members.push(EnumMember {
                            name: n.text().to_string(),
                            value,
                            doc: mem.doc(),
                        });
                    }
                    m.enums.push(EnumDecl {
                        id,
                        name,
                        exported,
                        synthesized: false,
                        doc: decl.doc(),
                        members,
                    });
                }
                (SymKind::Type, Declaration::Type(t)) => {
                    let mut data_class = None;
                    for dec in t.decorators() {
                        let Some(n) = dec.name() else { continue };
                        if n.text() == "data" {
                            self.require_edition_2027(file, tok_range(&n), "`@data`");
                            if let Some(ArgValue::Name(segs)) =
                                dec.args().first().and_then(|a| a.value())
                            {
                                data_class =
                                    self.resolve_data_class(&segs, &module, file, range_of(&dec));
                            } else {
                                self.err(
                                    "E-DEC-002",
                                    file,
                                    range_of(&dec),
                                    "`@data` requires a data class name",
                                    None,
                                );
                            }
                        } else if n.text() != "label" {
                            self.err(
                                "E-DEC-001",
                                file,
                                tok_range(&n),
                                format!("unknown type decorator `@{}`", n.text()),
                                None,
                            );
                        }
                    }
                    if let Some(te) = t.type_expr()
                        && let Some(mut ty) = self.type_spec(&te, &module, file)
                    {
                        ty.data_class = data_class.clone();
                        m.types.push(TypeAlias {
                            id,
                            name,
                            exported,
                            ty,
                            data_class,
                        });
                    }
                }
                (SymKind::Purpose, Declaration::Purpose(p)) => {
                    self.require_edition_2027(file, range_of(p), "`purpose`");
                    let extends = match p.extends() {
                        Some(q) => self.resolve_purpose(&q.segments(), &module, file, range_of(&q)),
                        None => None,
                    };
                    m.purposes.push(Purpose {
                        id,
                        name,
                        exported,
                        doc: decl.doc(),
                        extends,
                    });
                }
                (SymKind::DataClass, Declaration::DataClass(d)) => {
                    self.require_edition_2027(file, range_of(d), "`dataClass`");
                    let extends = d.extends().map(|q| q.text()).unwrap_or_default();
                    if Taxonomy::core().node(&extends).is_none() {
                        self.err("E-GOV-006", file, range_of(d), format!("data class `{name}` must extend a known taxonomy node (got `{extends}`)"), None);
                    }
                    m.data_classes.push(DataClass {
                        id,
                        name,
                        exported,
                        doc: decl.doc(),
                        extends,
                    });
                }
                (SymKind::Facet, Declaration::Facet(s)) => {
                    self.require_edition_2027(file, range_of(s), "`facet`");
                    let fields = self.facet_fields(s, &module, file);
                    m.facets.push(Shape {
                        id,
                        name,
                        exported,
                        doc: decl.doc(),
                        fields,
                    });
                }
                (SymKind::Shape, Declaration::Shape(s)) => {
                    let mut fields = Vec::new();
                    for fd in s.fields() {
                        if let Some(f) = self.field(&fd, &module, file, None, &["immutable"]) {
                            fields.push(f);
                        }
                    }
                    m.shapes.push(Shape {
                        id,
                        name,
                        exported,
                        doc: decl.doc(),
                        fields,
                    });
                }
                (SymKind::Resource, Declaration::Resource(r)) => {
                    if let Some(res) =
                        self.resource(r, &module, file, exported, &mut extra_enums, None)
                    {
                        m.resources.push(res);
                    }
                }
                (SymKind::Blob, Declaration::Blob(b)) => {
                    if let Some(res) = self.resource(
                        &b.as_resource(),
                        &module,
                        file,
                        exported,
                        &mut extra_enums,
                        Some(b),
                    ) {
                        m.resources.push(res);
                    }
                }
                (SymKind::Function, Declaration::Function(f)) => {
                    if let Some(func) = self.function(f, &module, file, exported) {
                        m.functions.push(func);
                    }
                }
                (SymKind::View, Declaration::View(q))
                | (SymKind::Projection, Declaration::Projection(q)) => {
                    if let Some(item) =
                        self.query_decl(q, &module, file, exported, kind == SymKind::Projection)
                    {
                        match item {
                            QueryItem::View(v) => m.views.push(v),
                            QueryItem::Projection(p) => m.projections.push(p),
                        }
                    }
                }
                (SymKind::Cache, Declaration::Cache(c)) => {
                    if let Some(cache) = self.cache(c, &module, file, exported) {
                        m.caches.push(cache);
                    }
                }
                (SymKind::Channel, Declaration::Channel(c)) => {
                    if let Some(ch) = self.channel(c, &module, file, exported) {
                        m.channels.push(ch);
                    }
                }
                (SymKind::Actor, Declaration::Actor(actor)) => {
                    let states: Vec<_> = actor
                        .items()
                        .filter(|item| item.kind().as_deref() == Some("state"))
                        .collect();
                    if states.len() != 1 {
                        self.err(
                            "E-ACTOR-001",
                            file,
                            range_of(actor),
                            "actor requires exactly one typed state",
                            None,
                        );
                        continue;
                    }
                    let Some(target) = states[0].target() else {
                        continue;
                    };
                    let Some(state) = self.type_ref_spec(&target, &module, file) else {
                        continue;
                    };
                    if !matches!(state.base, TypeBase::Shape { .. }) {
                        self.err(
                            "E-ACTOR-001",
                            file,
                            range_of(actor),
                            "actor state must be a shape",
                            None,
                        );
                    }
                    let mut messages = BTreeMap::new();
                    let mut handlers = BTreeMap::new();
                    for item in actor
                        .items()
                        .filter(|item| item.kind().as_deref() == Some("on"))
                    {
                        let (Some(command), Some(target)) = (item.command(), item.target()) else {
                            continue;
                        };
                        let Some(Resolved::Function(function)) =
                            self.resolve(&target.segments(), &module, file, range_of(&target))
                        else {
                            self.err(
                                "E-ACTOR-002",
                                file,
                                range_of(&item),
                                "actor handler must be a function",
                                None,
                            );
                            continue;
                        };
                        let fields = self.function_input_types(&function, &module);
                        if fields.is_empty() {
                            self.err(
                                "E-ACTOR-002",
                                file,
                                range_of(&item),
                                "actor handler needs a typed input shape",
                                None,
                            );
                            continue;
                        }
                        let Some(output) = self.function_output(&function, &module) else {
                            self.err(
                                "E-ACTOR-002",
                                file,
                                range_of(&item),
                                "actor handler must return its state shape",
                                None,
                            );
                            continue;
                        };
                        if output.base != state.base {
                            self.err(
                                "E-ACTOR-002",
                                file,
                                range_of(&item),
                                "actor handler output must match actor state",
                                None,
                            );
                        }
                        let input = self
                            .sym(&module, function.rsplit('/').next().unwrap_or_default())
                            .and_then(|s| {
                                if let Declaration::Function(f) = &s.decl {
                                    f.input()
                                } else {
                                    None
                                }
                            });
                        let Some(input) = input.and_then(|n| self.type_ref_spec(&n, &module, file))
                        else {
                            self.err(
                                "E-ACTOR-002",
                                file,
                                range_of(&item),
                                "actor handler must be local with a typed input",
                                None,
                            );
                            continue;
                        };
                        if messages.insert(command.clone(), input).is_some() {
                            self.err(
                                "E-ACTOR-003",
                                file,
                                range_of(&item),
                                "duplicate actor command",
                                None,
                            );
                        }
                        handlers.insert(command, function);
                    }
                    if messages.is_empty() {
                        self.err(
                            "E-ACTOR-002",
                            file,
                            range_of(actor),
                            "actor needs at least one command",
                            None,
                        );
                    }
                    m.actors.push(Actor {
                        id,
                        key: actor.key().unwrap_or_default(),
                        state,
                        messages,
                        handlers,
                    });
                }
                (SymKind::WorkQueue, Declaration::WorkQueue(q)) => {
                    let mut queue = WorkQueue {
                        id,
                        name,
                        execute: String::new(),
                        lease_ms: 90_000,
                        max_attempts: 3,
                        max_tasks: 128,
                        max_runners: 64,
                    };
                    let mut seen = BTreeSet::new();
                    for item in q.items() {
                        let key = item.key().unwrap_or_default();
                        if !seen.insert(key.clone()) {
                            self.err(
                                "E-QUEUE-001",
                                file,
                                range_of(&item),
                                "duplicate queue setting",
                                None,
                            );
                        }
                        if key == "execute" {
                            if let Some(target) = item.target() {
                                if let Some(Resolved::Function(function)) = self.resolve(
                                    &target.segments(),
                                    &module,
                                    file,
                                    range_of(&target),
                                ) {
                                    queue.execute = function;
                                } else {
                                    self.err(
                                        "E-QUEUE-001",
                                        file,
                                        range_of(&item),
                                        "queue execute must name a function",
                                        None,
                                    );
                                }
                            }
                        } else {
                            let text = item.value().unwrap_or_default();
                            let number = if key == "lease" {
                                text.strip_suffix("ms")
                                    .and_then(|s| s.parse::<u32>().ok())
                                    .or_else(|| {
                                        text.strip_suffix('s')
                                            .and_then(|s| s.parse::<u32>().ok())
                                            .and_then(|n| n.checked_mul(1000))
                                    })
                            } else {
                                text.parse::<u32>().ok()
                            }
                            .unwrap_or(0);
                            match key.as_str() {
                                "lease" => queue.lease_ms = number,
                                "retry" => queue.max_attempts = number,
                                "capacity" => queue.max_tasks = number,
                                "runners" => queue.max_runners = number,
                                _ => {}
                            }
                        }
                    }
                    if queue.execute.is_empty()
                        || !(1000..=300000).contains(&queue.lease_ms)
                        || !(1..=10).contains(&queue.max_attempts)
                        || !(1..=128).contains(&queue.max_tasks)
                        || !(1..=64).contains(&queue.max_runners)
                    {
                        self.err("E-QUEUE-002",file,range_of(q),"queue needs execute, lease 1s..300s, retry 1..10, capacity 1..128 and runners 1..64",None);
                    }
                    m.work_queues.push(queue);
                }
                (SymKind::Workflow, Declaration::Workflow(w)) => {
                    if let Some(wf) = self.workflow(w, &module, file, exported) {
                        m.workflows.push(wf);
                    }
                }
                (SymKind::Source, Declaration::Source(s)) => {
                    let target = s.target();
                    let Some(t) = target else {
                        self.err(
                            "E-SRC-002",
                            file,
                            range_of(s),
                            "a source must declare a target with `-> Function`",
                            None,
                        );
                        continue;
                    };
                    let segs = t.segments();
                    let Some(Resolved::Function(target_id)) =
                        self.resolve(&segs, &module, file, range_of(&t))
                    else {
                        continue;
                    };
                    if let Some(cron) = s.cron()
                        && let Err(e) = crate::cron::validate(&cron)
                    {
                        self.err(
                            "E-SRC-001",
                            file,
                            range_of(s),
                            format!("invalid cron expression `{cron}`: {e}"),
                            None,
                        );
                    }
                    if let Some(tz) = s.timezone()
                        && !crate::cron::known_timezone(&tz)
                    {
                        self.err("E-SRC-003", file, range_of(s), format!("unknown timezone `{tz}`; use an IANA name such as `UTC` or `America/New_York`"), None);
                    }
                    m.sources.push(Source {
                        id,
                        name,
                        cron: s.cron(),
                        timezone: s.timezone(),
                        target: target_id,
                    });
                }
                _ => {}
            }
            let m = modules.get_mut(&module).unwrap();
            m.enums.extend(extra_enums);
        }
        // subscriptions
        for fi in 0..self.files.len() {
            let module = self.files[fi].module.clone();
            let subs: Vec<ast::SubscriptionDecl> = self.files[fi]
                .parse
                .root()
                .declarations()
                .filter_map(|d| {
                    if let Declaration::Subscription(s) = d {
                        Some(s)
                    } else {
                        None
                    }
                })
                .collect();
            for s in subs {
                let (Some(msg), Some(handler)) = (s.message(), s.handler()) else {
                    continue;
                };
                let Some(Resolved::Type(TypeBase::Message { channel, message })) =
                    self.resolve(&msg.segments(), &module, fi, range_of(&msg))
                else {
                    continue;
                };
                let Some(Resolved::Function(h)) =
                    self.resolve(&handler.segments(), &module, fi, range_of(&handler))
                else {
                    continue;
                };
                // handler input must be the message type
                let input = modules
                    .values()
                    .flat_map(|m| m.functions.iter())
                    .find(|f| f.id == h)
                    .and_then(|f| f.input.clone());
                match input {
                    Some(TypeSpec {
                        base:
                            TypeBase::Message {
                                channel: c2,
                                message: m2,
                            },
                        ..
                    }) if c2 == channel && m2 == message => {}
                    _ => self.err(
                        "E-SUB-001",
                        fi,
                        range_of(&s),
                        format!(
                            "handler `{}` must take `{}` as its input",
                            handler.text(),
                            msg.text()
                        ),
                        None,
                    ),
                }
                modules
                    .entry(module.clone())
                    .or_insert_with(|| Module {
                        id: module.clone(),
                        ..Default::default()
                    })
                    .subscriptions
                    .push(Subscription {
                        channel,
                        message,
                        handler: h,
                    });
            }
        }
        // mark generated functions: none yet at this layer (CRUD operations live on resources)
        let mut modules: Vec<Module> = modules.into_values().collect();
        for m in &mut modules {
            m.enums.sort_by(|a, b| a.id.cmp(&b.id));
            m.types.sort_by(|a, b| a.id.cmp(&b.id));
            m.facets.sort_by(|a, b| a.id.cmp(&b.id));
            m.facet_origins = self
                .facet_origins
                .iter()
                .filter(|(key, _)| key.starts_with(&format!("{}/{}/", self.pkg.name, m.id)))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            m.shapes.sort_by(|a, b| a.id.cmp(&b.id));
            m.resources.sort_by(|a, b| a.id.cmp(&b.id));
            m.functions.sort_by(|a, b| a.id.cmp(&b.id));
            m.channels.sort_by(|a, b| a.id.cmp(&b.id));
            m.sources.sort_by(|a, b| a.id.cmp(&b.id));
            m.subscriptions.sort_by(|a, b| {
                (&a.channel, &a.message, &a.handler).cmp(&(&b.channel, &b.message, &b.handler))
            });
            m.views.sort_by(|a, b| a.id.cmp(&b.id));
            m.projections.sort_by(|a, b| a.id.cmp(&b.id));
            m.caches.sort_by(|a, b| a.id.cmp(&b.id));
        }
        let mut imports: Vec<Import> = self
            .pkg
            .dependencies
            .iter()
            .map(|(alias, package)| Import {
                alias: alias.clone(),
                package: package.clone(),
            })
            .collect();
        imports.sort_by(|a, b| a.alias.cmp(&b.alias));
        let mut requires = if self.pkg.edition == "2027"
            && modules.iter().any(|m| {
                !m.purposes.is_empty()
                    || !m.data_classes.is_empty()
                    || m.resources
                        .iter()
                        .any(|r| !r.capabilities.is_empty() || r.decorators.purpose_scoped)
            }) {
            vec!["governance/1".into()]
        } else {
            vec![]
        };
        if modules.iter().any(|m| {
            m.resources
                .iter()
                .any(|r| r.uniques.iter().any(|u| u.condition.is_some()))
        }) {
            requires.push("conditional-unique/1".into());
            requires.sort();
        }
        if modules.iter().any(|m| {
            m.projections.iter().any(|p| {
                p.aggregates
                    .iter()
                    .any(|a| a.filter.is_some() || !matches!(a.function.as_str(), "count" | "sum"))
            })
        }) {
            requires.push("projection-aggregates/1".into());
            requires.sort();
        }
        if self.files.iter().any(|f| {
            f.parse
                .syntax()
                .descendants()
                .filter_map(ast::TypeRef::cast)
                .any(|t| !t.element_types().is_empty())
        }) {
            requires.push("collections/1".into());
            requires.sort();
        }
        if self.files.iter().any(|f| {
            f.parse
                .syntax()
                .descendants()
                .any(|n| ast::StepMap::cast(n).is_some())
        }) {
            requires.push("workflow-map/1".into());
            requires.sort();
        }
        if modules.iter().any(|m| {
            m.resources
                .iter()
                .any(|r| r.fields.iter().any(|f| f.sequence.is_some()))
        }) {
            requires.push("sequences/1".into());
            requires.sort();
        }
        if modules
            .iter()
            .any(|m| m.resources.iter().any(|r| r.decorators.append_only))
        {
            requires.push("append-only/1".into());
            requires.sort();
        }
        if modules
            .iter()
            .any(|m| m.resources.iter().any(|r| r.decorators.write_once))
        {
            requires.push("sealed-content/1".into());
            requires.sort();
        }
        if modules.iter().any(|m| !m.work_queues.is_empty()) {
            requires.push("work-queues/1".into());
            requires.sort();
        }
        if modules.iter().any(|m| {
            m.resources
                .iter()
                .any(|r| r.fields.iter().any(|f| f.secret))
        }) {
            requires.push("credentials/1".into());
            requires.sort();
        }
        if modules.iter().any(|m| {
            m.resources
                .iter()
                .any(|r| r.lists.iter().any(|l| l.search_mode.is_some()))
        }) {
            requires.push("search-exact/1".into());
            requires.sort();
        }
        if modules.iter().any(|m| !m.actors.is_empty()) {
            requires.push("actors/1".into());
            requires.sort();
        }
        DomainIR {
            version: DOMAIN_IR_VERSION.into(),
            requires,
            package: PackageInfo {
                name: self.pkg.name.clone(),
                version: self.pkg.version.clone(),
                edition: self.pkg.edition.clone(),
                profile: self.pkg.profile.clone(),
                targets: self.pkg.targets.clone(),
                observability: self.pkg.observability.clone(),
            },
            imports,
            modules,
        }
    }
}

/// Server-owned upload lifecycle metadata every blob carries (plan §13).
fn blob_fields() -> Vec<Field> {
    let scalar = |n: &str, optional: bool| TypeSpec {
        base: TypeBase::Scalar {
            name: n.into(),
            args: vec![],
        },
        optional,
        normalizers: vec![],
        constraints: vec![],
        purpose: None,
        data_class: None,
    };
    let mk = |name: &str, ty: TypeSpec, hidden: bool| Field {
        name: name.into(),
        ty,
        default: None,
        derived: None,
        sequence: None,
        secret: false,
        immutable: false,
        server_owned: true,
        synthesized: true,
        hidden,
        doc: None,
    };
    vec![
        mk("uploadState", scalar("text", false), false), // intent | uploading | uploaded | verifying | ready | rejected
        mk("mediaType", scalar("text", true), false),
        mk("byteCount", scalar("integer", true), false),
        mk("digest", scalar("text", true), false),
        // private staging/sealing bookkeeping
        mk("uploadAttempt", scalar("integer", true), true),
        mk("stagedMediaType", scalar("text", true), true),
        mk("stagedByteCount", scalar("integer", true), true),
        mk("contentGeneration", scalar("integer", true), true),
        mk("sealedGeneration", scalar("text", true), true),
    ]
}

enum QueryItem {
    View(View),
    Projection(Projection),
}

impl<'a> Ctx<'a> {
    /// Resolve a `from` source to a local resource id and its fields.
    fn source_resource(
        &mut self,
        q: &ast::QueryDecl,
        module: &str,
        file: usize,
    ) -> Option<(String, Vec<Field>)> {
        let from = match q.from() {
            Some(f) => f,
            None => {
                self.err(
                    "E-QRY-003",
                    file,
                    range_of(q),
                    "a view or projection needs `from <Resource>`",
                    None,
                );
                return None;
            }
        };
        match self.resolve(&from.segments(), module, file, range_of(&from))? {
            Resolved::Type(TypeBase::Reference { resource }) => {
                let fields = self.resource_fields(&resource, module);
                Some((resource, fields))
            }
            _ => {
                self.err(
                    "E-QRY-003",
                    file,
                    range_of(&from),
                    format!("`{}` is not a resource", from.text()),
                    None,
                );
                None
            }
        }
    }

    fn query_decl(
        &mut self,
        q: &ast::QueryDecl,
        module: &str,
        file: usize,
        exported: bool,
        is_projection: bool,
    ) -> Option<QueryItem> {
        let name = q.name()?.text().to_string();
        let id = self.id(module, &name);
        let (source, fields) = self.source_resource(q, module, file)?;
        let names: Vec<String> = fields.iter().map(|f| f.name.clone()).collect();
        let check = |this: &mut Self, f: &str, what: &str| {
            if !names.contains(&f.to_string()) {
                this.err(
                    "E-QRY-002",
                    file,
                    range_of(q),
                    format!("unknown field `{f}` in `{what}`"),
                    suggest(f, names.iter().map(|s| s.as_str()))
                        .map(|s| format!("did you mean `{s}`?")),
                );
            }
        };
        let by = q.by();
        for f in &by {
            check(self, f, "by");
        }
        let filter = match q.where_expr() {
            Some(e) => self.expr(&e, module, file, Some(&source)),
            None => None,
        };
        let mut crud = None;
        for d in q.decorators() {
            let Some(n) = d.name() else { continue };
            match n.text() {
                "crud" if is_projection => {
                    if let Some(ArgValue::Literal(p)) = d.args().first().and_then(|a| a.value()) {
                        crud = Some(CrudBinding {
                            path: unq(&p),
                            operations: Some(vec!["get".into(), "list".into()]),
                            actions: vec![],
                        });
                    } else {
                        self.err(
                            "E-DEC-002",
                            file,
                            range_of(&d),
                            "`@crud` requires a route path",
                            None,
                        );
                    }
                }
                "http" if !is_projection => {}
                other => self.err(
                    "E-DEC-001",
                    file,
                    tok_range(&n),
                    format!("unknown decorator `@{other}` here"),
                    None,
                ),
            }
        }
        if is_projection {
            let aggregates: Vec<Aggregate> = q
                .aggregates()
                .into_iter()
                .map(|(function, field, alias, predicate)| {
                    if !matches!(function.as_str(), "count" | "exists" | "notExists") {
                        check(self, &field, &function);
                    }
                    let scale = fields.iter().find(|f| f.name == field).and_then(|f| match &f.ty.base {
                        TypeBase::Scalar { name, args } if name == "money" => Some(match args.first().map(|s| s.as_str()) { Some("JPY" | "KRW" | "CLP") => 0, Some("KWD" | "BHD") => 3, _ => 2 }),
                        TypeBase::Scalar { name, args } if name == "decimal" => args.first().and_then(|a| a.parse().ok()).or(Some(2)),
                        _ => None,
                    });
                    if function == "sum" && !fields.iter().any(|f|f.name == field && matches!(&f.ty.base,TypeBase::Scalar {name,..} if matches!(name.as_str(),"integer"|"decimal"|"money"))) {
                        self.err("E-PROJ-004",file,range_of(q),"sum requires an integer, decimal or money field",None);
                    }
                    if matches!(function.as_str(),"min"|"max"|"latest") && !fields.iter().any(|f|f.name == field && matches!(&f.ty.base,TypeBase::Scalar {name,..} if matches!(name.as_str(),"integer"|"decimal"|"money"|"date"|"datetime"))) {
                        self.err("E-PROJ-004",file,range_of(q),"min/max/latest requires a numeric, date or datetime field",None);
                    }
                    let filter = predicate.as_ref().and_then(|e|self.expr(e,module,file,Some(&source)));
                    Aggregate { function, field, alias, scale, filter }
                })
                .collect();
            let mut aliases = BTreeSet::new();
            for aggregate in &aggregates {
                if !aliases.insert(&aggregate.alias)
                    || by.contains(&aggregate.alias)
                    || aggregate.alias == "generation"
                {
                    self.err(
                        "E-PROJ-005",
                        file,
                        range_of(q),
                        format!(
                            "aggregate alias `{}` collides with another result field",
                            aggregate.alias
                        ),
                        None,
                    );
                }
            }
            if by.is_empty() {
                self.err("E-PROJ-001", file, range_of(q), "a projection must group with `by <fields>`; ungrouped aggregates need a bounded working set", Some("add `by <field>`".into()));
            }
            if aggregates.is_empty() {
                self.err(
                    "E-PROJ-003",
                    file,
                    range_of(q),
                    "a projection needs at least one aggregate (count, sum, min, max)",
                    None,
                );
            }
            Some(QueryItem::Projection(Projection {
                id,
                name,
                exported,
                doc: ast::doc_of(q.syntax()),
                source,
                by,
                filter,
                aggregates,
                crud,
            }))
        } else {
            let mut out_fields = q.fields();
            for f in &out_fields {
                check(self, f, "fields");
            }
            if out_fields.is_empty() {
                out_fields = names.clone();
            }
            if !out_fields.contains(&"id".to_string()) {
                out_fields.insert(0, "id".into());
            }
            let mut order: Vec<OrderKey> = q
                .order()
                .into_iter()
                .map(|(field, direction)| OrderKey { field, direction })
                .collect();
            for o in &order {
                check(self, &o.field, "order by");
            }
            if !order.iter().any(|o| o.field == "id") {
                let dir = order
                    .last()
                    .map(|o| o.direction.clone())
                    .unwrap_or_else(|| "asc".into());
                order.push(OrderKey {
                    field: "id".into(),
                    direction: dir,
                });
            }
            if by.is_empty() {
                self.err("E-QRY-004", file, range_of(q), "a view must be bounded with `by <fields>` (an equality partition); unbounded views become scans", None);
            }
            Some(QueryItem::View(View {
                id,
                name,
                exported,
                doc: ast::doc_of(q.syntax()),
                source,
                by,
                filter,
                order,
                fields: out_fields,
                http: None,
            }))
        }
    }

    fn cache(
        &mut self,
        c: &ast::CacheDecl,
        module: &str,
        file: usize,
        exported: bool,
    ) -> Option<Cache> {
        let name = c.name()?.text().to_string();
        let id = self.id(module, &name);
        let mut keys = Vec::new();
        for k in c.keys() {
            if let Some(f) = self.field(&k, module, file, None, &[]) {
                keys.push(f);
            }
        }
        if keys.is_empty() {
            self.err(
                "E-CACHE-001",
                file,
                range_of(c),
                "a cache needs at least one `key`",
                None,
            );
        }
        let loader = match c.loader() {
            Some(e) => self.expr(&e, module, file, None)?,
            None => {
                self.err(
                    "E-CACHE-002",
                    file,
                    range_of(c),
                    "a cache needs a `loader`",
                    None,
                );
                return None;
            }
        };
        // Loader must be a call to a resource operation or function; validate the callee resolves.
        if let Expr::Call { callee, .. } = &loader {
            let (head, rest) = (
                callee.first().cloned().unwrap_or_default(),
                &callee[1.min(callee.len())..],
            );
            let ok = self
                .sym(module, &head)
                .is_some_and(|s| matches!(s.kind, SymKind::Resource | SymKind::Function))
                && (rest.is_empty()
                    || matches!(rest[0].as_str(), "effective" | "get" | "find" | "list"));
            if !ok {
                self.err(
                    "E-CACHE-003",
                    file,
                    range_of(c),
                    format!(
                        "loader `{}` must call a resource query or a function",
                        callee.join(".")
                    ),
                    None,
                );
            }
        } else {
            self.err(
                "E-CACHE-003",
                file,
                range_of(c),
                "loader must be a call",
                None,
            );
        }
        let mut fresh_until = None;
        let mut stale_until = None;
        for (kind, e) in c.freshness() {
            let ir = self.expr(&e, module, file, None);
            if kind == "freshUntil" {
                fresh_until = ir;
            } else {
                stale_until = ir;
            }
        }
        let Some(fresh_until) = fresh_until else {
            self.err(
                "E-CACHE-004",
                file,
                range_of(c),
                "a cache needs an explicit `freshUntil`",
                None,
            );
            return None;
        };
        Some(Cache {
            id,
            name,
            exported,
            doc: ast::doc_of(c.syntax()),
            keys,
            loader,
            fresh_until,
            stale_until,
        })
    }
}

fn short(id: &str) -> &str {
    id.rsplit('/').next().unwrap_or(id)
}
fn unq(s: &str) -> String {
    if s.starts_with('"') {
        ast::unquote(s)
    } else {
        s.to_string()
    }
}
/// Scalar families for argument compatibility; `json` accepts anything.
fn scalar_family(name: &str) -> &'static str {
    match name {
        "text" | "email" | "url" | "countryCode" | "timezone" | "localTime" => "text",
        "integer" | "decimal" | "money" => "number",
        "boolean" => "boolean",
        "date" => "date",
        "datetime" => "datetime",
        "duration" => "duration",
        "id" => "id",
        _ => "json",
    }
}

fn short_id(id: &str) -> String {
    id.rsplit('/').next().unwrap_or(id).to_string()
}

fn describe_type(t: &TypeSpec) -> String {
    match &t.base {
        TypeBase::Scalar { name, .. } => name.clone(),
        TypeBase::Enum { id } => format!("enum {}", short_id(id)),
        TypeBase::Shape { id } => format!("shape {}", short_id(id)),
        TypeBase::Reference { resource } => format!("reference to {}", short_id(resource)),
        TypeBase::Record { resource } => format!("{}.Record", short_id(resource)),
        TypeBase::Identity { resource } => format!("{}.Identity", short_id(resource)),
        TypeBase::Status { resource } => format!("{}.Status", short_id(resource)),
        TypeBase::Collection {
            collection,
            element,
        } => format!("{collection:?}<{element:?}>"),
        TypeBase::Message { channel, message } => format!("{}.{message}", short_id(channel)),
    }
}

/// `Some(reason)` when `actual` cannot satisfy `expected`. Conservative: unknown combinations pass.
fn type_mismatch(
    expected: &TypeSpec,
    actual: &TypeSpec,
    _module: &str,
    _pkg: &str,
) -> Option<String> {
    use TypeBase::*;
    match (&expected.base, &actual.base) {
        (Scalar { name: e, .. }, Scalar { name: a, .. }) => {
            let (fe, fa) = (scalar_family(e), scalar_family(a));
            if fe == "json" || fe == fa || (fe == "number" && fa == "number") {
                None
            } else if fe == "text" && fa == "id" {
                Some(format!(
                    "`{}` is a Forge id; the callee wants its own identifier, and a Forge id that happens to be a string is not that identifier",
                    describe_type(actual)
                ))
            } else {
                Some(format!("the argument is `{}`", describe_type(actual)))
            }
        }
        (
            Scalar { name: e, .. },
            Reference { resource } | Record { resource } | Identity { resource },
        ) => {
            if scalar_family(e) == "json" {
                None
            } else {
                Some(format!(
                    "the argument is a Forge reference to `{}`; a reference is not a foreign identifier",
                    short_id(resource)
                ))
            }
        }
        (
            Reference { resource: e },
            Reference { resource: a } | Record { resource: a } | Identity { resource: a },
        ) => {
            if e == a {
                None
            } else {
                Some(format!(
                    "the argument refers to `{}`, not `{}`",
                    short_id(a),
                    short_id(e)
                ))
            }
        }
        (Reference { resource }, Scalar { name, .. }) => Some(format!(
            "a `{}` reference is required, the argument is `{name}`",
            short_id(resource)
        )),
        (Enum { id: e }, Enum { id: a }) => {
            if e == a {
                None
            } else {
                Some(format!("the argument is `enum {}`", short_id(a)))
            }
        }
        (Enum { .. }, Scalar { name, .. }) if scalar_family(name) != "text" => {
            Some(format!("the argument is `{name}`"))
        }
        _ => None,
    }
}

fn literal_of(text: &str) -> Literal {
    match text {
        "true" => Literal::Bool(true),
        "false" => Literal::Bool(false),
        "null" => Literal::Null,
        t if t.starts_with('"') => Literal::String(ast::unquote(t)),
        t if t.ends_with('%') => Literal::Percent(t.to_string()),
        t if t.chars().all(|c| c.is_ascii_digit()) => Literal::Int(t.to_string()),
        t if t.contains('.') && t.chars().all(|c| c.is_ascii_digit() || c == '.') => {
            Literal::Decimal(t.to_string())
        }
        t => Literal::Duration(t.to_string()),
    }
}

fn expr_range(e: &ast::Expr) -> (usize, usize) {
    let r = e.syntax().text_range();
    (r.start().into(), r.end().into())
}
