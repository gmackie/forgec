use std::path::PathBuf;
use std::process::Command;

fn forge() -> Command {
    Command::new(env!("CARGO_BIN_EXE_forge"))
}
fn examples() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples"))
}

#[test]
fn check_passes_for_the_reference_app_and_resolves_path_dependencies() {
    let out = forge().args(["check", examples().join("acme").to_str().unwrap()]).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("@acme/commerce: ok"), "{s}");
}

#[test]
fn check_fails_with_rendered_diagnostics_and_nonzero_exit() {
    let dir = std::env::temp_dir().join(format!("forge-cli-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("forge.toml"), "[package]\nname = \"@t/bad\"\nversion = \"0.1.0\"\n").unwrap();
    std::fs::write(dir.join("src/a.forge"), "resource R {\n  id : id\n  x : Nope\n}\n").unwrap();
    let out = forge().args(["check", dir.to_str().unwrap()]).output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    let s = String::from_utf8_lossy(&out.stderr);
    assert!(s.contains("error[E-SYM-001]: src/a.forge:3:7: unknown name `Nope`"), "{s}");
}

#[test]
fn inspect_emits_domain_ir_json_with_a_build_hash_that_is_stable() {
    let a = forge().args(["inspect", examples().join("acme").to_str().unwrap()]).output().unwrap();
    assert!(a.status.success(), "{}", String::from_utf8_lossy(&a.stderr));
    let b = forge().args(["inspect", examples().join("acme").to_str().unwrap()]).output().unwrap();
    assert_eq!(a.stdout, b.stdout);
    let v: serde_json::Value = serde_json::from_slice(&a.stdout).unwrap();
    assert_eq!(v["ir"]["version"], "domain-ir/1");
    assert_eq!(v["buildHash"].as_str().unwrap().len(), 64);
    assert_eq!(v["dependencies"][0]["package"], "@acme/payments");
}

#[test]
fn fmt_check_reports_unformatted_files_and_fmt_rewrites_them() {
    let dir = std::env::temp_dir().join(format!("forge-fmt-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("forge.toml"), "[package]\nname = \"@t/fmt\"\nversion = \"0.1.0\"\n").unwrap();
    std::fs::write(dir.join("src/a.forge"), "resource   R {\nid:id\n}\n").unwrap();
    let out = forge().args(["fmt", "--check", dir.to_str().unwrap()]).output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stdout).contains("src/a.forge"));
    let out = forge().args(["fmt", dir.to_str().unwrap()]).output().unwrap();
    assert!(out.status.success());
    assert_eq!(std::fs::read_to_string(dir.join("src/a.forge")).unwrap(), "resource R {\n  id : id\n}\n");
    let out = forge().args(["fmt", "--check", dir.to_str().unwrap()]).output().unwrap();
    assert!(out.status.success());
}

