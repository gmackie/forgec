//! `forgec check` and `forgec build` over an in-memory source tree, so the
//! compiler runs where there is no filesystem (a Cloudflare Worker isolate).
//! The caller supplies every file the CLI would read: manifests, sources,
//! `forge.lock`, path dependencies and pinned extension manifests.

use forgegraph_codegen::pipeline::{self, LockStatus};
use forgegraph_semantic::MemoryTree;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    /// Package root inside `files`, e.g. `examples/acme`.
    root: String,
    /// `/`-separated path -> UTF-8 contents.
    files: BTreeMap<String, String>,
    /// `forgec build --service-id`.
    #[serde(default)]
    service_id: Option<String>,
    /// `FORGE_SOURCE_REVISION` for the source map.
    #[serde(default)]
    source_revision: Option<String>,
}

fn tree(request: &Request) -> MemoryTree {
    MemoryTree::new(
        request
            .files
            .iter()
            .map(|(path, text)| (path.clone(), text.as_bytes().to_vec())),
    )
}

/// The error and its causes on one line, as `anyhow`'s `{:#}` would print them.
fn chain(error: &dyn std::error::Error) -> String {
    let mut out = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        out.push_str(": ");
        out.push_str(&cause.to_string());
        source = cause.source();
    }
    out
}

fn failure(error: &pipeline::Error) -> Value {
    json!({"ok": false, "error": chain(error), "rendered": error.rendered().unwrap_or("")})
}

fn lock_name(status: LockStatus) -> &'static str {
    match status {
        LockStatus::Current => "current",
        LockStatus::Missing => "missing",
        LockStatus::Stale => "stale",
    }
}

/// `forgec check <root>`: diagnostics plus the lock and extension verdicts.
pub fn check(input: &str) -> Value {
    let request = match serde_json::from_str::<Request>(input) {
        Ok(request) => request,
        Err(e) => return json!({"ok": false, "error": format!("invalid check request: {e}")}),
    };
    let tree = tree(&request);
    let root = Path::new(&request.root);
    let loaded = match pipeline::load_tree(&tree, root) {
        Ok(loaded) => loaded,
        Err(e) => return failure(&e),
    };
    let lock = pipeline::lock_status(&tree, root, &loaded);
    let diagnostics = &loaded.compilation.diagnostics;
    let errors = diagnostics.iter().filter(|d| d.is_error()).count();
    json!({
        "ok": errors == 0 && lock != LockStatus::Stale,
        "package": loaded.package.name,
        "files": loaded.package.files.len(),
        "dependencies": loaded.deps.len(),
        "errors": errors,
        "warnings": diagnostics.len() - errors,
        "lock": lock_name(lock),
        "diagnostics": diagnostics,
        "rendered": loaded.compilation.render(),
    })
}

/// `forgec build <root>`: every artifact the CLI writes, keyed by path relative to the output directory.
pub fn build(input: &str) -> Value {
    let request = match serde_json::from_str::<Request>(input) {
        Ok(request) => request,
        Err(e) => return json!({"ok": false, "error": format!("invalid build request: {e}")}),
    };
    if let Some(id) = &request.service_id
        && !forgegraph_codegen::contract_ir::emit::is_identifier(id)
    {
        return json!({"ok": false, "error": format!("--service-id `{id}` is not an identifier (letters, digits, _ and -, starting with a letter)")});
    }
    let tree = tree(&request);
    let root = Path::new(&request.root);
    let loaded = match pipeline::load_tree(&tree, root) {
        Ok(loaded) => loaded,
        Err(e) => return failure(&e),
    };
    let lock = pipeline::lock_status(&tree, root, &loaded);
    let rendered = loaded.compilation.render();
    if lock == LockStatus::Stale {
        return json!({"ok": false, "lock": "stale", "error": "error[E-LOCK-001]: forge.lock is stale", "rendered": rendered});
    }
    let Some(ir) = loaded.compilation.ir.as_ref() else {
        return json!({"ok": false, "lock": lock_name(lock), "error": "compilation failed", "rendered": rendered});
    };
    let plans = match forgegraph_planner::plan(ir) {
        Ok(plans) => plans,
        Err(e) => {
            return json!({"ok": false, "lock": lock_name(lock), "error": e.to_string(), "rendered": rendered});
        }
    };
    let artifacts = pipeline::artifacts(
        &loaded,
        ir,
        &plans,
        request.service_id.clone(),
        request.source_revision.as_deref(),
    );
    let files: serde_json::Map<String, Value> = artifacts
        .files
        .into_iter()
        .map(|(path, text)| (path, Value::String(text)))
        .collect();
    json!({
        "ok": true,
        "package": loaded.package.name,
        "lock": lock_name(lock),
        "files": files,
        "warnings": artifacts.warnings,
        "rendered": rendered,
    })
}

