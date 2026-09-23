//! `forgec lsp`: a small Language Server over stdio (plan M8 "LSP basics").
//! Full document sync; on open/change the owning package is recompiled and
//! diagnostics (with suggestions) are published for the edited file;
//! `textDocument/formatting` returns the canonical formatting. Hand-rolled
//! JSON-RPC keeps the compiler core free of server frameworks.
use forgegraph_semantic::analysis::AnalysisCache;
use forgegraph_semantic::load_package;
use forgegraph_syntax::AstNode;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::{cell::RefCell, rc::Rc};

fn read_message(input: &mut impl BufRead) -> Option<Value> {
    let mut len = 0usize;
    loop {
        let mut line = String::new();
        if input.read_line(&mut line).ok()? == 0 {
            return None;
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some(v) = line.strip_prefix("Content-Length:") {
            len = v.trim().parse().ok()?;
        }
    }
    let mut buf = vec![0u8; len];
    std::io::Read::read_exact(input, &mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

fn write_message(out: &mut impl Write, v: &Value) {
    let body = v.to_string();
    let _ = write!(out, "Content-Length: {}\r\n\r\n{}", body.len(), body);
    let _ = out.flush();
}

fn uri_to_path(uri: &str) -> PathBuf {
    let p = uri.strip_prefix("file://").unwrap_or(uri);
    PathBuf::from(percent_decode(p))
}
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Nearest ancestor containing `forge.toml`.
fn package_root(file: &Path) -> Option<PathBuf> {
    let mut cur = file.parent();
    while let Some(d) = cur {
        if d.join("forge.toml").exists() {
            return Some(d.to_path_buf());
        }
        cur = d.parent();
    }
    None
}

/// (line, character) of a byte offset, UTF-16 units as LSP requires.
fn position(text: &str, offset: usize) -> Value {
    let mut offset = offset.min(text.len());
    while !text.is_char_boundary(offset) {
        offset -= 1;
    }
    let before = &text[..offset];
    let line = before.matches('\n').count();
    let col_start = before.rfind('\n').map(|i| i + 1).unwrap_or(0);
    let character: usize = text[col_start..offset].encode_utf16().count();
    json!({ "line": line, "character": character })
}

fn byte_position(text: &str, line: usize, character: usize) -> Option<usize> {
    let mut start = 0;
    for _ in 0..line {
        start += text.get(start..)?.find('\n')? + 1;
    }
    let text_line = text.get(start..)?.split('\n').next()?;
    let mut units = 0;
    for (offset, c) in text_line.char_indices() {
        if units == character {
            return Some(start + offset);
        }
        units += c.len_utf16();
        if units > character {
            return None;
        }
    }
    (units == character).then_some(start + text_line.len())
}
/// Apply sequential LSP changes atomically. Invalid UTF-16 ranges leave the buffer intact.
fn apply_changes(text: &str, changes: &[Value]) -> Option<String> {
    let mut next = text.to_string();
    for change in changes {
        let replacement = change["text"].as_str()?;
        if let Some(range) = change.get("range") {
            let start = byte_position(
                &next,
                range["start"]["line"].as_u64()? as usize,
                range["start"]["character"].as_u64()? as usize,
            )?;
            let end = byte_position(
                &next,
                range["end"]["line"].as_u64()? as usize,
                range["end"]["character"].as_u64()? as usize,
            )?;
            if start > end {
                return None;
            }
            next.replace_range(start..end, replacement);
        } else {
            next = replacement.into();
        }
    }
    Some(next)
}
fn path_to_uri(path: &Path) -> String {
    let mut uri = String::from("file://");
    for byte in path.to_string_lossy().bytes() {
        if byte.is_ascii_alphanumeric() || b"/-_.~:".contains(&byte) {
            uri.push(byte as char);
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri
}

/// Use compiler scope snapshots, including recovery compilations, rather than guessing binding
/// visibility from token order. Choice and parallel branches have independent snapshots.
fn workflow_binding_completion(
    analysis: &[Analysis],
    current: &Analysis,
    source: &forgegraph_semantic::package::SourceFile,
    offset: usize,
) -> Option<Vec<Value>> {
    use forgegraph_semantic::ir::TypeBase;
    let prefix = &source.text[..offset];
    let fragment = prefix
        .rsplit(|c: char| !(c.is_alphanumeric() || c == '_' || c == '.'))
        .next()
        .unwrap_or("");
    let scope = current
        .compiled
        .workflow_scopes
        .iter()
        .filter(|s| s.span.file == source.path && s.span.start <= offset && offset <= s.span.end)
        .min_by_key(|s| s.span.end - s.span.start)?;
    let fields = |ty: &TypeBase| -> Vec<(String, forgegraph_semantic::ir::TypeSpec)> {
        let key = serde_json::to_string(ty).unwrap();
        analysis
            .iter()
            .find_map(|a| a.compiled.workflow_fields.get(&key))
            .cloned()
            .unwrap_or_default()
    };
    let segments: Vec<_> = fragment.split('.').collect();
    if segments.len() > 1 {
        let mut ty = scope.bindings.get(segments[0])?.clone();
        for segment in &segments[1..segments.len() - 1] {
            ty = fields(&ty.base)
                .into_iter()
                .find(|(name, _)| name == segment)?
                .1;
        }
        return Some(fields(&ty.base).into_iter().map(|(name, ty)| json!({"label":name, "kind":5, "detail":serde_json::to_string(&ty).unwrap()})).collect());
    }
    // Bare bindings only at expression positions, never while selecting a callee or message.
    let line = prefix.lines().last().unwrap_or("");
    let expression = line.contains(": ")
        || line.trim_start().starts_with("return ")
        || line.trim_start().starts_with("if ")
        || line.contains(" == ");
    expression.then(|| scope.bindings.iter().map(|(name, ty)| json!({"label":name,"kind":6,"detail":serde_json::to_string(ty).unwrap()})).collect())
}

struct Analysis {
    root: PathBuf,
    package: forgegraph_semantic::Package,
    compiled: Rc<forgegraph_semantic::Compilation>,
    anchors: BTreeMap<String, forgegraph_semantic::compiler::SourceSpan>,
    derivations: Value,
}
impl Analysis {
    fn location(&self, span: &forgegraph_semantic::compiler::SourceSpan) -> Option<Value> {
        let source = self.package.files.iter().find(|s| s.path == span.file)?;
        Some(
            json!({"uri":path_to_uri(&self.root.join(&span.file)),"range":{"start":position(&source.text,span.start),"end":position(&source.text,span.end)}}),
        )
    }
}
fn target_at(analysis: &[Analysis], file: &Path, line: usize, character: usize) -> Option<String> {
    for a in analysis {
        let Some(source) = a
            .package
            .files
            .iter()
            .find(|s| a.root.join(&s.path) == file)
        else {
            continue;
        };
        let offset = byte_position(&source.text, line, character)?;
        if let Some(reference) = a
            .compiled
            .references
            .iter()
            .filter(|r| r.span.file == source.path && r.span.start <= offset && offset < r.span.end)
            .min_by_key(|r| r.span.end - r.span.start)
        {
            return Some(reference.target.clone());
        }
        return a
            .anchors
            .iter()
            .filter(|(id, span)| {
                a.derivations.get(*id).is_none()
                    && span.file == source.path
                    && span.start <= offset
                    && offset < span.end
            })
            .min_by_key(|(_, span)| span.end - span.start)
            .map(|(id, _)| id.clone());
    }
    None
}

struct Server {
    /// Open documents by absolute path: the compiler reads these instead of disk.
    open: BTreeMap<PathBuf, String>,
    roots: Vec<PathBuf>,
    cache: RefCell<AnalysisCache>,
}

impl Server {
    fn analysis(&self, file: &Path) -> Vec<Analysis> {
        fn visit(
            server: &Server,
            root: PathBuf,
            seen: &mut std::collections::BTreeSet<PathBuf>,
            out: &mut Vec<Analysis>,
        ) {
            if !seen.insert(root.canonicalize().unwrap_or_else(|_| root.clone())) {
                return;
            }
            let Ok(mut package) = load_package(&root) else {
                return;
            };
            for source in &mut package.files {
                if let Some(text) = server.open.get(&root.join(&source.path)) {
                    source.text = text.clone();
                }
            }
            for (_, path) in &package.dependency_paths {
                visit(server, path.clone(), seen, out);
            }
            let compiled = server.cache.borrow_mut().analyze(
                &root.to_string_lossy(),
                &package,
                &out.iter()
                    .filter_map(|a| a.compiled.ir.as_ref())
                    .collect::<Vec<_>>(),
            );
            let map = server
                .cache
                .borrow()
                .editor_source_map(&root.to_string_lossy(), &compiled);
            let anchors = serde_json::from_value(map["anchors"].clone()).unwrap_or_default();
            out.push(Analysis {
                root,
                package,
                compiled,
                anchors,
                derivations: map["derivations"].clone(),
            });
        }
        let mut out = vec![];
        if let Some(root) = package_root(file) {
            visit(self, root, &mut Default::default(), &mut out);
        }
        out
    }

    fn definition(&self, file: &Path, line: usize, character: usize) -> Vec<Value> {
        let analysis = self.analysis(file);
        let Some(target) = target_at(&analysis, file, line, character) else {
            return vec![];
        };
        analysis
            .iter()
            .filter_map(|a| a.anchors.get(&target).and_then(|span| a.location(span)))
            .collect()
    }

    fn references(
        &self,
        file: &Path,
        line: usize,
        character: usize,
        declaration: bool,
    ) -> Vec<Value> {
        let mut analysis = self.analysis(file);
        let Some(target) = target_at(&analysis, file, line, character) else {
            return vec![];
        };
        let owner = |analyses: &[Analysis]| {
            analyses.iter().find_map(|a| {
                a.anchors.get(&target).map(|span| {
                    let path = a.root.join(&span.file);
                    path.canonicalize().unwrap_or(path)
                })
            })
        };
        let target_owner = owner(&analysis);
        // A declaration in a dependency must also find callers in workspace packages.
        // Analyze each package with its own dependency context, then deduplicate locations.
        let mut roots = std::collections::BTreeSet::new();
        if let Some(root) = package_root(file) {
            roots.insert(root.canonicalize().unwrap_or(root));
        }
        for path in self
            .open
            .keys()
            .cloned()
            .chain(self.roots.iter().map(|root| root.join("forge.toml")))
        {
            if let Some(root) = package_root(&path)
                && roots.insert(root.canonicalize().unwrap_or_else(|_| root.clone()))
            {
                let candidates = self.analysis(&path);
                // Semantic ids alone do not distinguish separate checkouts of one package.
                if target_owner.is_some() && owner(&candidates) == target_owner {
                    analysis.extend(candidates);
                }
            }
        }
        let mut locations = vec![];
        for a in &analysis {
            if declaration
                && let Some(span) = a.anchors.get(&target)
                && let Some(location) = a.location(span)
            {
                locations.push(location);
            }
            for reference in &a.compiled.references {
                if reference.target == target
                    && let Some(location) = a.location(&reference.span)
                {
                    locations.push(location);
                }
            }
        }
        locations.sort_by_key(Value::to_string);
        locations.dedup();
        locations
    }

    fn hover(&self, file: &Path, line: usize, character: usize) -> Value {
        let analysis = self.analysis(file);
        let Some(target) = target_at(&analysis, file, line, character) else {
            return Value::Null;
        };
        let mut description = target.clone();
        for a in &analysis {
            if let Some(span) = a.anchors.get(&target)
                && let Some(source) = a.package.files.iter().find(|s| s.path == span.file)
                && let Some(text) = source.text.get(span.start..span.end)
            {
                description.push_str("\n\n");
                description.push_str(text.lines().next().unwrap_or_default());
            }
            if let Some(derivations) = a.derivations.as_object() {
                for (effective, edges) in derivations {
                    if let Some(edges) = edges.as_array()
                        && edges
                            .iter()
                            .any(|edge| edge["kind"] == "facet-field" && edge["from"] == target)
                    {
                        description.push_str(&format!("\nEffective field: {effective}"));
                        for edge in edges {
                            description.push_str(&format!(
                                "\n{}: {}",
                                edge["kind"].as_str().unwrap_or_default(),
                                edge["from"].as_str().unwrap_or_default()
                            ));
                        }
                    }
                }
            }
            if let Some(edges) = a.derivations.get(&target).and_then(Value::as_array) {
                for edge in edges {
                    description.push_str(&format!(
                        "\n{}: {}",
                        edge["kind"].as_str().unwrap_or_default(),
                        edge["from"].as_str().unwrap_or_default()
                    ));
                }
            }
        }
        json!({"contents":{"kind":"plaintext","value":description}})
    }

    fn symbols(&self, file: &Path, only_file: bool, query: &str) -> Vec<Value> {
        let mut symbols = vec![];
        for a in self.analysis(file) {
            for (anchor, span) in &a.anchors {
                if only_file && a.root.join(&span.file) != file {
                    continue;
                }
                // Generated operations and inherited fields are not source declarations.
                if a.derivations.get(anchor).is_some() {
                    continue;
                }
                if anchor.contains('#')
                    && !anchor.contains("#field:")
                    && !anchor.contains("#step:")
                    && !anchor.contains("#lifecycle:")
                    && !anchor.contains("#message:")
                {
                    continue;
                }
                let name = anchor.rsplit(['/', ':']).next().unwrap_or(anchor);
                if !name.to_lowercase().contains(&query.to_lowercase()) {
                    continue;
                }
                if let Some(location) = a.location(span) {
                    symbols.push(json!({"name":name,"kind":if anchor.contains("field:") {8} else {13},"location":location,"containerName":anchor}));
                }
            }
        }
        symbols
    }

    fn completion(&self, file: &Path, line: usize, character: usize) -> Vec<Value> {
        use forgegraph_syntax::{SyntaxKind as K, ast::Declaration};
        let analysis = self.analysis(file);
        let Some(current) = analysis
            .iter()
            .find(|a| a.package.files.iter().any(|s| a.root.join(&s.path) == file))
        else {
            return vec![];
        };
        let Some(source) = current
            .package
            .files
            .iter()
            .find(|s| current.root.join(&s.path) == file)
        else {
            return vec![];
        };
        let Some(offset) = byte_position(&source.text, line, character) else {
            return vec![];
        };
        let parsed = forgegraph_syntax::parse(&source.text);
        let module_of = |p: &forgegraph_syntax::Parse| {
            p.root()
                .declarations()
                .find_map(|d| {
                    if let Declaration::Module(m) = d {
                        m.path().map(|p| p.text())
                    } else {
                        None
                    }
                })
                .unwrap_or_else(|| "_".into())
        };
        let module = module_of(&parsed);
        let workflow = parsed.root().declarations().find_map(|d| match d {
            Declaration::Workflow(w)
                if u32::from(w.syntax().text_range().start()) as usize <= offset
                    && offset <= u32::from(w.syntax().text_range().end()) as usize =>
            {
                Some(w)
            }
            _ => None,
        });
        if workflow.is_some()
            && let Some(result) = workflow_binding_completion(&analysis, current, source, offset)
        {
            return result;
        }
        let in_uses = parsed.syntax().descendants().any(|n| {
            n.kind() == K::USES_BLOCK
                && u32::from(n.text_range().start()) as usize <= offset
                && offset <= u32::from(n.text_range().end()) as usize
        });
        // Restrict type suggestions to the qualified name, excluding refinements and
        // literal type arguments. Nested collection element names have their own TypeRef.
        let type_name = parsed
            .syntax()
            .descendants()
            .filter_map(forgegraph_syntax::ast::TypeRef::cast)
            .filter_map(|ty| ty.name())
            .find(|name| {
                let range = name.syntax().text_range();
                u32::from(range.start()) as usize <= offset
                    && offset <= u32::from(range.end()) as usize
            });
        let in_type = type_name.is_some();
        if !in_uses && workflow.is_none() && !in_type {
            return vec![];
        }
        let in_wait = parsed.syntax().descendants().any(|n| {
            n.kind() == K::STEP_WAIT
                && u32::from(n.text_range().start()) as usize <= offset
                && offset <= u32::from(n.text_range().end()) as usize
        });
        let prefix = &source.text[..offset];
        let fail_context = prefix.lines().last().is_some_and(|line| {
            line.trim_start().starts_with("fail ") || line.contains("-> fail ")
        });
        if fail_context && let Some(workflow) = &workflow {
            return workflow
                .errors()
                .iter()
                .map(|e| json!({"label":e.text(), "kind":20, "detail":"declared workflow error"}))
                .collect();
        }
        let catch_target = if prefix
            .lines()
            .last()
            .is_some_and(|line| line.trim_start().starts_with("catch ") && !line.contains("->"))
        {
            parsed
                .syntax()
                .descendants()
                .filter_map(forgegraph_syntax::ast::StepCall::cast)
                .find(|call| {
                    u32::from(call.syntax().text_range().start()) as usize <= offset
                        && offset <= u32::from(call.syntax().text_range().end()) as usize
                })
                .and_then(|call| call.target())
                .and_then(|target| {
                    current
                        .compiled
                        .references
                        .iter()
                        .find(|r| {
                            r.span.file == source.path
                                && r.span.start
                                    == u32::from(target.syntax().text_range().start()) as usize
                        })
                        .map(|r| r.target.clone())
                })
        } else {
            None
        };
        let imports: std::collections::BTreeSet<String> = current
            .package
            .files
            .iter()
            .flat_map(|source| {
                let parsed = forgegraph_syntax::parse(&source.text);
                if module_of(&parsed) != module {
                    return vec![];
                }
                parsed
                    .root()
                    .declarations()
                    .filter_map(|d| {
                        if let Declaration::Import(i) = d {
                            i.alias()
                                .map(|a| a.text().to_string())
                                .or_else(|| i.path().map(|p| p.text()))
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        let mut result = vec![];
        if in_type {
            result.extend(
                forgegraph_semantic::compiler::SCALARS
                    .iter()
                    .map(|name| json!({"label":name,"kind":25,"detail":"built-in scalar"})),
            );
            result.extend(
                ["list", "set", "map"]
                    .iter()
                    .map(|name| json!({"label":name,"kind":7,"detail":"bounded collection"})),
            );
        }
        for a in &analysis {
            let local = a.root == current.root;
            let aliases: Vec<String> = if local {
                vec![String::new()]
            } else {
                current
                    .package
                    .dependencies
                    .iter()
                    .filter(|(alias, name)| name == &a.package.name && imports.contains(alias))
                    .map(|(alias, _)| format!("{alias}."))
                    .collect()
            };
            for source in &a.package.files {
                let parsed = forgegraph_syntax::parse(&source.text);
                let target_module = module_of(&parsed);
                if local && target_module != module {
                    continue;
                }
                if !in_type && !local && target_module != "_" {
                    continue;
                }
                for decl in parsed.root().declarations() {
                    if !local && !decl.is_exported() {
                        continue;
                    }
                    if in_type {
                        let Some(name) = decl.name() else { continue };
                        let mut names = match &decl {
                            Declaration::Shape(_) | Declaration::Enum(_) | Declaration::Type(_) => {
                                vec![name.text().to_string()]
                            }
                            Declaration::Resource(_) | Declaration::Blob(_) => {
                                ["", ".Record", ".Id", ".Status"]
                                    .iter()
                                    .map(|suffix| format!("{}{suffix}", name.text()))
                                    .collect()
                            }
                            Declaration::Channel(channel) => channel
                                .messages()
                                .filter_map(|m| {
                                    m.name().map(|message| {
                                        format!("{}.{}", name.text(), message.text())
                                    })
                                })
                                .collect(),
                            _ => vec![],
                        };
                        names.sort();
                        for alias in &aliases {
                            for name in &names {
                                result.push(json!({"label":format!("{alias}{name}"),"kind":7,"detail":format!("{}/{target_module}/{name}", a.package.name)}));
                            }
                        }
                        continue;
                    }
                    if in_wait {
                        if let Declaration::Channel(channel) = &decl
                            && let Some(name) = channel.name()
                        {
                            for alias in &aliases {
                                for message in channel.messages() {
                                    if let Some(message) = message.name() {
                                        result.push(json!({"label":format!("{alias}{}.{}", name.text(), message.text()), "kind":7, "detail":"workflow wait message"}));
                                    }
                                }
                            }
                        }
                        continue;
                    }
                    if !matches!(
                        decl,
                        Declaration::Resource(_) | Declaration::Blob(_) | Declaration::Function(_)
                    ) {
                        continue;
                    }
                    let Some(name) = decl.name() else {
                        continue;
                    };
                    for alias in &aliases {
                        let label = format!("{alias}{}", name.text());
                        let anchor =
                            format!("{}/{}/{}", a.package.name, target_module, name.text());
                        if let Some(target) = &catch_target {
                            if &anchor == target
                                && let Declaration::Function(function) = &decl
                            {
                                result.extend(function.errors().iter().map(|e| json!({"label":e.text(),"kind":20,"detail":format!("error declared by {anchor}")})));
                            }
                            continue;
                        }
                        if in_uses || matches!(decl, Declaration::Function(_)) {
                            result.push(json!({"label":label,"kind":if matches!(decl,Declaration::Function(_)){3}else{7},"detail":anchor}));
                        }
                        if let Declaration::Resource(resource) = &decl
                            && let Some(lifecycle) = resource.lifecycle()
                        {
                            for transition in lifecycle.transitions() {
                                if let Some(action) = transition.action() {
                                    result.push(json!({"label":format!("{label}.status.{}",action.text()),"kind":3,"detail":format!("{anchor}#lifecycle:status/transition:{}",action.text())}));
                                }
                            }
                        }
                    }
                }
            }
        }
        if let Some(name) = type_name {
            let range = name.syntax().text_range();
            let start = u32::from(range.start()) as usize;
            let prefix = &source.text[start..offset];
            result.retain(|item| {
                item["label"]
                    .as_str()
                    .is_some_and(|label| label.starts_with(prefix))
            });
            for item in &mut result {
                item["textEdit"] = json!({
                    "range": {"start":position(&source.text, start), "end":position(&source.text, u32::from(range.end()) as usize)},
                    "newText":item["label"],
                });
            }
        }
        result.sort_by_key(Value::to_string);
        result.dedup();
        result
    }

    fn diagnostics_for(&self, file: &Path) -> Vec<Value> {
        let analysis = self.analysis(file);
        let Some(current) = analysis.iter().find(|a| file.starts_with(&a.root)) else {
            return vec![];
        };
        let rel = file
            .strip_prefix(&current.root)
            .ok()
            .map(|p| p.to_string_lossy().replace('\\', "/"));
        let text = self
            .open
            .get(file)
            .cloned()
            .or_else(|| std::fs::read_to_string(file).ok())
            .unwrap_or_default();
        let out = &current.compiled;
        out.diagnostics
            .iter()
            .filter(|d| rel.as_deref().is_some_and(|r| d.file.replace('\\', "/") == r))
            .map(|d| {
                let message = match &d.suggestion {
                    Some(s) => format!("{} ({s})", d.message),
                    None => d.message.clone(),
                };
                json!({
                    "range": { "start": position(&text, d.start), "end": position(&text, d.end.max(d.start + 1)) },
                    "severity": if matches!(d.severity, forgegraph_semantic::diagnostics::Severity::Error) { 1 } else { 2 },
                    "code": d.code,
                    "source": "forgec",
                    "message": message,
                })
            })
            .collect()
    }
}

pub fn run() -> anyhow::Result<()> {
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut server = Server {
        open: BTreeMap::new(),
        roots: vec![],
        cache: RefCell::new(AnalysisCache::default()),
    };
    while let Some(msg) = read_message(&mut input) {
        let method = msg["method"].as_str().unwrap_or("");
        let id = msg.get("id").cloned();
        match method {
            "initialize" => {
                if let Some(uri) = msg["params"]["rootUri"].as_str() {
                    server.roots.push(uri_to_path(uri));
                }
                if let Some(folders) = msg["params"]["workspaceFolders"].as_array() {
                    for folder in folders {
                        if let Some(uri) = folder["uri"].as_str() {
                            server.roots.push(uri_to_path(uri));
                        }
                    }
                }
                write_message(
                    &mut out,
                    &json!({ "jsonrpc": "2.0", "id": id, "result": { "capabilities": { "textDocumentSync": 2, "documentFormattingProvider": true, "definitionProvider": true, "referencesProvider": true, "hoverProvider": true, "documentSymbolProvider": true, "workspaceSymbolProvider": true, "completionProvider": {"triggerCharacters":["."]} }, "serverInfo": { "name": "forgec", "version": env!("CARGO_PKG_VERSION") } } }),
                );
            }
            "initialized" => {}
            "textDocument/didOpen" | "textDocument/didChange" => {
                let uri = msg["params"]["textDocument"]["uri"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                let path = uri_to_path(&uri);
                let text = if method == "textDocument/didOpen" {
                    msg["params"]["textDocument"]["text"]
                        .as_str()
                        .unwrap_or("")
                        .to_string()
                } else {
                    let previous = server
                        .open
                        .get(&path)
                        .cloned()
                        .or_else(|| std::fs::read_to_string(&path).ok())
                        .unwrap_or_default();
                    let Some(changes) = msg["params"]["contentChanges"].as_array() else {
                        continue;
                    };
                    let Some(next) = apply_changes(&previous, changes) else {
                        continue;
                    };
                    next
                };
                server.open.insert(path.clone(), text);
                let diagnostics = server.diagnostics_for(&path);
                write_message(
                    &mut out,
                    &json!({ "jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": { "uri": uri, "diagnostics": diagnostics } }),
                );
            }
            "textDocument/didClose" => {
                let path = uri_to_path(msg["params"]["textDocument"]["uri"].as_str().unwrap_or(""));
                server.open.remove(&path);
            }
            "forge/analysisStats" => {
                let cache = server.cache.borrow();
                write_message(
                    &mut out,
                    &json!({"jsonrpc":"2.0","id":id,"result":{"stats":cache.stats(),"dependencies":cache.dependencies()}}),
                );
            }
            "textDocument/documentSymbol" | "workspace/symbol" => {
                let mut result = vec![];
                if method == "textDocument/documentSymbol" {
                    let path =
                        uri_to_path(msg["params"]["textDocument"]["uri"].as_str().unwrap_or(""));
                    result = server.symbols(&path, true, "");
                } else {
                    for path in server
                        .open
                        .keys()
                        .cloned()
                        .chain(server.roots.iter().map(|r| r.join("forge.toml")))
                    {
                        result.extend(server.symbols(
                            &path,
                            false,
                            msg["params"]["query"].as_str().unwrap_or(""),
                        ));
                    }
                    result.sort_by_key(Value::to_string);
                    result.dedup();
                }
                write_message(&mut out, &json!({"jsonrpc":"2.0","id":id,"result":result}));
            }
            "textDocument/hover" | "textDocument/references" | "textDocument/completion" => {
                let path = uri_to_path(msg["params"]["textDocument"]["uri"].as_str().unwrap_or(""));
                let line = msg["params"]["position"]["line"].as_u64().unwrap_or(0) as usize;
                let character =
                    msg["params"]["position"]["character"].as_u64().unwrap_or(0) as usize;
                let result = if method == "textDocument/completion" {
                    json!(server.completion(&path, line, character))
                } else if method == "textDocument/hover" {
                    server.hover(&path, line, character)
                } else {
                    json!(
                        server.references(
                            &path,
                            line,
                            character,
                            msg["params"]["context"]["includeDeclaration"]
                                .as_bool()
                                .unwrap_or(false)
                        )
                    )
                };
                write_message(&mut out, &json!({"jsonrpc":"2.0","id":id,"result":result}));
            }
            "textDocument/definition" => {
                let path = uri_to_path(msg["params"]["textDocument"]["uri"].as_str().unwrap_or(""));
                let line = msg["params"]["position"]["line"].as_u64().unwrap_or(0) as usize;
                let character =
                    msg["params"]["position"]["character"].as_u64().unwrap_or(0) as usize;
                let result = server.definition(&path, line, character);
                write_message(&mut out, &json!({"jsonrpc":"2.0","id":id,"result":result}));
            }
            "textDocument/formatting" => {
                let path = uri_to_path(msg["params"]["textDocument"]["uri"].as_str().unwrap_or(""));
                let text = server
                    .open
                    .get(&path)
                    .cloned()
                    .or_else(|| std::fs::read_to_string(&path).ok())
                    .unwrap_or_default();
                let formatted = forgegraph_syntax::format(&forgegraph_syntax::parse(&text));
                let edits = if formatted == text {
                    json!([])
                } else {
                    json!([{ "range": { "start": { "line": 0, "character": 0 }, "end": position(&text, text.len()) }, "newText": formatted }])
                };
                write_message(
                    &mut out,
                    &json!({ "jsonrpc": "2.0", "id": id, "result": edits }),
                );
            }
            "shutdown" => write_message(
                &mut out,
                &json!({ "jsonrpc": "2.0", "id": id, "result": null }),
            ),
            "exit" => break,
            _ if id.is_some() => write_message(
                &mut out,
                &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("method not found: {method}") } }),
            ),
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn facet_navigation_uses_unsaved_buffers_and_utf16_positions() {
        let root = std::env::temp_dir().join(format!("forge facet lsp {}", std::process::id()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("forge.toml"),"[package]\nname = \"@test/nav\"\nversion = \"0.1.0\"\nedition = \"2027\"\n[source]\nroot = \"src\"\nentry = \"src/model.forge\"\n").unwrap();
        std::fs::write(
            root.join("src/facet.forge"),
            "facet Spatial { x : integer }",
        )
        .unwrap();
        let path = root.join("src/model.forge");
        std::fs::write(&path, "resource R { id : id }").unwrap();
        let source = "// 🧭\nresource R @facet(Spatial) {\n id : id\n doubled := x + x\n}\n";
        let server = Server {
            open: BTreeMap::from([(path.clone(), source.into())]),
            roots: vec![],
            cache: RefCell::new(AnalysisCache::default()),
        };
        let location = server.definition(&path, 1, 19);
        assert_eq!(location.len(), 1);
        assert!(
            location[0]["uri"]
                .as_str()
                .unwrap()
                .ends_with("/src/facet.forge")
        );
        assert!(location[0]["uri"].as_str().unwrap().contains("%20"));
        let field = server.definition(&path, 3, 12);
        assert_eq!(field.len(), 1);
        assert_eq!(field[0]["range"]["start"]["character"], 16);
        assert_eq!(byte_position("a🧭b", 0, 3), Some(5));
        assert_eq!(byte_position("a🧭b", 0, 2), None);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cross_file_symbols_references_hover_and_scoped_uses_completion() {
        let root = std::env::temp_dir().join(format!("forge-semantic-lsp-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("forge.toml"),
            "[package]\nname = \"@test/nav\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
        let declarations = root.join("src/model.forge");
        std::fs::write(
            &declarations,
            "resource R { id : id }\nshape Input { value : text }\nfunction Callee {}\n",
        )
        .unwrap();
        let path = root.join("src/call.forge");
        let source = "function Caller {\n input Input\n uses {\n R read\n Callee\n }\n}\n";
        std::fs::write(&path, source).unwrap();
        let mut server = Server {
            open: BTreeMap::new(),
            roots: vec![root.clone()],
            cache: RefCell::new(AnalysisCache::default()),
        };
        assert!(server.diagnostics_for(&path).is_empty());
        assert_eq!(
            server.definition(&path, 1, 8)[0]["uri"],
            path_to_uri(&declarations)
        );
        assert_eq!(
            server.definition(&path, 4, 2)[0]["uri"],
            path_to_uri(&declarations)
        );
        assert_eq!(server.references(&declarations, 2, 10, false).len(), 1);
        assert_eq!(server.references(&declarations, 2, 10, true).len(), 2);
        assert!(
            server.hover(&path, 4, 2)["contents"]["value"]
                .as_str()
                .unwrap()
                .contains("@test/nav/_/Callee")
        );
        assert_eq!(server.symbols(&path, false, "Caller").len(), 1);
        assert_eq!(server.symbols(&path, true, "Caller").len(), 1);
        let completion = server.completion(&path, 4, 1);
        assert!(completion.iter().any(|v| v["label"] == "Callee"));
        assert!(completion.iter().any(|v| v["label"] == "R"));
        assert!(!completion.iter().any(|v| v["label"] == "Input"));
        assert!(
            server
                .completion(&path, 1, 8)
                .iter()
                .any(|v| v["label"] == "Input")
        );
        server
            .open
            .insert(path.clone(), source.replace("Callee", "Missing"));
        assert!(!server.diagnostics_for(&path).is_empty());
        assert_eq!(server.symbols(&path, true, "Caller").len(), 1);
        assert_eq!(server.references(&declarations, 2, 10, false).len(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn workflow_completion_uses_real_scope_types_and_navigates_bindings() {
        let root = std::env::temp_dir().join(format!("forge-workflow-lsp-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("forge.toml"),
            "[package]\nname = \"@test/workflow-nav\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
        let path = root.join("src/workflow.forge");
        let source = "shape Payload { value : text }\nfunction Echo { input Payload\n output Payload }\nworkflow Flow {\n input Payload\n output Payload\n version 1\n step first = Echo(value: input.value)\n step second = Echo(value: first.value)\n return second\n}\n";
        std::fs::write(&path, source).unwrap();
        let mut server = Server {
            open: BTreeMap::new(),
            roots: vec![root.clone()],
            cache: RefCell::new(AnalysisCache::default()),
        };
        assert!(
            server.diagnostics_for(&path).is_empty(),
            "{:?}",
            server.diagnostics_for(&path)
        );
        let complete = |server: &Server, text: &str, needle: &str| {
            let offset = text.find(needle).unwrap() + needle.len();
            let pos = position(text, offset);
            server.completion(
                &path,
                pos["line"].as_u64().unwrap() as usize,
                pos["character"].as_u64().unwrap() as usize,
            )
        };
        assert!(
            complete(&server, source, "value: first.")
                .iter()
                .any(|v| v["label"] == "value")
        );
        let bindings = complete(&server, source, "value: first");
        assert!(bindings.iter().any(|v| v["label"] == "first"));
        assert!(!bindings.iter().any(|v| v["label"] == "second"));
        let first_use = position(source, source.find("first.value").unwrap());
        let definition = server.definition(
            &path,
            first_use["line"].as_u64().unwrap() as usize,
            first_use["character"].as_u64().unwrap() as usize,
        );
        assert_eq!(definition[0]["range"]["start"]["line"], 7);
        let incomplete = source.replace("first.value", "first.");
        server.open.insert(path.clone(), incomplete.clone());
        assert!(
            complete(&server, &incomplete, "value: first.")
                .iter()
                .any(|v| v["label"] == "value")
        );
        let errors_source = source
            .replace(
                "function Echo { input Payload\n output Payload }",
                "function Echo { input Payload\n output Payload\n errors { Rejected } }",
            )
            .replace(
                " step second = Echo(value: first.value)",
                " step second = Echo(value: first.value)\n catch Rejected -> fail Stopped",
            )
            .replace(" return second", " return second\n errors { Stopped }");
        server.open.insert(path.clone(), errors_source.clone());
        let catches = complete(&server, &errors_source, "catch R");
        assert!(
            catches.iter().any(|v| v["label"] == "Rejected"),
            "{catches:?}"
        );
        let failures = complete(&server, &errors_source, "fail S");
        assert!(failures.iter().any(|v| v["label"] == "Stopped"));
        let wait_source = source
            .replace(
                "workflow Flow",
                "channel Events { message Arrived { value : text } }\nworkflow Flow",
            )
            .replace(
                " step second = Echo(value: first.value)",
                " step received = wait Events.Arrived\n step second = Echo(value: received.value)",
            );
        server.open.insert(path.clone(), wait_source.clone());
        let messages = complete(&server, &wait_source, "wait Events.");
        assert!(messages.iter().any(|v| v["label"] == "Events.Arrived"));
        assert!(
            complete(&server, &wait_source, "value: received.")
                .iter()
                .any(|v| v["label"] == "value")
        );
        let branch_source = source.replace(" step second = Echo(value: first.value)", " if input.value == \"yes\" {\n step hidden = Echo(value: first.value)\n } else {\n step second = Echo(value: first.value)\n }");
        server.open.insert(path.clone(), branch_source.clone());
        let offset = branch_source.rfind("value: first").unwrap() + "value: first".len();
        let pos = position(&branch_source, offset);
        let suggestions = server.completion(
            &path,
            pos["line"].as_u64().unwrap() as usize,
            pos["character"].as_u64().unwrap() as usize,
        );
        assert!(suggestions.iter().any(|v| v["label"] == "first"));
        assert!(!suggestions.iter().any(|v| v["label"] == "hidden"));
        let parallel = source.replace(" step second = Echo(value: first.value)", " parallel {\n step hidden = Echo(value: first.value)\n step second = Echo(value: first.value)\n }");
        server.open.insert(path.clone(), parallel.clone());
        let offset = parallel.rfind("value: first").unwrap() + "value: first".len();
        let pos = position(&parallel, offset);
        let suggestions = server.completion(
            &path,
            pos["line"].as_u64().unwrap() as usize,
            pos["character"].as_u64().unwrap() as usize,
        );
        assert!(!suggestions.iter().any(|v| v["label"] == "hidden"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workflow_map_items_have_local_completion_and_distinct_navigation() {
        let root = std::env::temp_dir().join(format!("forge-map-lsp-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("forge.toml"),
            "[package]\nname = \"@test/map-nav\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
        let path = root.join("src/model.forge");
        let source = "shape Item { value : text }\nshape Batch { items : list<Item> length <= 8 }\nfunction Echo { input Item\n output Item }\nworkflow Flow {\n input Batch\n version 1\n step first = map item in input.items concurrency 2 {\n Echo(value: item.value)\n }\n step second = map item in input.items concurrency 2 {\n Echo(value: item.value)\n }\n return second\n}\n";
        std::fs::write(&path, source).unwrap();
        let mut server = Server {
            open: BTreeMap::new(),
            roots: vec![root.clone()],
            cache: RefCell::new(AnalysisCache::default()),
        };
        assert!(
            server.diagnostics_for(&path).is_empty(),
            "{:?}",
            server.diagnostics_for(&path)
        );
        let at = |text: &str, offset: usize| {
            let p = position(text, offset);
            (
                p["line"].as_u64().unwrap() as usize,
                p["character"].as_u64().unwrap() as usize,
            )
        };
        for (offset, expected_line) in source
            .match_indices("item.value")
            .map(|(i, _)| i)
            .zip([7, 10])
        {
            let (line, col) = at(source, offset);
            let definitions = server.definition(&path, line, col);
            assert_eq!(definitions.len(), 1);
            assert_eq!(definitions[0]["range"]["start"]["line"], expected_line);
            let references = server.references(&path, line, col, true);
            assert_eq!(
                references.len(),
                2,
                "map items must not share reference identities"
            );
            let (line, col) = at(source, offset + "item.".len());
            assert!(
                server
                    .completion(&path, line, col)
                    .iter()
                    .any(|v| v["label"] == "value")
            );
            let (line, col) = at(source, offset + "item".len());
            assert!(
                server
                    .completion(&path, line, col)
                    .iter()
                    .any(|v| v["label"] == "item")
            );
        }
        for needle in ["in input", "return second"] {
            let (line, col) = at(source, source.rfind(needle).unwrap() + needle.len());
            assert!(
                !server
                    .completion(&path, line, col)
                    .iter()
                    .any(|v| v["label"] == "item")
            );
        }
        let incomplete = source.replacen("item.value", "item.", 1);
        server.open.insert(path.clone(), incomplete.clone());
        let (line, col) = at(
            &incomplete,
            incomplete.find("item.").unwrap() + "item.".len(),
        );
        assert!(
            server
                .completion(&path, line, col)
                .iter()
                .any(|v| v["label"] == "value")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn imported_symbols_resolve_and_completion_hides_private_declarations() {
        let root = std::env::temp_dir().join(format!("forge-import-lsp-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("dep/src")).unwrap();
        std::fs::write(root.join("forge.toml"), "[package]\nname = \"@test/root\"\nversion = \"0.1.0\"\n[dependencies]\ndep = { path = \"dep\" }\n").unwrap();
        std::fs::write(
            root.join("dep/forge.toml"),
            "[package]\nname = \"@test/dep\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
        std::fs::write(
            root.join("dep/src/index.forge"),
            "export function Public {}\nfunction Private {}\n",
        )
        .unwrap();
        let path = root.join("src/index.forge");
        std::fs::write(
            &path,
            "import dep\nfunction Caller {\n uses {\n dep.Public\n }\n}\n",
        )
        .unwrap();
        let mut server = Server {
            open: BTreeMap::new(),
            roots: vec![root.clone()],
            cache: RefCell::new(AnalysisCache::default()),
        };
        assert!(
            server.diagnostics_for(&path).is_empty(),
            "{:?}",
            server.diagnostics_for(&path)
        );
        assert!(
            server.definition(&path, 3, 5)[0]["uri"]
                .as_str()
                .unwrap()
                .ends_with("dep/src/index.forge")
        );
        let declaration = root.join("dep/src/index.forge");
        let references = server.references(&declaration, 0, 18, false);
        assert_eq!(
            references.len(),
            1,
            "dependency declaration must find its workspace caller"
        );
        assert_eq!(references[0]["uri"], path_to_uri(&path));
        let completions = server.completion(&path, 3, 1);
        assert!(completions.iter().any(|v| v["label"] == "dep.Public"));
        assert!(!completions.iter().any(|v| v["label"] == "dep.Private"));
        // Another checkout of the same package must not contribute its own callers.
        let other = root.join("other");
        std::fs::create_dir_all(other.join("src")).unwrap();
        std::fs::write(
            other.join("forge.toml"),
            "[package]\nname = \"@test/dep\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
        std::fs::write(
            other.join("src/index.forge"),
            "export function Public {}\nfunction Local { uses { Public } }\n",
        )
        .unwrap();
        server.roots.push(other);
        assert_eq!(server.references(&declaration, 0, 18, false).len(), 1);
        // Open-buffer edits invalidate callers even when the request targets the dependency.
        server
            .open
            .insert(path.clone(), "import dep\nfunction Caller {}\n".into());
        assert!(server.references(&declaration, 0, 18, false).is_empty());
        assert_eq!(server.references(&declaration, 0, 18, true).len(), 1);
        // Open packages are searched even without a workspace-folder registration.
        server.roots.clear();
        server.open.insert(
            path.clone(),
            "import dep\nfunction Caller { uses { dep.Public } }\n".into(),
        );
        assert_eq!(server.references(&declaration, 0, 18, false).len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn type_completion_filters_visibility_and_replaces_qualified_names() {
        let root = std::env::temp_dir().join(format!("forge-type-lsp-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("dep/src")).unwrap();
        std::fs::write(root.join("forge.toml"), "[package]\nname = \"@test/types\"\nversion = \"0.1.0\"\n[dependencies]\ndep = { path = \"dep\" }\n").unwrap();
        std::fs::write(
            root.join("dep/forge.toml"),
            "[package]\nname = \"@test/contracts\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
        std::fs::write(root.join("dep/src/index.forge"), "export shape Public { value : text }\nshape Private { value : text }\nexport resource Record { id : id }\nexport function Run {}\n").unwrap();
        std::fs::write(
            root.join("src/hidden.forge"),
            "module hidden\nshape Hidden { value : text }\n",
        )
        .unwrap();
        let path = root.join("src/index.forge");
        let source = "import dep\nshape Local { value : text }\nchannel Events { message Arrived { value : text } }\nshape Input {\n a : dep.Public\n b : list<Local> length <= 8\n c : text\n d : Events.Arrived\n}\nfunction Caller { input Local\n output dep.Public }\n";
        std::fs::write(&path, source).unwrap();
        let mut server = Server {
            open: BTreeMap::new(),
            roots: vec![root.clone()],
            cache: RefCell::new(AnalysisCache::default()),
        };
        assert!(
            server.diagnostics_for(&path).is_empty(),
            "{:?}",
            server.diagnostics_for(&path)
        );
        let complete = |server: &Server, text: &str, needle: &str| {
            let offset = text.rfind(needle).unwrap() + needle.len();
            let pos = position(text, offset);
            server.completion(
                &path,
                pos["line"].as_u64().unwrap() as usize,
                pos["character"].as_u64().unwrap() as usize,
            )
        };
        let imported = complete(&server, source, "a : dep.");
        assert!(imported.iter().any(|v| v["label"] == "dep.Public"));
        assert!(imported.iter().any(|v| v["label"] == "dep.Record.Id"));
        assert!(
            !imported
                .iter()
                .any(|v| v["label"] == "dep.Private" || v["label"] == "dep.Run")
        );
        let public = imported
            .iter()
            .find(|v| v["label"] == "dep.Public")
            .unwrap();
        assert_eq!(
            public["textEdit"]["range"]["start"],
            json!({"line":4,"character":5})
        );
        assert_eq!(
            public["textEdit"]["range"]["end"],
            json!({"line":4,"character":15})
        );
        assert_eq!(public["textEdit"]["newText"], "dep.Public");
        assert!(
            complete(&server, source, "list<Lo")
                .iter()
                .any(|v| v["label"] == "Local")
        );
        assert!(
            complete(&server, source, "c : te")
                .iter()
                .any(|v| v["label"] == "text")
        );
        assert!(
            complete(&server, source, "d : Events.")
                .iter()
                .any(|v| v["label"] == "Events.Arrived")
        );
        assert!(complete(&server, source, "length <= ").is_empty());
        assert!(
            complete(&server, source, "input Lo")
                .iter()
                .any(|v| v["label"] == "Local")
        );
        assert!(
            complete(&server, source, "output dep.")
                .iter()
                .any(|v| v["label"] == "dep.Public")
        );
        let incomplete = source.replace("a : dep.Public", "a : dep.");
        server.open.insert(path.clone(), incomplete.clone());
        assert!(
            complete(&server, &incomplete, "a : dep.")
                .iter()
                .any(|v| v["label"] == "dep.Public")
        );
        let unimported = source.replace("import dep\n", "");
        server.open.insert(path.clone(), unimported.clone());
        assert!(complete(&server, &unimported, "a : dep.").is_empty());
        let all = complete(&server, &unimported, "c : ");
        assert!(!all.iter().any(|v| v["label"] == "Hidden" || v["label"].as_str().unwrap().starts_with("dep.")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn incremental_changes_follow_utf16_and_sequential_ranges() {
        let changes = json!([
            {"range":{"start":{"line":0,"character":1},"end":{"line":0,"character":3}},"text":"hello"},
            {"range":{"start":{"line":0,"character":6},"end":{"line":0,"character":7}},"text":"!"}
        ]);
        assert_eq!(
            apply_changes("a🧭b", changes.as_array().unwrap()).as_deref(),
            Some("ahello!")
        );
        assert!(apply_changes("a🧭b",&[json!({"range":{"start":{"line":0,"character":2},"end":{"line":0,"character":3}},"text":"x"})]).is_none());
        assert_eq!(
            apply_changes("old", &[json!({"text":"new"})]).as_deref(),
            Some("new")
        );
    }
}
