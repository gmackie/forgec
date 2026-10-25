//! `forgec check` and `forgec build` over an in-memory source tree, so the
//! compiler runs where there is no filesystem (a Cloudflare Worker isolate).
//! The caller supplies every file the CLI would read: manifests, sources,
//! `forge.lock`, path dependencies and pinned extension manifests.
//!
//! A host that fetches sources lazily (the FORG-50 build service over Cloudflare
//! Artifacts) can also pass directory listings, and reads the `missing` paths
//! every response reports: what the compiler looked for and did not find. It
//! fetches those and calls again until nothing new turns up.

use forgegraph_codegen::pipeline::{self, LockStatus};
use forgegraph_semantic::SourceTree;
use serde::Deserialize;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Component, Path, PathBuf};

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
    /// Directory listings, `dir -> [(name, is_dir)]`, for directories whose files
    /// are not all in `files` yet. Directories without one exist implicitly, as
    /// the parents of the files given.
    #[serde(default)]
    dirs: BTreeMap<String, Vec<(String, bool)>>,
    /// `forgec build --units`: also emit `units/plan.json`.
    #[serde(default)]
    units: bool,
    /// Emit the regular build artifacts (default). `false` with `units` emits the plan alone.
    #[serde(default = "yes")]
    artifacts: bool,
}

fn yes() -> bool {
    true
}

/// The request's files and listings as a [`SourceTree`]. Paths are resolved
/// lexically, as `MemoryTree` resolves them; with no listings it answers
/// exactly as `MemoryTree` does. Every lookup that misses is recorded.
struct Snapshot {
    files: BTreeMap<PathBuf, Vec<u8>>,
    dirs: BTreeMap<PathBuf, Vec<(PathBuf, bool)>>,
    missing: RefCell<BTreeSet<String>>,
}

fn normalize(path: &Path) -> PathBuf {
    let mut out: Vec<Component> = Vec::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => match out.last() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::RootDir | Component::Prefix(_)) => {}
                _ => out.push(c),
            },
            c => out.push(c),
        }
    }
    out.iter().collect()
}

impl Snapshot {
    fn new(request: &Request) -> Snapshot {
        let files = request
            .files
            .iter()
            .map(|(path, text)| (normalize(Path::new(path)), text.as_bytes().to_vec()))
            .collect();
        let dirs = request
            .dirs
            .iter()
            .map(|(dir, entries)| {
                let dir = normalize(Path::new(dir));
                let entries = entries
                    .iter()
                    .map(|(name, is_dir)| (dir.join(name), *is_dir))
                    .collect();
                (dir, entries)
            })
            .collect();
        Snapshot {
            files,
            dirs,
            missing: RefCell::default(),
        }
    }
    fn miss(&self, path: &Path) -> io::Error {
        let shown = path.to_string_lossy().replace('\\', "/");
        self.missing.borrow_mut().insert(shown);
        io::Error::new(
            io::ErrorKind::NotFound,
            format!("{} is not in the in-memory source tree", path.display()),
        )
    }
    fn is_dir(&self, dir: &Path) -> bool {
        self.dirs.contains_key(dir) || self.files.keys().any(|p| p != dir && p.starts_with(dir))
    }
    fn missing(&self) -> Vec<String> {
        self.missing.borrow().iter().cloned().collect()
    }
}

impl SourceTree for Snapshot {
    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        let path = normalize(path);
        self.files
            .get(&path)
            .cloned()
            .ok_or_else(|| self.miss(&path))
    }
    fn read_dir(&self, dir: &Path) -> io::Result<Vec<(PathBuf, bool)>> {
        let dir = normalize(dir);
        if let Some(entries) = self.dirs.get(&dir) {
            return Ok(entries.clone());
        }
        let depth = dir.components().count();
        let mut entries = BTreeMap::new();
        for path in self
            .files
            .keys()
            .filter(|p| **p != dir && p.starts_with(&dir))
        {
            let mut components = path.components();
            let child: PathBuf = components.by_ref().take(depth + 1).collect();
            entries.insert(child, components.next().is_some());
        }
        if entries.is_empty() {
            return Err(self.miss(&dir));
        }
        Ok(entries.into_iter().collect())
    }
    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        let path = normalize(path);
        if self.files.contains_key(&path) || self.is_dir(&path) {
            Ok(path)
        } else {
            Err(self.miss(&path))
        }
    }
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
    let tree = Snapshot::new(&request);
    let root = Path::new(&request.root);
    let loaded = match pipeline::load_tree(&tree, root) {
        Ok(loaded) => loaded,
        Err(e) => return with_missing(failure(&e), &tree),
    };
    let lock = pipeline::lock_status(&tree, root, &loaded);
    let diagnostics = &loaded.compilation.diagnostics;
    let errors = diagnostics.iter().filter(|d| d.is_error()).count();
    let result = json!({
        "ok": errors == 0 && lock != LockStatus::Stale,
        "package": loaded.package.name,
        "files": loaded.package.files.len(),
        "dependencies": loaded.deps.len(),
        "errors": errors,
        "warnings": diagnostics.len() - errors,
        "lock": lock_name(lock),
        "diagnostics": diagnostics,
        "rendered": loaded.compilation.render(),
    });
    with_missing(result, &tree)
}

/// Adds the paths the compiler looked up and did not find.
fn with_missing(mut result: Value, tree: &Snapshot) -> Value {
    result["missing"] = json!(tree.missing());
    result
}