#[test]
fn lock_pins_dependencies_and_check_detects_a_stale_lock() {
    let dir = std::env::temp_dir().join(format!("forge-lock-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("app/src")).unwrap();
    std::fs::create_dir_all(dir.join("lib/src")).unwrap();
    std::fs::write(dir.join("lib/forge.toml"), "[package]\nname = \"@t/lib\"\nversion = \"1.0.0\"\n").unwrap();
    std::fs::write(dir.join("lib/src/a.forge"), "export shape S {\n  a : text\n}\n").unwrap();
    std::fs::write(dir.join("app/forge.toml"), "[package]\nname = \"@t/app\"\nversion = \"0.1.0\"\n\n[dependencies]\nlib = { path = \"../lib\" }\n").unwrap();
    std::fs::write(dir.join("app/src/a.forge"), "import lib\nfunction F {\n  input lib.S\n}\n").unwrap();
    let app = dir.join("app");

    let out = forge().args(["lock", app.to_str().unwrap()]).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let lock = std::fs::read_to_string(app.join("forge.lock")).unwrap();
    assert!(lock.contains("name = \"@t/lib\""), "{lock}");
    assert!(lock.contains("version = \"1.0.0\""), "{lock}");
    assert!(lock.contains("hash = \"sha256:"), "{lock}");

    assert!(forge().args(["check", app.to_str().unwrap()]).output().unwrap().status.success());

    // Change the dependency's contract: the lock is now stale.
    std::fs::write(dir.join("lib/src/a.forge"), "export shape S {\n  a : text\n  b : text\n}\n").unwrap();
    let out = forge().args(["check", app.to_str().unwrap()]).output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("E-LOCK-001"));

    assert!(forge().args(["lock", app.to_str().unwrap()]).output().unwrap().status.success());
    assert!(forge().args(["check", app.to_str().unwrap()]).output().unwrap().status.success());
}

#[test]
fn build_writes_the_generated_bundle_migration_and_client() {
    let out_dir = std::env::temp_dir().join(format!("forge-build-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out_dir);
    let out = forge().args(["build", examples().join("acme").to_str().unwrap(), "--out", out_dir.to_str().unwrap()]).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let bundle: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(out_dir.join("app.json")).unwrap()).unwrap();
    assert_eq!(bundle["version"], "app-bundle/1");
    assert_eq!(bundle["ir"]["version"], "domain-ir/1");
    assert_eq!(bundle["contracts"]["version"], "contracts/1");
    assert_eq!(bundle["sql"]["dialect"], "sqlite");
    assert_eq!(bundle["dynamo"]["version"], "dynamo-plan/1");
    assert_eq!(bundle["buildHash"].as_str().unwrap().len(), 64);
    let ddl = std::fs::read_to_string(out_dir.join("d1/0001_init.sql")).unwrap();
    assert!(ddl.contains("CREATE TABLE customer"));
    let client = std::fs::read_to_string(out_dir.join("client.ts")).unwrap();
    assert!(client.contains("export function createClient"));
    // building again is byte-identical
    let again = forge().args(["build", examples().join("acme").to_str().unwrap(), "--out", out_dir.to_str().unwrap()]).output().unwrap();
    assert!(again.status.success());
    let bundle2 = std::fs::read_to_string(out_dir.join("app.json")).unwrap();
    assert_eq!(serde_json::to_string(&bundle).unwrap(), serde_json::to_string(&serde_json::from_str::<serde_json::Value>(&bundle2).unwrap()).unwrap());
}

#[test]
fn compat_classifies_changes_per_compatibility_stream() {
    let dir = std::env::temp_dir().join(format!("forge-compat-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for v in ["old", "new"] {
        std::fs::create_dir_all(dir.join(v).join("src")).unwrap();
        std::fs::write(dir.join(v).join("forge.toml"), "[package]\nname = \"@t/app\"\nversion = \"0.1.0\"\n").unwrap();
    }
    let old = "enum Tier {\n  Standard\n  Gold\n}\n\nexport resource Customer\n  @tenant\n  @timestamps\n  @versioned\n  @crud(\"/v1/customers\")\n{\n  id : id\n  code : text length 1..8 @unique\n  tier : Tier = Tier.Standard\n  note : text? length 0..100\n}\n\nexport resource Order\n  @tenant\n  @timestamps\n  @versioned\n  @crud(\"/v1/orders\", actions: [ship])\n{\n  id : id\n  customer : Customer\n\n  lifecycle status {\n    initial Draft\n    terminal Shipped\n\n    ship: Draft -> Shipped\n  }\n}\n\nchannel Ev {\n  message A {\n    id : text\n  }\n}\n\nshape WIn {\n  order : Order\n}\n\nworkflow W {\n  input WIn\n  version 1\n\n  step a = sleep 1s\n\n  return a\n}\n";
    // new: enum member added (exhaustive-consumer risk), field made optional -> required (breaking for writers),
    // `note` removed (breaking for readers + storage column drop), `region` added optional (additive; storage adds a column),
    // lifecycle gains a state and transition (event/lifecycle stream), workflow graph changed with the same version (pin violation).
    let new = "enum Tier {\n  Standard\n  Gold\n  Enterprise\n}\n\nexport resource Customer\n  @tenant\n  @timestamps\n  @versioned\n  @crud(\"/v1/customers\")\n{\n  id : id\n  code : text length 1..8 @unique\n  tier : Tier\n  region : text? length 0..8\n}\n\nexport resource Order\n  @tenant\n  @timestamps\n  @versioned\n  @crud(\"/v1/orders\", actions: [ship, cancel])\n{\n  id : id\n  customer : Customer\n\n  lifecycle status {\n    initial Draft\n    terminal Shipped\n    terminal Cancelled\n\n    ship: Draft -> Shipped\n    cancel: Draft -> Cancelled\n  }\n}\n\nchannel Ev {\n  message A {\n    id : text\n  }\n\n  message B {\n    id : text\n  }\n}\n\nshape WIn {\n  order : Order\n}\n\nworkflow W {\n  input WIn\n  version 1\n\n  step a = sleep 2s\n\n  return a\n}\n";
    std::fs::write(dir.join("old/src/a.forge"), old).unwrap();
    std::fs::write(dir.join("new/src/a.forge"), new).unwrap();
    for v in ["old", "new"] {
        let out = forge().args(["build", dir.join(v).to_str().unwrap(), "--out", dir.join(v).join("generated").to_str().unwrap()]).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }
    let out = forge().args(["compat", dir.join("old/generated/app.json").to_str().unwrap(), dir.join("new/generated/app.json").to_str().unwrap()]).output().unwrap();
    assert_eq!(out.status.code(), Some(1), "breaking changes exit 1: {}", String::from_utf8_lossy(&out.stderr));
    let report: serde_json::Value = serde_json::from_str(&String::from_utf8_lossy(&out.stdout)).unwrap();
    assert_eq!(report["version"], "compat/1");
    assert_eq!(report["verdict"], "breaking");
    let findings: Vec<(String, String, String)> = report["findings"].as_array().unwrap().iter().map(|f| (f["stream"].as_str().unwrap().into(), f["severity"].as_str().unwrap().into(), f["code"].as_str().unwrap().into())).collect();
    let has = |stream: &str, sev: &str, code: &str| findings.iter().any(|(s, v, c)| s == stream && v == sev && c == code);
    assert!(has("api", "breaking", "field-removed"), "{findings:?}");
    assert!(has("api", "breaking", "field-required"), "{findings:?}");
    assert!(has("api", "additive", "field-added"), "{findings:?}");
    assert!(has("api", "risk", "enum-member-added"), "{findings:?}");
    assert!(has("api", "additive", "operation-added"), "{findings:?}");
    assert!(has("lifecycle", "additive", "state-added"), "{findings:?}");
    assert!(has("event", "risk", "message-added"), "{findings:?}");
    assert!(has("storage", "breaking", "column-removed"), "{findings:?}");
    assert!(has("storage", "migration", "column-added"), "{findings:?}");
    assert!(has("workflow", "breaking", "graph-changed-without-version"), "{findings:?}");
    // Same bundle twice: compatible, exit 0.
    let same = forge().args(["compat", dir.join("new/generated/app.json").to_str().unwrap(), dir.join("new/generated/app.json").to_str().unwrap()]).output().unwrap();
    assert!(same.status.success());
    let r: serde_json::Value = serde_json::from_str(&String::from_utf8_lossy(&same.stdout)).unwrap();
    assert_eq!(r["verdict"], "compatible");
}

/// Minimal LSP client over stdio: initialize, open a file with an error, expect diagnostics, format, shutdown.
#[test]
fn lsp_publishes_diagnostics_and_formats() {
    use std::io::{BufRead, BufReader, Read, Write};
    let dir = std::env::temp_dir().join(format!("forge-lsp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("forge.toml"), "[package]\nname = \"@t/app\"\nversion = \"0.1.0\"\n").unwrap();
    let path = dir.join("src/a.forge");
    std::fs::write(&path, "resource R {\n  id : id\n  x : txt\n}\n").unwrap();
    let uri = format!("file://{}", path.display());

    let mut child = forge().arg("lsp").stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let send = |stdin: &mut std::process::ChildStdin, v: serde_json::Value| {
        let body = v.to_string();
        write!(stdin, "Content-Length: {}\r\n\r\n{}", body.len(), body).unwrap();
        stdin.flush().unwrap();
    };
    let recv = |stdout: &mut BufReader<std::process::ChildStdout>| -> serde_json::Value {
        let mut len = 0usize;
        loop {
            let mut line = String::new();
            stdout.read_line(&mut line).unwrap();
            if line == "\r\n" || line.is_empty() { break; }
            if let Some(v) = line.strip_prefix("Content-Length:") { len = v.trim().parse().unwrap(); }
        }
        let mut buf = vec![0u8; len];
        stdout.read_exact(&mut buf).unwrap();
        serde_json::from_slice(&buf).unwrap()
    };
    send(&mut stdin, serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "rootUri": format!("file://{}", dir.display()), "capabilities": {} } }));
    let init = recv(&mut stdout);
    assert_eq!(init["id"], 1);
    assert_eq!(init["result"]["capabilities"]["textDocumentSync"], 1);
    assert_eq!(init["result"]["capabilities"]["documentFormattingProvider"], true);
    send(&mut stdin, serde_json::json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }));
    send(&mut stdin, serde_json::json!({ "jsonrpc": "2.0", "method": "textDocument/didOpen", "params": { "textDocument": { "uri": uri, "languageId": "forge", "version": 1, "text": std::fs::read_to_string(&path).unwrap() } } }));
    let diag = recv(&mut stdout);
    assert_eq!(diag["method"], "textDocument/publishDiagnostics");
    assert_eq!(diag["params"]["uri"], uri);
    let d = &diag["params"]["diagnostics"][0];
    assert_eq!(d["code"], "E-SYM-001");
    assert_eq!(d["range"]["start"]["line"], 2);
    assert!(d["message"].as_str().unwrap().contains("text"), "suggestion carried: {}", d["message"]);
    // fix through didChange: diagnostics clear
    send(&mut stdin, serde_json::json!({ "jsonrpc": "2.0", "method": "textDocument/didChange", "params": { "textDocument": { "uri": uri, "version": 2 }, "contentChanges": [{ "text": "resource R   {\n  id : id\n  x : text\n}\n" }] } }));
    let diag2 = recv(&mut stdout);
    assert_eq!(diag2["params"]["diagnostics"].as_array().unwrap().len(), 0);
    send(&mut stdin, serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "textDocument/formatting", "params": { "textDocument": { "uri": uri }, "options": { "tabSize": 2, "insertSpaces": true } } }));
    let fmt = recv(&mut stdout);
    assert_eq!(fmt["id"], 2);
    assert_eq!(fmt["result"][0]["newText"], "resource R {\n  id : id\n  x : text\n}\n");
    send(&mut stdin, serde_json::json!({ "jsonrpc": "2.0", "id": 3, "method": "shutdown", "params": null }));
    assert_eq!(recv(&mut stdout)["id"], 3);
    send(&mut stdin, serde_json::json!({ "jsonrpc": "2.0", "method": "exit", "params": null }));
    assert!(child.wait().unwrap().success());
}

