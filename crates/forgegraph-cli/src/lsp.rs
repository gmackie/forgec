//! `forgec lsp`: a small Language Server over stdio (plan M8 "LSP basics").
//! Full document sync; on open/change the owning package is recompiled and
//! diagnostics (with suggestions) are published for the edited file;
//! `textDocument/formatting` returns the canonical formatting. Hand-rolled
//! JSON-RPC keeps the compiler core free of server frameworks.
use forgegraph_semantic::{compile, load_package};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

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
    let offset = offset.min(text.len());
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

struct Server {
    /// Open documents by absolute path: the compiler reads these instead of disk.
    open: BTreeMap<PathBuf, String>,
}

impl Server {
    fn definition(&self, file: &Path, line: usize, character: usize) -> Vec<Value> {
        let Some(root) = package_root(file) else {
            return vec![];
        };
        let Ok(mut pkg) = load_package(&root) else {
            return vec![];
        };
        for source in &mut pkg.files {
            if let Some(text) = self.open.get(&root.join(&source.path)) {
                source.text = text.clone();
            }
        }
        let dep_pkgs: Vec<_> = pkg
            .dependency_paths
            .iter()
            .filter_map(|(_, p)| load_package(p).ok().map(|pkg| (p.clone(), pkg)))
            .collect();
        let deps: Vec<_> = dep_pkgs.iter().map(|(_, p)| compile(p, &[])).collect();
        let compiled = compile(
            &pkg,
            &deps
                .iter()
                .filter_map(|c| c.ir.as_ref())
                .collect::<Vec<_>>(),
        );
        let Some(relative) = file
            .strip_prefix(&root)
            .ok()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
        else {
            return vec![];
        };
        let Some(source) = pkg
            .files
            .iter()
            .find(|s| s.path.replace('\\', "/") == relative)
        else {
            return vec![];
        };
        let Some(offset) = byte_position(&source.text, line, character) else {
            return vec![];
        };
        let target = compiled
            .references
            .iter()
            .filter(|r| r.span.file == relative && r.span.start <= offset && offset < r.span.end)
            .min_by_key(|r| r.span.end - r.span.start)
            .map(|r| r.target.clone());
        let Some(target) = target else {
            return vec![];
        };
        let mut locations = Vec::new();
        let mut add = |base: &Path,
                       package: &forgegraph_semantic::Package,
                       out: &forgegraph_semantic::Compilation| {
            if let Some(span) = out.source_index.get(&target)
                && let Some(text) = package
                    .files
                    .iter()
                    .find(|s| s.path.replace('\\', "/") == span.file)
                    .map(|s| s.text.as_str())
            {
                locations.push(json!({"uri":path_to_uri(&base.join(&span.file)),"range":{"start":position(text,span.start),"end":position(text,span.end)}}));
            }
        };
        add(&root, &pkg, &compiled);
        for ((root, pkg), out) in dep_pkgs.iter().zip(deps.iter()) {
            add(root, pkg, out);
        }
        locations
    }

    fn diagnostics_for(&self, file: &Path) -> Vec<Value> {
        let Some(root) = package_root(file) else {
            return vec![];
        };
        let Ok(mut pkg) = load_package(&root) else {
            return vec![];
        };
        // Overlay unsaved buffers (file paths are package-root relative).
        for f in &mut pkg.files {
            if let Some(text) = self.open.get(&root.join(&f.path)) {
                f.text = text.clone();
            }
        }
        let rel = file
            .strip_prefix(&root)
            .ok()
            .map(|p| p.to_string_lossy().replace('\\', "/"));
        let text = self
            .open
            .get(file)
            .cloned()
            .or_else(|| std::fs::read_to_string(file).ok())
            .unwrap_or_default();
        let deps: Vec<forgegraph_semantic::DomainIR> = pkg
            .dependency_paths
            .iter()
            .filter_map(|(_, p)| load_package(p).ok())
            .filter_map(|d| compile(&d, &[]).ir)
            .collect();
        let out = compile(&pkg, &deps.iter().collect::<Vec<_>>());
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
    };
    while let Some(msg) = read_message(&mut input) {
        let method = msg["method"].as_str().unwrap_or("");
        let id = msg.get("id").cloned();
        match method {
            "initialize" => write_message(
                &mut out,
                &json!({ "jsonrpc": "2.0", "id": id, "result": { "capabilities": { "textDocumentSync": 1, "documentFormattingProvider": true, "definitionProvider": true }, "serverInfo": { "name": "forgec", "version": env!("CARGO_PKG_VERSION") } } }),
            ),
            "initialized" => {}
            "textDocument/didOpen" | "textDocument/didChange" => {
                let uri = msg["params"]["textDocument"]["uri"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                let text = if method == "textDocument/didOpen" {
                    msg["params"]["textDocument"]["text"]
                        .as_str()
                        .unwrap_or("")
                        .to_string()
                } else {
                    msg["params"]["contentChanges"][0]["text"]
                        .as_str()
                        .unwrap_or("")
                        .to_string()
                };
                let path = uri_to_path(&uri);
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
}