/// `forgec build <root>` (with `units`, `forgec build --units`): every artifact the CLI writes,
/// keyed by path relative to the output directory.
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
    let tree = Snapshot::new(&request);
    with_missing(build_in(&request, &tree), &tree)
}

fn build_in(request: &Request, tree: &Snapshot) -> Value {
    let root = Path::new(&request.root);
    let loaded = match pipeline::load_tree(tree, root) {
        Ok(loaded) => loaded,
        Err(e) => return failure(&e),
    };
    let lock = pipeline::lock_status(tree, root, &loaded);
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
    let (mut files, warnings) = if request.artifacts {
        let artifacts = pipeline::artifacts(
            &loaded,
            ir,
            &plans,
            request.service_id.clone(),
            request.source_revision.as_deref(),
        );
        (artifacts.files, artifacts.warnings)
    } else {
        (Vec::new(), Vec::new())
    };
    if request.units {
        let (path, plan) = pipeline::units_plan(&loaded, ir, &plans);
        let parsed: Value = serde_json::from_str(&plan).expect("the unit plan is JSON");
        files.push((path, plan));
        files.extend(pipeline::unit_wit_files(&parsed));
    }
    let files: serde_json::Map<String, Value> = files
        .into_iter()
        .map(|(path, text)| (path, Value::String(text)))
        .collect();
    json!({
        "ok": true,
        "package": loaded.package.name,
        "lock": lock_name(lock),
        "files": files,
        "warnings": warnings,
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
    fn plans_units_from_memory_exactly_as_from_disk() {
        let request = json!({"root": "examples/acme", "files": acme_files(), "units": true, "artifacts": false});
        let result = build(&request.to_string());
        assert_eq!(result["ok"], true, "{result}");
        let files = result["files"].as_object().unwrap();
        assert_eq!(
            files.keys().next().map(String::as_str),
            Some("units/plan.json")
        );
        assert!(files.keys().skip(1).all(|k| k.starts_with("units/wit/")));
        let loaded = pipeline::load_tree(&OsTree, &repo().join("examples/acme")).unwrap();
        let ir = loaded.compilation.ir.as_ref().unwrap();
        let plans = forgegraph_planner::plan(ir).unwrap();
        let (path, text) = pipeline::units_plan(&loaded, ir, &plans);
        assert_eq!(files[&path].as_str(), Some(text.as_str()));
        assert_eq!(
            result["missing"],
            json!([]),
            "a complete tree misses nothing"
        );
    }

    /// A host that only knows what it has been asked for converges on the files the CLI reads,
    /// fetching listings and files for the paths each call reports missing. Like the build
    /// service's Artifacts source, listing a directory also lists its subdirectories and fetches
    /// the `.forge` sources, `forge.toml` and `forge.lock` in them, so a package is not discovered
    /// one file per call.
    #[test]
    fn a_lazy_host_converges_on_the_missing_paths() {
        let all = acme_files();
        let listing = |dir: &str| -> Option<Vec<(String, bool)>> {
            let dir = repo().join(dir);
            // Untracked install and build output is not in a git tree.
            let mut out: Vec<(String, bool)> = std::fs::read_dir(&dir)
                .ok()?
                .map(|e| {
                    let e = e.unwrap();
                    (
                        e.file_name().to_string_lossy().into_owned(),
                        e.path().is_dir(),
                    )
                })
                .filter(|(name, _)| name != "node_modules" && name != "generated")
                .collect();
            out.sort();
            Some(out)
        };
        let mut files = BTreeMap::<String, String>::new();
        let mut dirs = BTreeMap::<String, Vec<(String, bool)>>::new();
        let mut absent = BTreeSet::<String>::new();
        let mut rounds = 0;
        let result = loop {
            rounds += 1;
            assert!(rounds < 50, "did not converge");
            let request =
                json!({"root": "examples/acme", "files": files, "dirs": dirs, "units": true});
            let result = build(&request.to_string());
            let mut progressed = false;
            for path in result["missing"].as_array().unwrap() {
                let path = path.as_str().unwrap().to_string();
                if absent.contains(&path) || files.contains_key(&path) || dirs.contains_key(&path) {
                    continue;
                }
                progressed = true;
                if let Some(text) = all.get(&path) {
                    files.insert(path, text.clone());
                } else if let Ok(text) = std::fs::read_to_string(repo().join(&path)) {
                    files.insert(path, text);
                } else if listing(&path).is_some() {
                    let mut stack = vec![path];
                    while let Some(dir) = stack.pop() {
                        let entries = listing(&dir).unwrap();
                        for (name, is_dir) in &entries {
                            let child = format!("{dir}/{name}");
                            if *is_dir {
                                stack.push(child);
                            } else if name.ends_with(".forge")
                                || name == "forge.toml"
                                || name == "forge.lock"
                            {
                                files.insert(
                                    child.clone(),
                                    std::fs::read_to_string(repo().join(&child)).unwrap(),
                                );
                            }
                        }
                        dirs.insert(dir, entries);
                    }
                } else {
                    absent.insert(path);
                }
            }
            if !progressed {
                break result;
            }
        };
        assert_eq!(result["ok"], true, "{result}");
        let eager =
            build(&json!({"root": "examples/acme", "files": all, "units": true}).to_string());
        assert_eq!(result["files"], eager["files"]);
        assert!(rounds <= 6, "{rounds} rounds");
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
