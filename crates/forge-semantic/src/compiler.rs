//! Semantic passes: collect symbols, resolve references, elaborate decorators
//! and lifecycles, run the required checks (plan §7.3), and emit DomainIR.

use crate::diagnostics::{line_col, suggest, Diagnostic, Severity};
use crate::ir::*;
use crate::package::{Package, SourceFile};
use forge_syntax::ast::{self, ArgValue, AstNode, Declaration, RefinementKind};
use forge_syntax::{parse, Parse};
use std::collections::{BTreeMap, BTreeSet};

pub const SCALARS: &[&str] = &[
    "id", "text", "integer", "decimal", "money", "boolean", "date", "datetime", "localTime", "duration", "email", "timezone", "countryCode", "url", "json",
];
const RESOURCE_DECORATORS: &[&str] = &["tenant", "timestamps", "softDelete", "versioned", "audited", "crud", "effectiveDated", "hierarchical", "label"];
const FIELD_DECORATORS: &[&str] = &["unique", "immutable", "label"];
const FUNCTION_DECORATORS: &[&str] = &["http", "label"];
const HTTP_METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE"];
const DEFAULT_MODULE: &str = "_";

pub struct Compilation {
    pub ir: Option<DomainIR>,
    pub diagnostics: Vec<Diagnostic>,
    files: Vec<SourceFile>,
}

