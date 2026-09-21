//! `forge lsp`: a small Language Server over stdio (plan M8 "LSP basics").
//! Full document sync; on open/change the owning package is recompiled and
//! diagnostics (with suggestions) are published for the edited file;
//! `textDocument/formatting` returns the canonical formatting. Hand-rolled
//! JSON-RPC keeps the compiler core free of server frameworks.
use forge_semantic::{compile, load_package};
use serde_json::{json, Value};
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
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
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

struct Server {
    /// Open documents by absolute path: the compiler reads these instead of disk.
    open: BTreeMap<PathBuf, String>,
}

impl Server {
    fn diagnostics_for(&self, file: &Path) -> Vec<Value> {
        let Some(root) = package_root(file) else { return vec![] };
        let Ok(mut pkg) = load_package(&root) else { return vec![] };
        // Overlay unsaved buffers (file paths are package-root relative).
        for f in &mut pkg.files {
            if let Some(text) = self.open.get(&root.join(&f.path)) {
                f.text = text.clone();
            }
        }
        let rel = file.strip_prefix(&root).ok().map(|p| p.to_string_lossy().replace('\\', "/"));
        let text = self.open.get(file).cloned().or_else(|| std::fs::read_to_string(file).ok()).unwrap_or_default();
        let deps: Vec<forge_semantic::DomainIR> = pkg
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
                    "severity": if matches!(d.severity, forge_semantic::diagnostics::Severity::Error) { 1 } else { 2 },
                    "code": d.code,
                    "source": "forge",
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
    let mut server = Server { open: BTreeMap::new() };
    while let Some(msg) = read_message(&mut input) {
        let method = msg["method"].as_str().unwrap_or("");
        let id = msg.get("id").cloned();
        match method {
            "initialize" => write_message(&mut out, &json!({ "jsonrpc": "2.0", "id": id, "result": { "capabilities": { "textDocumentSync": 1, "documentFormattingProvider": true }, "serverInfo": { "name": "forge", "version": env!("CARGO_PKG_VERSION") } } })),
            "initialized" => {}
            "textDocument/didOpen" | "textDocument/didChange" => {
                let uri = msg["params"]["textDocument"]["uri"].as_str().unwrap_or("").to_string();
                let text = if method == "textDocument/didOpen" { msg["params"]["textDocument"]["text"].as_str().unwrap_or("").to_string() } else { msg["params"]["contentChanges"][0]["text"].as_str().unwrap_or("").to_string() };
                let path = uri_to_path(&uri);
                server.open.insert(path.clone(), text);
                let diagnostics = server.diagnostics_for(&path);
                write_message(&mut out, &json!({ "jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": { "uri": uri, "diagnostics": diagnostics } }));
            }
            "textDocument/didClose" => {
                let path = uri_to_path(msg["params"]["textDocument"]["uri"].as_str().unwrap_or(""));
                server.open.remove(&path);
            }
            "textDocument/formatting" => {
                let path = uri_to_path(msg["params"]["textDocument"]["uri"].as_str().unwrap_or(""));
                let text = server.open.get(&path).cloned().or_else(|| std::fs::read_to_string(&path).ok()).unwrap_or_default();
                let formatted = forge_syntax::format(&forge_syntax::parse(&text));
                let edits = if formatted == text { json!([]) } else { json!([{ "range": { "start": { "line": 0, "character": 0 }, "end": position(&text, text.len()) }, "newText": formatted }]) };
                write_message(&mut out, &json!({ "jsonrpc": "2.0", "id": id, "result": edits }));
            }
            "shutdown" => write_message(&mut out, &json!({ "jsonrpc": "2.0", "id": id, "result": null })),
            "exit" => break,
            _ if id.is_some() => write_message(&mut out, &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("method not found: {method}") } })),
            _ => {}
        }
    }
    Ok(())
}