// The same owned-buffer ABI as forgegraph-editor: no generated JS glue, no wasm-bindgen.
#[cfg(target_arch = "wasm32")]
mod wasm {
    #[unsafe(no_mangle)]
    pub extern "C" fn forgec_alloc(len: usize) -> *mut u8 {
        Box::into_raw(vec![0u8; len].into_boxed_slice()).cast::<u8>()
    }
    /// # Safety
    /// `ptr` and `len` must be a live allocation returned by this module, freed exactly once.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn forgec_free(ptr: *mut u8, len: usize) {
        unsafe {
            drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
        }
    }
    /// # Safety
    /// `ptr` must reference `len` initialized bytes in this module's memory for this call.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn forgec_check(ptr: *const u8, len: usize) -> u64 {
        let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
        pack(&super::check(std::str::from_utf8(bytes).unwrap_or("")))
    }
    /// # Safety
    /// `ptr` must reference `len` initialized bytes in this module's memory for this call.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn forgec_build(ptr: *const u8, len: usize) -> u64 {
        let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
        pack(&super::build(std::str::from_utf8(bytes).unwrap_or("")))
    }
    fn pack(value: &serde_json::Value) -> u64 {
        let output = value.to_string().into_bytes().into_boxed_slice();
        let len = output.len();
        let ptr = Box::into_raw(output).cast::<u8>();
        ((ptr as u64) << 32) | len as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use forgegraph_semantic::OsTree;
    use std::path::PathBuf;

    fn repo() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    /// Every file `forgec build examples/acme` reads, keyed by repository-relative path.
    fn acme_files() -> BTreeMap<String, String> {
        let mut files = BTreeMap::new();
        let read = |rel: &str| std::fs::read_to_string(repo().join(rel)).expect(rel);
        for rel in [
            "examples/acme/forge.toml",
            "examples/acme/forge.lock",
            "examples/payments/forge.toml",
            "packages/contracts/capability-manifest/manifests/d1.json",
            "packages/contracts/capability-manifest/manifests/dynamodb.json",
        ] {
            files.insert(rel.to_string(), read(rel));
        }
        for dir in ["examples/acme/src", "examples/payments/src"] {
            let mut stack = vec![repo().join(dir)];
            while let Some(dir) = stack.pop() {
                for entry in std::fs::read_dir(dir).unwrap() {
                    let path = entry.unwrap().path();
                    if path.is_dir() {
                        stack.push(path);
                    } else if path.extension().is_some_and(|e| e == "forge") {
                        let rel = path.strip_prefix(repo()).unwrap().to_string_lossy();
                        files.insert(
                            rel.replace('\\', "/"),
                            std::fs::read_to_string(&path).unwrap(),
                        );
                    }
                }
            }
        }
        files
    }

    fn request(files: &BTreeMap<String, String>) -> String {
        json!({"root": "examples/acme", "files": files}).to_string()
    }

    #[test]
    fn checks_acme_from_memory() {
        let result = check(&request(&acme_files()));
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["package"], "@acme/commerce");
        assert_eq!(result["dependencies"], 1);
        assert_eq!(result["lock"], "current");
    }

    #[test]
    fn builds_acme_from_memory_exactly_as_from_disk() {
        let result = build(&request(&acme_files()));
        assert_eq!(result["ok"], true, "{result}");
        let root = repo().join("examples/acme");
        let loaded = pipeline::load_tree(&OsTree, &root).unwrap();
        let ir = loaded.compilation.ir.as_ref().unwrap();
        let plans = forgegraph_planner::plan(ir).unwrap();
        let disk = pipeline::artifacts(&loaded, ir, &plans, None, None);
        assert_eq!(result["files"].as_object().unwrap().len(), disk.files.len());
        for (path, text) in &disk.files {
            assert_eq!(
                result["files"][path].as_str(),
                Some(text.as_str()),
                "{path}"
            );
        }
    }

    #[test]
    fn reports_missing_dependencies_and_tampered_pins() {
        let mut files = acme_files();
        files.retain(|path, _| !path.starts_with("examples/payments/"));
        let result = check(&request(&files));
        assert_eq!(result["ok"], false);
        assert!(
            result["error"]
                .as_str()
                .unwrap()
                .contains("examples/payments/forge.toml"),
            "{result}"
        );

        let mut files = acme_files();
        files
            .get_mut("packages/contracts/capability-manifest/manifests/d1.json")
            .unwrap()
            .push(' ');
        let result = build(&request(&files));
        assert!(
            result["error"].as_str().unwrap().contains("E-EXT-001"),
            "{result}"
        );
    }

    #[test]
    fn a_stale_lock_fails_check() {
        let mut files = acme_files();
        files.insert("examples/acme/forge.lock".into(), "lock = 1\n".into());
        let result = check(&request(&files));
        assert_eq!(result["ok"], false);
        assert_eq!(result["lock"], "stale");
    }
}