/// FORGE-030: pinned extension manifests are validated by digest and shape; nothing in them runs.
#[test]
fn check_validates_pinned_extension_manifests_without_executing_them() {
    let dir = std::env::temp_dir().join(format!("forge-ext-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("app/src")).unwrap();
    std::fs::create_dir_all(dir.join("ext")).unwrap();
    std::fs::write(dir.join("app/src/a.forge"), "resource R {\n  id : id\n}\n").unwrap();
    let manifest = r#"{"version":"capability-manifest/1","id":"@x/adapter","kind":"adapter","adapterVersion":"1.0.0","engine":{"name":"sqlite","version":"3"},"runtime":{"name":"node","version":"22"},"capabilities":[{"id":"query.strong-read","support":"native","evidence":[{"kind":"test","ref":"t"}]}]}"#;
    std::fs::write(dir.join("ext/manifest.json"), manifest).unwrap();
    let digest = {
        use sha2::Digest;
        hex::encode(sha2::Sha256::digest(manifest.as_bytes()))
    };
    let toml = |d: &str| format!("[package]\nname = \"@t/app\"\nversion = \"0.1.0\"\n\n[extensions.adapter]\nmanifest = \"../ext/manifest.json\"\nsha256 = \"{d}\"\n");
    std::fs::write(dir.join("app/forge.toml"), toml(&digest)).unwrap();
    let ok = forge().args(["check", dir.join("app").to_str().unwrap()]).output().unwrap();
    assert!(ok.status.success(), "{}", String::from_utf8_lossy(&ok.stderr));

    // Tampered manifest: digest mismatch is E-EXT-001.
    std::fs::write(dir.join("ext/manifest.json"), manifest.replace("\"native\"", "\"bounded-emulation\"")).unwrap();
    let bad = forge().args(["check", dir.join("app").to_str().unwrap()]).output().unwrap();
    assert_eq!(bad.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&bad.stderr).contains("E-EXT-001"));

    // Code-bearing manifest with a correct digest: E-EXT-002 (declares, never runs).
    let code = manifest.replace("\"kind\":\"adapter\"", "\"kind\":\"adapter\",\"main\":\"./index.js\"");
    std::fs::write(dir.join("ext/manifest.json"), &code).unwrap();
    let d2 = { use sha2::Digest; hex::encode(sha2::Sha256::digest(code.as_bytes())) };
    std::fs::write(dir.join("app/forge.toml"), toml(&d2)).unwrap();
    let code_out = forge().args(["check", dir.join("app").to_str().unwrap()]).output().unwrap();
    assert_eq!(code_out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&code_out.stderr).contains("E-EXT-002"));
}