impl Compilation {
    /// Stable, human-readable rendering: `severity[code]: file:line:col: message`.
    pub fn render(&self) -> String {
        let mut out = String::new();
        for d in &self.diagnostics {
            let text = self.files.iter().find(|f| f.path == d.file).map(|f| f.text.as_str()).unwrap_or("");
            let (line, col) = line_col(text, d.start);
            let sev = match d.severity {
                Severity::Error => "error",
                Severity::Warning => "warning",
            };
            out.push_str(&format!("{sev}[{}]: {}:{line}:{col}: {}\n", d.code, d.file, d.message));
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
    Resource,
    Function,
    Channel,
    Source,
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
}

#[derive(Debug, Clone, PartialEq)]
enum Resolved {
    Type(TypeBase),
    Function(String),
    Channel(String),
    Transition { resource: String, action: String },
}

pub fn compile(pkg: &Package, deps: &[&DomainIR]) -> Compilation {
    let mut files: Vec<&SourceFile> = pkg.files.iter().collect();
    files.sort_by_key(|a| norm_path(&a.path));

    let mut ctx = Ctx { pkg, deps: BTreeMap::new(), diags: Vec::new(), files: Vec::new(), symbols: BTreeMap::new(), imports: BTreeMap::new() };
    for (alias, name) in &pkg.dependencies {
        match deps.iter().find(|d| &d.package.name == name) {
            Some(d) => {
                ctx.deps.insert(alias.clone(), d);
            }
            None => ctx.diags.push(Diagnostic {
                code: "E-IMP-002".into(),
                severity: Severity::Error,
                message: format!("dependency `{alias}` (`{name}`) was not provided to the compiler"),
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
        let parse = parse(&f.text);
        for e in parse.errors() {
            ctx.diags.push(Diagnostic { code: "E-SYN-001".into(), severity: Severity::Error, message: e.message.clone(), file: path.clone(), start: e.range.start, end: e.range.end, suggestion: None });
        }
        let module = parse.root().declarations().find_map(|d| if let Declaration::Module(m) = d { m.path().map(|p| p.text()) } else { None }).unwrap_or_else(|| DEFAULT_MODULE.into());
        ctx.files.push(ParsedFile { path, parse, module });
    }

    // 2. collect symbols and imports
    ctx.collect();
    // 3. elaborate + check
    let ir = ctx.build();
    let has_errors = ctx.diags.iter().any(|d| d.is_error());
    ctx.diags.sort_by(|a, b| (&a.file, a.start, &a.code).cmp(&(&b.file, b.start, &b.code)));
    Compilation { ir: if has_errors { None } else { Some(ir) }, diagnostics: ctx.diags, files: files.into_iter().map(|f| SourceFile { path: norm_path(&f.path), text: f.text.clone() }).collect() }
}

fn norm_path(p: &str) -> String {
    p.replace('\\', "/")
}

fn range_of<N: AstNode>(n: &N) -> (usize, usize) {
    let r = n.range();
    (r.start().into(), r.end().into())
}
fn tok_range(t: &forge_syntax::SyntaxToken) -> (usize, usize) {
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
        s.push_str(&p.chars().flat_map(|c| if c.is_ascii_uppercase() { vec!['-', c.to_ascii_lowercase()] } else { vec![c] }).collect::<String>());
    }
    s
}

impl<'a> Ctx<'a> {
    fn err(&mut self, code: &str, file: usize, range: (usize, usize), msg: impl Into<String>, suggestion: Option<String>) {
        let severity = if code.starts_with('W') { Severity::Warning } else { Severity::Error };
        self.diags.push(Diagnostic { code: code.into(), severity, message: msg.into(), file: self.files[file].path.clone(), start: range.0, end: range.1, suggestion });
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
                    Declaration::Resource(_) => SymKind::Resource,
                    Declaration::Function(_) => SymKind::Function,
                    Declaration::Channel(_) => SymKind::Channel,
                    Declaration::Source(_) => SymKind::Source,
                    Declaration::Import(i) => {
                        let Some(path) = i.path() else { continue };
                        let alias = i.alias().map(|a| a.text().to_string()).unwrap_or_else(|| path.text());
                        if !self.deps.contains_key(&path.text()) {
                            let known: Vec<&str> = self.deps.keys().map(|s| s.as_str()).collect();
                            self.err("E-IMP-001", fi, range_of(&path), format!("`{}` is not a declared dependency in forge.toml", path.text()), suggest(&path.text(), known).map(|s| format!("did you mean `{s}`?")));
                        }
                        self.imports.entry(module.clone()).or_default().insert(alias);
                        continue;
                    }
                    Declaration::Module(_) | Declaration::Subscription(_) => continue,
                };
                let Some(name_tok) = d.name() else { continue };
                let name = name_tok.text().to_string();
                if SCALARS.contains(&name.as_str()) {
                    self.err("E-SYM-004", fi, tok_range(&name_tok), format!("`{name}` shadows a builtin type"), None);
                    continue;
                }
                let key = (module.clone(), name.clone());
                if self.symbols.contains_key(&key) {
                    self.err("E-SYM-002", fi, tok_range(&name_tok), format!("`{name}` is declared more than once in module `{module}`"), None);
                    continue;
                }
                self.symbols.insert(key, Symbol { kind, exported: d.is_exported(), file: fi, decl: d });
            }
        }
    }

    fn local_names(&self, module: &str) -> Vec<&str> {
        self.symbols.keys().filter(|(m, _)| m == module).map(|(_, n)| n.as_str()).collect()
    }
    fn sym(&self, module: &str, name: &str) -> Option<&Symbol> {
        self.symbols.get(&(module.to_string(), name.to_string()))
    }
    fn is_import(&self, module: &str, alias: &str) -> bool {
        self.imports.get(module).is_some_and(|s| s.contains(alias)) && self.deps.contains_key(alias)
    }

    // ------------------------------------------------------------ resolve
    /// Resolve a qualified name in type/value position.
    fn resolve(&mut self, segs: &[String], module: &str, file: usize, range: (usize, usize)) -> Option<Resolved> {
        let text = segs.join(".");
        match segs {
            [a] => {
                if SCALARS.contains(&a.as_str()) {
                    return Some(Resolved::Type(TypeBase::Scalar { name: a.clone(), args: vec![] }));
                }
                if let Some(s) = self.sym(module, a) {
                    let id = self.id(module, a);
                    return Some(match s.kind {
                        SymKind::Enum => Resolved::Type(TypeBase::Enum { id }),
                        SymKind::Shape => Resolved::Type(TypeBase::Shape { id }),
                        SymKind::Resource => Resolved::Type(TypeBase::Reference { resource: id }),
                        SymKind::Function => Resolved::Function(id),
                        SymKind::Channel => Resolved::Channel(id),
                        SymKind::Type => Resolved::Type(self.alias_base(module, a)),
                        SymKind::Source => {
                            self.err("E-SYM-005", file, range, format!("`{a}` is a source and cannot be used here"), None);
                            return None;
                        }
                    });
                }
                let mut cands: Vec<&str> = SCALARS.to_vec();
                cands.extend(self.local_names(module));
                let sugg = suggest(a, cands).map(|s| format!("did you mean `{s}`?"));
                self.err("E-SYM-001", file, range, format!("unknown name `{text}`"), sugg);
                None
            }
            [a, b] => {
                if let Some(s) = self.sym(module, a) {
                    let id = self.id(module, a);
                    match s.kind {
                        SymKind::Resource => {
                            return match b.as_str() {
                                "Record" => Some(Resolved::Type(TypeBase::Record { resource: id })),
                                "Id" => Some(Resolved::Type(TypeBase::Identity { resource: id })),
                                "Status" => Some(Resolved::Type(TypeBase::Status { resource: id })),
                                _ => {
                                    self.err("E-SYM-001", file, range, format!("unknown name `{text}`"), Some("resources expose `.Record`, `.Id` and `.Status`".into()));
                                    None
                                }
                            };
                        }
                        SymKind::Channel => {
                            let Declaration::Channel(c) = s.decl.clone() else { unreachable!() };
                            let (contract, messages) = self.channel_contract(&c, module, file);
                            if messages.iter().any(|m| m == b) {
                                return Some(Resolved::Type(TypeBase::Message { channel: contract, message: b.clone() }));
                            }
                            let sugg = suggest(b, messages.iter().map(|s| s.as_str())).map(|s| format!("did you mean `{a}.{s}`?"));
                            self.err("E-SYM-001", file, range, format!("channel `{a}` has no message `{b}`"), sugg);
                            return None;
                        }
                        _ => {}
                    }
                }
                if self.is_import(module, a) {
                    return self.resolve_in_dep(a, &segs[1..], file, range);
                }
                let sugg = suggest(a, self.local_names(module)).map(|s| format!("did you mean `{s}`?"));
                self.err("E-SYM-001", file, range, format!("unknown name `{text}`"), sugg);
                None
            }
            [a, b, c] => {
                if let Some(s) = self.sym(module, a)
                    && s.kind == SymKind::Resource && b == "status" {
                        let Declaration::Resource(r) = &s.decl else { unreachable!() };
                        let actions: Vec<String> = r.lifecycle().map(|l| l.transitions().filter_map(|t| t.action().map(|a| a.text().to_string())).collect()).unwrap_or_default();
                        if actions.iter().any(|x| x == c) {
                            return Some(Resolved::Transition { resource: self.id(module, a), action: c.clone() });
                        }
                        let sugg = suggest(c, actions.iter().map(|s| s.as_str())).map(|s| format!("did you mean `{a}.status.{s}`?"));
                        self.err("E-SYM-001", file, range, format!("resource `{a}` has no lifecycle action `{c}`"), sugg);
                        return None;
                    }
                if self.is_import(module, a) {
                    return self.resolve_in_dep(a, &segs[1..], file, range);
                }
                self.err("E-SYM-001", file, range, format!("unknown name `{text}`"), None);
                None
            }
            _ => {
                self.err("E-SYM-001", file, range, format!("unknown name `{text}`"), None);
                None
            }
        }
    }

    fn alias_base(&self, module: &str, name: &str) -> TypeBase {
        // A type alias contributes its base; refinements are merged by the caller.
        if let Some(Symbol { decl: Declaration::Type(t), .. }) = self.sym(module, name)
            && let Some(te) = t.type_expr()
                && let Some(n) = te.type_ref().and_then(|r| r.name()) {
                    let segs = n.segments();
                    if let [a] = segs.as_slice() {
                        if SCALARS.contains(&a.as_str()) {
                            return TypeBase::Scalar { name: a.clone(), args: te.type_ref().map(|r| r.args()).unwrap_or_default() };
                        }
                        if let Some(s) = self.sym(module, a) {
                            let id = self.id(module, a);
                            return match s.kind {
                                SymKind::Enum => TypeBase::Enum { id },
                                SymKind::Shape => TypeBase::Shape { id },
                                SymKind::Resource => TypeBase::Reference { resource: id },
                                SymKind::Type => self.alias_base(module, a),
                                _ => TypeBase::Scalar { name: "text".into(), args: vec![] },
                            };
                        }
                    }
                }
        TypeBase::Scalar { name: "text".into(), args: vec![] }
    }

    fn resolve_in_dep(&mut self, alias: &str, rest: &[String], file: usize, range: (usize, usize)) -> Option<Resolved> {
        let dep = self.deps[alias];
        let text = format!("{alias}.{}", rest.join("."));
        let name = &rest[0];
        let mut found_private = false;
        for m in &dep.modules {
            if let Some(e) = m.enums.iter().find(|e| &e.name == name) {
                if e.exported { return Some(Resolved::Type(TypeBase::Enum { id: e.id.clone() })); } else { found_private = true; }
            }
            if let Some(s) = m.shapes.iter().find(|e| &e.name == name) {
                if s.exported { return Some(Resolved::Type(TypeBase::Shape { id: s.id.clone() })); } else { found_private = true; }
            }
            if let Some(t) = m.types.iter().find(|e| &e.name == name) {
                if t.exported { return Some(Resolved::Type(t.ty.base.clone())); } else { found_private = true; }
            }
            if let Some(r) = m.resources.iter().find(|e| &e.name == name) {
                if r.exported {
                    return Some(match rest.get(1).map(|s| s.as_str()) {
                        None => Resolved::Type(TypeBase::Reference { resource: r.id.clone() }),
                        Some("Record") => Resolved::Type(TypeBase::Record { resource: r.id.clone() }),
                        Some("Id") => Resolved::Type(TypeBase::Identity { resource: r.id.clone() }),
                        Some("Status") => Resolved::Type(TypeBase::Status { resource: r.id.clone() }),
                        Some(_) => {
                            self.err("E-SYM-001", file, range, format!("unknown name `{text}`"), None);
                            return None;
                        }
                    });
                } else { found_private = true; }
            }
            if let Some(f) = m.functions.iter().find(|e| &e.name == name) {
                if f.exported { return Some(Resolved::Function(f.id.clone())); } else { found_private = true; }
            }
            if let Some(c) = m.channels.iter().find(|e| &e.name == name) {
                if c.exported {
                    return Some(match rest.get(1) {
                        None => Resolved::Channel(c.id.clone()),
                        Some(msg) if c.messages.iter().any(|m| &m.name == msg) => Resolved::Type(TypeBase::Message { channel: c.id.clone(), message: msg.clone() }),
                        Some(msg) => {
                            self.err("E-SYM-001", file, range, format!("channel `{alias}.{name}` has no message `{msg}`"), None);
                            return None;
                        }
                    });
                } else { found_private = true; }
            }
        }
        if found_private {
            self.err("E-SYM-003", file, range, format!("`{text}` exists in `{}` but is not exported", dep.package.name), Some("imports provide only exported contracts".into()));
        } else {
            self.err("E-SYM-001", file, range, format!("`{}` has no exported declaration named `{name}`", dep.package.name), None);
        }
        None
    }

    /// (contract id, message names) for a local channel declaration.
    fn channel_contract(&mut self, c: &ast::ChannelDecl, module: &str, _file: usize) -> (String, Vec<String>) {
        let name = c.name().map(|t| t.text().to_string()).unwrap_or_default();
        if let Some(from) = c.from() {
            let segs = from.segments();
            if let [alias, up] = segs.as_slice()
                && self.is_import(module, alias) {
                    let dep = self.deps[alias];
                    if let Some(ch) = dep.modules.iter().flat_map(|m| m.channels.iter()).find(|x| &x.name == up && x.exported) {
                        return (ch.id.clone(), ch.messages.iter().map(|m| m.name.clone()).collect());
                    }
                }
            return (self.id(module, &name), vec![]);
        }
        (self.id(module, &name), c.messages().filter_map(|m| m.name().map(|t| t.text().to_string())).collect())
    }

    // ------------------------------------------------------------ types
    fn type_spec(&mut self, te: &ast::TypeExpr, module: &str, file: usize) -> Option<TypeSpec> {
        let tr = te.type_ref()?;
        let name = tr.name()?;
        let segs = name.segments();
        let res = self.resolve(&segs, module, file, range_of(&name))?;
        let Resolved::Type(mut base) = res else {
            self.err("E-TYPE-001", file, range_of(&name), format!("`{}` is not a type", name.text()), None);
            return None;
        };
        let args = tr.args();
        if let TypeBase::Scalar { args: a, .. } = &mut base {
            if !args.is_empty() {
                *a = args;
            }
        } else if !args.is_empty() {
            self.err("E-TYPE-002", file, range_of(&tr), "only scalar types take arguments", None);
        }
        // Inherit alias refinements.
        let (mut normalizers, mut constraints) = (Vec::new(), Vec::new());
        if let [a] = segs.as_slice()
            && let Some(Symbol { decl: Declaration::Type(t), .. }) = self.sym(module, a)
                && let Some(inner) = t.type_expr() {
                    let inner = inner.clone();
                    if let Some(spec) = self.type_spec(&inner, module, file) {
                        normalizers = spec.normalizers;
                        constraints = spec.constraints;
                    }
                }
        for r in te.refinements() {
            match r.kind() {
                Some(RefinementKind::Normalizer(n)) => normalizers.push(n),
                Some(RefinementKind::LengthRange { min, max }) => constraints.push(Constraint::Length { min: Some(min), max: Some(max) }),
                Some(RefinementKind::LengthCompare { op, bound }) => constraints.push(match op.as_str() {
                    "<=" => Constraint::Length { min: None, max: Some(bound) },
                    "<" => Constraint::Length { min: None, max: Some(bound.saturating_sub(1)) },
                    ">=" => Constraint::Length { min: Some(bound), max: None },
                    ">" => Constraint::Length { min: Some(bound + 1), max: None },
                    "==" => Constraint::Length { min: Some(bound), max: Some(bound) },
                    _ => {
                        self.err("E-TYPE-003", file, range_of(&r), "`length !=` is not a supported constraint", None);
                        continue;
                    }
                }),
                Some(RefinementKind::Compare { op, literal }) => constraints.push(Constraint::Compare { op, value: literal_of(&literal) }),
                Some(RefinementKind::Pattern(p)) => constraints.push(Constraint::Pattern { value: p }),
                None => self.err("E-TYPE-004", file, range_of(&r), "unrecognized refinement", None),
            }
        }
        Some(TypeSpec { base, optional: te.is_optional(), normalizers, constraints })
    }

    // ------------------------------------------------------------ fields
    fn field(&mut self, fd: &ast::FieldDecl, module: &str, file: usize, scope: Option<&str>, allowed_decorators: &[&str]) -> Option<Field> {
        let name_tok = fd.name()?;
        let name = name_tok.text().to_string();
        let mut immutable = false;
        let mut unique = false;
        for d in fd.decorators() {
            let Some(dn) = d.name() else { continue };
            match dn.text() {
                "immutable" if allowed_decorators.contains(&"immutable") => immutable = true,
                "unique" if allowed_decorators.contains(&"unique") => unique = true,
                "label" => {}
                other => {
                    let sugg = suggest(other, allowed_decorators.iter().copied()).map(|s| format!("did you mean `@{s}`?"));
                    self.err("E-DEC-001", file, tok_range(&dn), format!("unknown field decorator `@{other}`"), sugg);
                }
            }
        }
        let _ = unique;
        if let Some(expr) = fd.derived() {
            if fd.decorators().next().is_some() {
                self.err("E-DEC-003", file, range_of(fd), format!("derived field `{name}` cannot carry decorators"), None);
            }
            let ir = self.expr(&expr, module, file, scope);
            let ty = ir.as_ref().and_then(|e| self.infer(e, module, scope)).unwrap_or(TypeSpec { base: TypeBase::Scalar { name: "json".into(), args: vec![] }, optional: false, normalizers: vec![], constraints: vec![] });
            return Some(Field { name, ty, default: None, derived: ir, immutable: true, server_owned: true, synthesized: false, doc: fd.doc() });
        }
        let te = fd.type_expr()?;
        let ty = self.type_spec(&te, module, file)?;
        let default = match fd.default() {
            Some(e) => self.default_literal(&e, &ty, module, file),
            None => None,
        };
        Some(Field { name, ty, default, derived: None, immutable, server_owned: false, synthesized: false, doc: fd.doc() })
    }

    fn default_literal(&mut self, e: &ast::Expr, ty: &TypeSpec, module: &str, file: usize) -> Option<Literal> {
        match e {
            ast::Expr::Literal(l) => {
                let lit = literal_of(&l.text());
                if let (Literal::Null, false) = (&lit, ty.optional) {
                    self.err("E-TYPE-011", file, range_of(l), "`null` default on a required field", None);
                }
                Some(lit)
            }
            ast::Expr::Name(n) => {
                let segs = n.segments();
                if let ([en, member], TypeBase::Enum { id }) = (segs.as_slice(), &ty.base) {
                    let members: Vec<String> = self.enum_members(id, module).into_iter().map(|m| m.name).collect();
                    if members.iter().any(|m| m == member) {
                        return Some(Literal::EnumMember { r#enum: id.clone(), member: member.clone() });
                    }
                    let sugg = suggest(member, members.iter().map(|s| s.as_str())).map(|s| format!("did you mean `{en}.{s}`?"));
                    self.err("E-TYPE-010", file, range_of(n), format!("`{}` is not a member of enum `{en}`", segs.join(".")), sugg);
                    return None;
                }
                self.err("E-TYPE-012", file, range_of(n), "defaults must be literals or enum members", None);
                None
            }
            _ => {
                self.err("E-TYPE-012", file, expr_range(e), "defaults must be literals or enum members", None);
                None
            }
        }
    }

    fn enum_members(&self, id: &str, module: &str) -> Vec<EnumMember> {
        let local_prefix = format!("{}/{}/", self.pkg.name, module);
        if let Some(name) = id.strip_prefix(&local_prefix)
            && let Some(Symbol { decl: Declaration::Enum(e), .. }) = self.sym(module, name) {
                return e.members().filter_map(|m| Some(EnumMember { name: m.name()?.text().to_string(), value: m.value().unwrap_or_else(|| m.name().unwrap().text().to_string()), doc: m.doc() })).collect();
            }
        for d in self.deps.values() {
            if let Some(e) = d.find_enum(id) {
                return e.members.clone();
            }
        }
        vec![]
    }

    // ------------------------------------------------------------ exprs
    fn expr(&mut self, e: &ast::Expr, module: &str, file: usize, scope: Option<&str>) -> Option<Expr> {
        Some(match e {
            ast::Expr::Binary(b) => Expr::Binary { op: b.op()?, lhs: Box::new(self.expr(&b.lhs()?, module, file, scope)?), rhs: Box::new(self.expr(&b.rhs()?, module, file, scope)?) },
            ast::Expr::Unary(u) => Expr::Unary { op: u.op()?, operand: Box::new(self.expr(&u.operand()?, module, file, scope)?) },
            ast::Expr::Paren(p) => self.expr(&p.inner()?, module, file, scope)?,
            ast::Expr::Literal(l) => Expr::Literal { literal: literal_of(&l.text()) },
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

    /// Validate `a.b.c` against a resource's fields, following references.
    fn check_path(&mut self, path: &[String], resource_id: &str, module: &str, file: usize, range: (usize, usize)) -> Option<()> {
        let mut current = resource_id.to_string();
        for (i, seg) in path.iter().enumerate() {
            let fields = self.resource_fields(&current, module);
            let Some(f) = fields.iter().find(|f| &f.name == seg) else {
                // `Enum.Member` is allowed as a value.
                if i == 0 && path.len() == 2 && self.sym(module, seg).is_some_and(|s| s.kind == SymKind::Enum) {
                    return Some(());
                }
                let sugg = suggest(seg, fields.iter().map(|f| f.name.as_str())).map(|s| format!("did you mean `{s}`?"));
                self.err("E-SYM-001", file, range, format!("unknown field `{}` on `{}`", seg, short(&current)), sugg);
                return None;
            };
            if i + 1 < path.len() {
                match &f.ty.base {
                    TypeBase::Reference { resource } => current = resource.clone(),
                    _ => {
                        self.err("E-EXPR-002", file, range, format!("`{seg}` is not a reference; cannot access `{}`", path[i + 1]), None);
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
        if let Some(name) = id.strip_prefix(&local_prefix)
            && let Some(Symbol { decl: Declaration::Resource(r), file, .. }) = self.sym(module, name) {
                let (r, file) = (r.clone(), *file);
                let mut out = Vec::new();
                let saved = self.diags.len();
                for fd in r.fields() {
                    if let Some(f) = self.field(&fd, module, file, None, FIELD_DECORATORS) {
                        out.push(f);
                    }
                }
                self.diags.truncate(saved); // reported by the owning pass, not here
                out.extend(self.synthesized_fields(&self.decorators_of(&r), r.lifecycle().is_some(), &self.id(module, name)));
                return out;
            }
        for d in self.deps.values() {
            if let Some(r) = d.find_resource(id) {
                return r.fields.clone();
            }
        }
        vec![]
    }

    fn infer(&mut self, e: &Expr, module: &str, scope: Option<&str>) -> Option<TypeSpec> {
        let scalar = |n: &str| TypeSpec { base: TypeBase::Scalar { name: n.into(), args: vec![] }, optional: false, normalizers: vec![], constraints: vec![] };
        Some(match e {
            Expr::Binary { op, lhs, .. } => match op.as_str() {
                "+" | "-" | "*" | "/" => self.infer(lhs, module, scope)?,
                _ => scalar("boolean"),
            },
            Expr::Unary { op, operand } => if op == "!" { scalar("boolean") } else { self.infer(operand, module, scope)? },
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
                        && let TypeBase::Reference { resource } = &f.ty.base {
                            current = resource.clone();
                        }
                    ty = Some(TypeSpec { base: f.ty.base.clone(), optional: f.ty.optional, normalizers: vec![], constraints: vec![] });
                }
                ty?
            }
            Expr::Call { .. } => scalar("json"),
        })
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
                "versioned" => d.versioned = true,
                "audited" => d.audited = true,
                "hierarchical" => d.hierarchical = true,
                "crud" => {
                    let args = dec.args();
                    if let Some(ArgValue::Literal(p)) = args.first().and_then(|a| a.value()) {
                        let names = |label: &str| args.iter().find(|a| a.label().as_deref() == Some(label)).and_then(|a| a.value()).and_then(|v| if let ArgValue::List(l) = v { Some(l.into_iter().filter_map(|x| if let ArgValue::Name(n) = x { n.first().cloned() } else { None }).collect::<Vec<String>>()) } else { None });
                        d.crud = Some(CrudBinding { path: unq(&p), operations: names("operations"), actions: names("actions").unwrap_or_default() });
                    }
                }
                "effectiveDated" => {
                    let by = dec.args().iter().find(|a| a.label().as_deref() == Some("uniqueBy")).and_then(|a| a.value()).and_then(|v| if let ArgValue::List(l) = v { Some(l.into_iter().filter_map(|x| if let ArgValue::Name(n) = x { n.first().cloned() } else { None }).collect()) } else { None }).unwrap_or_default();
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

    fn synthesized_fields(&self, d: &ResourceDecorators, has_lifecycle: bool, resource_id: &str) -> Vec<Field> {
        let scalar = |n: &str, optional: bool| TypeSpec { base: TypeBase::Scalar { name: n.into(), args: vec![] }, optional, normalizers: vec![], constraints: vec![] };
        let mk = |name: &str, ty: TypeSpec| Field { name: name.into(), ty, default: None, derived: None, immutable: false, server_owned: true, synthesized: true, doc: None };
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
            out.push(mk("status", TypeSpec { base: TypeBase::Status { resource: resource_id.into() }, optional: false, normalizers: vec![], constraints: vec![] }));
        }
        if d.effective_dated.is_some() {
            out.push(mk("effectiveFrom", scalar("datetime", false)));
            out.push(mk("effectiveUntil", scalar("datetime", true)));
        }
        if d.hierarchical {
            out.push(Field { name: "parent".into(), ty: TypeSpec { base: TypeBase::Reference { resource: resource_id.into() }, optional: true, normalizers: vec![], constraints: vec![] }, default: None, derived: None, immutable: false, server_owned: false, synthesized: true, doc: None });
        }
        out
    }

    fn resource(&mut self, r: &ast::ResourceDecl, module: &str, file: usize, exported: bool, enums_out: &mut Vec<EnumDecl>) -> Option<Resource> {
        let name = r.name()?.text().to_string();
        let id = self.id(module, &name);

        // decorators
        for dec in r.decorators() {
            let Some(n) = dec.name() else { continue };
            if !RESOURCE_DECORATORS.contains(&n.text()) {
                let sugg = suggest(n.text(), RESOURCE_DECORATORS.iter().copied()).map(|s| format!("did you mean `@{s}`?"));
                self.err("E-DEC-001", file, tok_range(&n), format!("unknown resource decorator `@{}`", n.text()), sugg);
            } else if n.text() == "crud" && !matches!(dec.args().first().and_then(|a| a.value()), Some(ArgValue::Literal(_))) {
                self.err("E-DEC-002", file, range_of(&dec), "`@crud` requires a route path, e.g. `@crud(\"/v1/customers\")`", None);
            } else if n.text() == "effectiveDated" && !dec.args().iter().any(|a| a.label().as_deref() == Some("uniqueBy")) {
                self.err("E-DEC-002", file, range_of(&dec), "`@effectiveDated` requires `uniqueBy: [..]`", None);
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
                self.err("E-RES-003", file, tok_range(&nt), format!("field `{}` is declared twice", nt.text()), None);
                continue;
            }
            if fd.decorators().any(|d| d.name().is_some_and(|n| n.text() == "unique")) {
                unique_fields.push(nt.text().to_string());
            }
            if let Some(f) = self.field(&fd, module, file, Some(&id), FIELD_DECORATORS) {
                fields.push(f);
            }
        }
        if !declared_names.contains("id") {
            self.err("E-RES-002", file, range_of(r), format!("resource `{name}` must declare `id : id`"), None);
        } else if let Some(f) = fields.iter_mut().find(|f| f.name == "id") {
            f.server_owned = true;
            f.immutable = true;
            if !matches!(&f.ty.base, TypeBase::Scalar { name, .. } if name == "id") {
                self.err("E-RES-004", file, range_of(r), "`id` must have type `id`", None);
            }
        }
        let synthesized = self.synthesized_fields(&decorators, r.lifecycle().is_some(), &id);
        for s in &synthesized {
            if declared_names.contains(&s.name) {
                let tok = r.fields().find_map(|f| f.name().filter(|t| t.text() == s.name)).unwrap();
                self.err("E-RES-001", file, tok_range(&tok), format!("field `{}` collides with a field synthesized by the resource's decorators or lifecycle", s.name), None);
            }
        }
        fields.extend(synthesized);
        let field_names: Vec<String> = fields.iter().map(|f| f.name.clone()).collect();

        // uniques
        let mut uniques: Vec<Unique> = unique_fields.iter().map(|f| Unique { name: f.clone(), fields: vec![f.clone()], within: vec![] }).collect();
        for u in r.uniques() {
            let (fs, within) = (u.fields(), u.within());
            for f in fs.iter().chain(within.iter()) {
                if !field_names.contains(f) {
                    self.err("E-QRY-002", file, range_of(&u), format!("unknown field `{f}` in unique constraint"), suggest(f, field_names.iter().map(|s| s.as_str())).map(|s| format!("did you mean `{s}`?")));
                }
            }
            let mut n = fs.join("_");
            if !within.is_empty() {
                n.push_str("_within_");
                n.push_str(&within.join("_"));
            }
            uniques.push(Unique { name: n, fields: fs, within });
        }
        uniques.sort_by(|a, b| a.name.cmp(&b.name));

        // finds
        let mut finds = Vec::new();
        for fd in r.finds() {
            let Some(fl) = fd.fields() else { continue };
            let fs = fl.names();
            let mut ok = true;
            for (f, t) in fs.iter().zip(fl.name_tokens()) {
                if !field_names.contains(f) {
                    ok = false;
                    self.err("E-QRY-002", file, tok_range(&t), format!("unknown field `{f}` in `find by`"), suggest(f, field_names.iter().map(|s| s.as_str())).map(|s| format!("did you mean `{s}`?")));
                }
            }
            if !ok {
                continue;
            }
            let set: BTreeSet<&String> = fs.iter().collect();
            match uniques.iter().find(|u| u.fields.iter().chain(u.within.iter()).collect::<BTreeSet<_>>() == set) {
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
                    self.err("E-QRY-002", file, tok_range(&t), format!("unknown field `{f}` in `list by`"), suggest(f, field_names.iter().map(|s| s.as_str())).map(|s| format!("did you mean `{s}`?")));
                }
            }
            let mut order: Vec<OrderKey> = ld.order().into_iter().map(|(field, direction)| OrderKey { field, direction }).collect();
            for o in &order {
                if !field_names.contains(&o.field) {
                    self.err("E-QRY-002", file, range_of(&ld), format!("unknown field `{}` in `order by`", o.field), suggest(&o.field, field_names.iter().map(|s| s.as_str())).map(|s| format!("did you mean `{s}`?")));
                }
            }
            if !order.iter().any(|o| o.field == "id") {
                // Deterministic tie-breaker. Its direction follows the declared keys so a
                // key-value store can serve the page with one reversed range scan.
                let dir = order.last().map(|o| o.direction.clone()).unwrap_or_else(|| "asc".into());
                order.push(OrderKey { field: "id".into(), direction: dir });
            }
            lists.push(List { name: camel(&fs), fields: fs, order });
        }
        lists.sort_by(|a, b| a.name.cmp(&b.name));

        // rules
        let mut rules = Vec::new();
        if let Some(rb) = r.rules() {
            for rule in rb.rules() {
                let Some(e) = rule.expr() else { continue };
                if let Some(ir) = self.expr(&e, module, file, Some(&id)) {
                    if !matches!(&ir, Expr::Binary { op, .. } if matches!(op.as_str(), "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||")) && !matches!(&ir, Expr::Unary { op, .. } if op == "!") {
                        self.err("E-EXPR-001", file, range_of(&rule), "a rule must be a boolean expression", None);
                    }
                    rules.push(ir);
                }
            }
        }

        // lifecycle
        let lifecycle = r.lifecycle().and_then(|l| self.lifecycle(&l, module, file, &id, exported, enums_out));

        // operations
        let mut operations = Vec::new();
        let crud = decorators.crud.clone();
        let allowed = |op: &str| crud.as_ref().and_then(|c| c.operations.as_ref()).is_none_or(|ops| ops.iter().any(|o| o == op));
        let http = |method: &str, suffix: &str| crud.as_ref().map(|c| HttpBinding { method: method.into(), path: format!("{}{}", c.path, suffix) });
        let mut push = |kind: &str, query: Option<String>, action: Option<String>, http: Option<HttpBinding>| {
            let op = match (kind, &query, &action) {
                (_, Some(q), _) => format!("{kind}.{q}"),
                (_, _, Some(a)) => format!("status.{a}"),
                _ => kind.to_string(),
            };
            operations.push(Operation { id: format!("{id}.{op}"), kind: kind.into(), query, action, http });
        };
        push("create", None, None, if allowed("create") { http("POST", "") } else { None });
        push("get", None, None, if allowed("get") { http("GET", "/{id}") } else { None });
        push("update", None, None, if allowed("update") { http("PATCH", "/{id}") } else { None });
        push("delete", None, None, if allowed("delete") { http("DELETE", "/{id}") } else { None });
        if decorators.soft_delete {
            push("restore", None, None, if allowed("restore") { http("POST", "/{id}/restore") } else { None });
        }
        for f in &finds {
            push("find", Some(f.name.clone()), None, if allowed("find") { http("GET", &format!("/queries/{}", kebab(&f.fields))) } else { None });
        }
        for l in &lists {
            push("list", Some(l.name.clone()), None, if allowed("list") { http("GET", &format!("/queries/{}", kebab(&l.fields))) } else { None });
        }
        if let Some(lc) = &lifecycle {
            for t in &lc.transitions {
                let exposed = crud.as_ref().is_some_and(|c| c.actions.iter().any(|a| a == &t.action));
                push("transition", None, Some(t.action.clone()), if exposed { http("POST", &format!("/{{id}}/actions/{}", t.action)) } else { None });
            }
        }
        if let Some(c) = &crud {
            let known: Vec<String> = lifecycle.as_ref().map(|l| l.transitions.iter().map(|t| t.action.clone()).collect()).unwrap_or_default();
            for a in &c.actions {
                if !known.contains(a) {
                    let sugg = suggest(a, known.iter().map(|s| s.as_str())).map(|s| format!("did you mean `{s}`?"));
                    self.err("E-DEC-004", file, range_of(r), format!("`@crud` exposes unknown lifecycle action `{a}`"), sugg);
                }
            }
        }

        Some(Resource { id, name, exported, doc: r.syntax().parent().and(None).or(ast::doc_of(r.syntax())), decorators, fields, uniques, finds, lists, rules, lifecycle, operations })
    }

    fn lifecycle(&mut self, l: &ast::LifecycleBlock, module: &str, file: usize, resource_id: &str, exported: bool, enums_out: &mut Vec<EnumDecl>) -> Option<Lifecycle> {
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
                self.err("E-LC-021", file, range_of(&t), format!("transition `{}` targets one of its own source states", action.text()), None);
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
                if prev_target != target.text() || prev_sources.iter().any(|s| sources.contains(s)) {
                    self.err("E-LC-003", file, tok_range(&action), format!("duplicate lifecycle action `{key}`"), None);
                    continue;
                }
                self.err("E-LC-006", file, tok_range(&action), format!("action `{key}` is declared more than once"), None);
                continue;
            }
            seen_actions.insert(key.clone(), (sources.clone(), target.text().to_string()));
            transitions.push(Transition { action: key, from: sources, to: target.text().to_string(), input, doc: t.doc() });
        }
        let initial = match initials.as_slice() {
            [one] => one.text().to_string(),
            [] => {
                self.err("E-LC-001", file, range_of(l), "lifecycle needs exactly one `initial` state", Some("add `initial <State>` so creation defaults cannot change silently".into()));
                return None;
            }
            [_, second, ..] => {
                self.err("E-LC-001", file, tok_range(second), "lifecycle declares more than one `initial` state", None);
                return None;
            }
        };
        let terminal_names: Vec<String> = terminals.iter().map(|t| t.text().to_string()).collect();
        for t in &transitions {
            for s in &t.from {
                if terminal_names.contains(s) {
                    self.err("E-LC-002", file, range_of(l), format!("terminal state `{s}` has an outgoing transition `{}`", t.action), None);
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
                self.err("E-LC-004", file, range_of(l), format!("state `{s}` is unreachable from `{initial}`"), None);
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
        enums_out.push(EnumDecl { id: enum_id.clone(), name: format!("{}.Status", short(resource_id)), exported, synthesized: true, doc: None, members: states.iter().map(|s| EnumMember { name: s.clone(), value: s.clone(), doc: None }).collect() });
        Some(Lifecycle { field, enum_id, states, initial, terminals: terminal_names, transitions })
    }

    // ------------------------------------------------------------ functions
    fn function(&mut self, f: &ast::FunctionDecl, module: &str, file: usize, exported: bool) -> Option<Function> {
        let name = f.name()?.text().to_string();
        let id = self.id(module, &name);
        let input = f.input().and_then(|n| self.type_ref_spec(&n, module, file));
        let output = f.output().and_then(|n| self.type_ref_spec(&n, module, file));
        let mut http = None;
        for d in f.decorators() {
            let Some(n) = d.name() else { continue };
            match n.text() {
                "http" => {
                    let args = d.args();
                    let method = args.first().and_then(|a| a.value()).and_then(|v| if let ArgValue::Name(m) = v { m.first().cloned() } else { None });
                    let path = args.get(1).and_then(|a| a.value()).and_then(|v| if let ArgValue::Literal(p) = v { Some(unq(&p)) } else { None });
                    match (method, path) {
                        (Some(m), Some(p)) if HTTP_METHODS.contains(&m.as_str()) => {
                            let input_fields: Vec<String> = input.as_ref().map(|t| self.fields_of_type(&t.base, module)).unwrap_or_default();
                            for param in p.split('{').skip(1).filter_map(|s| s.split('}').next()) {
                                if !input_fields.iter().any(|f| f == param) {
                                    self.err("E-HTTP-001", file, range_of(&d), format!("path parameter `{{{param}}}` is not a field of the function input"), None);
                                }
                            }
                            http = Some(HttpBinding { method: m, path: p });
                        }
                        _ => self.err("E-DEC-002", file, range_of(&d), "`@http` requires a method and a path, e.g. `@http(POST, \"/v1/x\")`", None),
                    }
                }
                "label" => {}
                other => {
                    let sugg = suggest(other, FUNCTION_DECORATORS.iter().copied()).map(|s| format!("did you mean `@{s}`?"));
                    self.err("E-DEC-001", file, tok_range(&n), format!("unknown function decorator `@{other}`"), sugg);
                }
            }
        }
        let mut uses = Vec::new();
        for u in f.uses() {
            let Some(t) = u.target() else { continue };
            let segs = t.segments();
            match self.resolve(&segs, module, file, range_of(&t)) {
                Some(Resolved::Type(TypeBase::Reference { resource })) => uses.push(Use::Resource { resource, capability: u.capability().unwrap_or_else(|| "read".into()) }),
                Some(Resolved::Transition { resource, action }) => uses.push(Use::Transition { resource, action }),
                Some(Resolved::Function(function)) => uses.push(Use::Function { function }),
                Some(_) => self.err("E-USE-001", file, range_of(&t), format!("`{}` cannot be used as a dependency", t.text()), None),
                None => {}
            }
        }
        let mut sends = Vec::new();
        for s in f.sends() {
            let (Some(m), Some(ch)) = (s.message(), s.channel()) else { continue };
            let segs = ch.segments();
            if let Some(Resolved::Channel(channel)) = self.resolve(&segs, module, file, range_of(&ch)) {
                let (messages, direction) = self.channel_info(&channel, module);
                if !messages.iter().any(|x| x == m.text()) {
                    let sugg = suggest(m.text(), messages.iter().map(|s| s.as_str())).map(|s| format!("did you mean `{s}`?"));
                    self.err("E-SYM-001", file, tok_range(&m), format!("channel `{}` has no message `{}`", ch.text(), m.text()), sugg);
                } else if direction.as_deref() == Some("recv-only") {
                    self.err("E-CH-001", file, range_of(&s), format!("`{}` is `recv-only`; this function cannot send to it", ch.text()), None);
                } else {
                    sends.push(Send { message: m.text().to_string(), channel });
                }
            } else if self.sym(module, &segs[0]).is_some() {
                self.err("E-USE-002", file, range_of(&ch), format!("`{}` is not a channel", ch.text()), None);
            }
        }
        let errors: Vec<String> = f.errors().iter().map(|t| t.text().to_string()).collect();
        let slo = f.slo().iter().filter_map(|s| s.parts()).map(|(k, target, within, window)| if k == "latency" { Slo::Latency { target, within: within.unwrap_or_default(), window } } else { Slo::Availability { target, window } }).collect();
        Some(Function { id, name, exported, doc: ast::doc_of(f.syntax()), input, output, uses, sends, errors, slo, http, generated: false })
    }

    fn type_ref_spec(&mut self, n: &ast::QualifiedName, module: &str, file: usize) -> Option<TypeSpec> {
        match self.resolve(&n.segments(), module, file, range_of(n))? {
            Resolved::Type(base) => Some(TypeSpec { base, optional: false, normalizers: vec![], constraints: vec![] }),
            _ => {
                self.err("E-TYPE-001", file, range_of(n), format!("`{}` is not a type", n.text()), None);
                None
            }
        }
    }

    fn fields_of_type(&mut self, base: &TypeBase, module: &str) -> Vec<String> {
        match base {
            TypeBase::Shape { id } => {
                let local_prefix = format!("{}/{}/", self.pkg.name, module);
                if let Some(name) = id.strip_prefix(&local_prefix)
                    && let Some(Symbol { decl: Declaration::Shape(s), .. }) = self.sym(module, name) {
                        return s.fields().filter_map(|f| f.name().map(|t| t.text().to_string())).collect();
                    }
                self.deps.values().find_map(|d| d.find_shape(id)).map(|s| s.fields.iter().map(|f| f.name.clone()).collect()).unwrap_or_default()
            }
            TypeBase::Record { resource } | TypeBase::Reference { resource } => self.resource_fields(resource, module).into_iter().map(|f| f.name).collect(),
            TypeBase::Message { channel, message } => {
                let local_prefix = format!("{}/{}/", self.pkg.name, module);
                if let Some(name) = channel.strip_prefix(&local_prefix)
                    && let Some(Symbol { decl: Declaration::Channel(c), .. }) = self.sym(module, name) {
                        return c.messages().find(|m| m.name().is_some_and(|t| t.text() == message)).map(|m| m.fields().filter_map(|f| f.name().map(|t| t.text().to_string())).collect()).unwrap_or_default();
                    }
                self.deps.values().find_map(|d| d.find_channel(channel)).and_then(|c| c.messages.iter().find(|m| &m.name == message)).map(|m| m.fields.iter().map(|f| f.name.clone()).collect()).unwrap_or_default()
            }
            _ => vec![],
        }
    }

    /// (message names, direction) for a channel id, local or imported.
    fn channel_info(&mut self, id: &str, module: &str) -> (Vec<String>, Option<String>) {
        let local_prefix = format!("{}/{}/", self.pkg.name, module);
        if let Some(name) = id.strip_prefix(&local_prefix)
            && let Some(Symbol { decl: Declaration::Channel(c), file, .. }) = self.sym(module, name) {
                let (c, file) = (c.clone(), *file);
                let (_, messages) = self.channel_contract(&c, module, file);
                return (messages, c.direction());
            }
        for d in self.deps.values() {
            if let Some(c) = d.find_channel(id) {
                return (c.messages.iter().map(|m| m.name.clone()).collect(), c.direction.clone());
            }
        }
        (vec![], None)
    }

    // ------------------------------------------------------------ channels
    fn channel(&mut self, c: &ast::ChannelDecl, module: &str, file: usize, exported: bool) -> Option<Channel> {
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
                Some(_) => self.err("E-USE-002", file, range_of(&from), format!("`{}` is not a channel", from.text()), None),
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
                messages.push(Message { name: mn.text().to_string(), doc: m.doc(), fields });
            }
            messages.sort_by(|a, b| a.name.cmp(&b.name));
        }
        Some(Channel { id, name, exported, contract, distribution: c.distribution().unwrap_or_else(|| "broadcast".into()), delivery: c.delivery().unwrap_or_else(|| "at-least-once".into()), direction: c.direction(), messages })
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
            let m = modules.entry(module.clone()).or_insert_with(|| Module { id: module.clone(), ..Default::default() });
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
                            self.err("E-ENUM-001", file, range_of(&mem), format!("wire value `{value}` is already used by member `{prev}`"), None);
                        }
                        values.insert(value.clone(), n.text().to_string());
                        members.push(EnumMember { name: n.text().to_string(), value, doc: mem.doc() });
                    }
                    m.enums.push(EnumDecl { id, name, exported, synthesized: false, doc: decl.doc(), members });
                }
                (SymKind::Type, Declaration::Type(t)) => {
                    if let Some(te) = t.type_expr()
                        && let Some(ty) = self.type_spec(&te, &module, file) {
                            m.types.push(TypeAlias { id, name, exported, ty });
                        }
                }
                (SymKind::Shape, Declaration::Shape(s)) => {
                    let mut fields = Vec::new();
                    for fd in s.fields() {
                        if let Some(f) = self.field(&fd, &module, file, None, &["immutable"]) {
                            fields.push(f);
                        }
                    }
                    m.shapes.push(Shape { id, name, exported, doc: decl.doc(), fields });
                }
                (SymKind::Resource, Declaration::Resource(r)) => {
                    if let Some(res) = self.resource(r, &module, file, exported, &mut extra_enums) {
                        m.resources.push(res);
                    }
                }
                (SymKind::Function, Declaration::Function(f)) => {
                    if let Some(func) = self.function(f, &module, file, exported) {
                        m.functions.push(func);
                    }
                }
                (SymKind::Channel, Declaration::Channel(c)) => {
                    if let Some(ch) = self.channel(c, &module, file, exported) {
                        m.channels.push(ch);
                    }
                }
                (SymKind::Source, Declaration::Source(s)) => {
                    let target = s.target();
                    let Some(t) = target else {
                        self.err("E-SRC-002", file, range_of(s), "a source must declare a target with `-> Function`", None);
                        continue;
                    };
                    let segs = t.segments();
                    let Some(Resolved::Function(target_id)) = self.resolve(&segs, &module, file, range_of(&t)) else { continue };
                    if let Some(cron) = s.cron()
                        && cron.split_whitespace().count() != 5 {
                            self.err("E-SRC-001", file, range_of(s), format!("cron expression `{cron}` must have five fields"), None);
                        }
                    m.sources.push(Source { id, name, cron: s.cron(), timezone: s.timezone(), target: target_id });
                }
                _ => {}
            }
            let m = modules.get_mut(&module).unwrap();
            m.enums.extend(extra_enums);
        }
        // subscriptions
        for fi in 0..self.files.len() {
            let module = self.files[fi].module.clone();
            let subs: Vec<ast::SubscriptionDecl> = self.files[fi].parse.root().declarations().filter_map(|d| if let Declaration::Subscription(s) = d { Some(s) } else { None }).collect();
            for s in subs {
                let (Some(msg), Some(handler)) = (s.message(), s.handler()) else { continue };
                let Some(Resolved::Type(TypeBase::Message { channel, message })) = self.resolve(&msg.segments(), &module, fi, range_of(&msg)) else {
                    continue;
                };
                let Some(Resolved::Function(h)) = self.resolve(&handler.segments(), &module, fi, range_of(&handler)) else { continue };
                // handler input must be the message type
                let input = modules.values().flat_map(|m| m.functions.iter()).find(|f| f.id == h).and_then(|f| f.input.clone());
                match input {
                    Some(TypeSpec { base: TypeBase::Message { channel: c2, message: m2 }, .. }) if c2 == channel && m2 == message => {}
                    _ => self.err("E-SUB-001", fi, range_of(&s), format!("handler `{}` must take `{}` as its input", handler.text(), msg.text()), None),
                }
                modules.entry(module.clone()).or_insert_with(|| Module { id: module.clone(), ..Default::default() }).subscriptions.push(Subscription { channel, message, handler: h });
            }
        }
        // mark generated functions: none yet at this layer (CRUD operations live on resources)
        let mut modules: Vec<Module> = modules.into_values().collect();
        for m in &mut modules {
            m.enums.sort_by(|a, b| a.id.cmp(&b.id));
            m.types.sort_by(|a, b| a.id.cmp(&b.id));
            m.shapes.sort_by(|a, b| a.id.cmp(&b.id));
            m.resources.sort_by(|a, b| a.id.cmp(&b.id));
            m.functions.sort_by(|a, b| a.id.cmp(&b.id));
            m.channels.sort_by(|a, b| a.id.cmp(&b.id));
            m.sources.sort_by(|a, b| a.id.cmp(&b.id));
            m.subscriptions.sort_by(|a, b| (&a.channel, &a.message, &a.handler).cmp(&(&b.channel, &b.message, &b.handler)));
        }
        let mut imports: Vec<Import> = self.pkg.dependencies.iter().map(|(alias, package)| Import { alias: alias.clone(), package: package.clone() }).collect();
        imports.sort_by(|a, b| a.alias.cmp(&b.alias));
        DomainIR {
            version: DOMAIN_IR_VERSION.into(),
            package: PackageInfo { name: self.pkg.name.clone(), version: self.pkg.version.clone(), edition: self.pkg.edition.clone(), profile: self.pkg.profile.clone(), targets: self.pkg.targets.clone() },
            imports,
            modules,
        }
    }
}

fn short(id: &str) -> &str {
    id.rsplit('/').next().unwrap_or(id)
}
fn unq(s: &str) -> String {
    if s.starts_with('"') { ast::unquote(s) } else { s.to_string() }
}
fn literal_of(text: &str) -> Literal {
    match text {
        "true" => Literal::Bool(true),
        "false" => Literal::Bool(false),
        "null" => Literal::Null,
        t if t.starts_with('"') => Literal::String(ast::unquote(t)),
        t if t.ends_with('%') => Literal::Percent(t.to_string()),
        t if t.chars().all(|c| c.is_ascii_digit()) => Literal::Int(t.to_string()),
        t if t.contains('.') && t.chars().all(|c| c.is_ascii_digit() || c == '.') => Literal::Decimal(t.to_string()),
        t => Literal::Duration(t.to_string()),
    }
}

fn expr_range(e: &ast::Expr) -> (usize, usize) {
    let r = e.syntax().text_range();
    (r.start().into(), r.end().into())
}
