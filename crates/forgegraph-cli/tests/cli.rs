use std::path::PathBuf;
use std::process::Command;

fn forgec() -> Command {
    Command::new(env!("CARGO_BIN_EXE_forgec"))
}
fn examples() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples"))
}

#[test]
fn check_passes_for_the_reference_app_and_resolves_path_dependencies() {
    let out = forgec()
        .args(["check", examples().join("acme").to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("@acme/commerce: ok"), "{s}");
}

#[test]
fn check_fails_with_rendered_diagnostics_and_nonzero_exit() {
    let dir = std::env::temp_dir().join(format!("forgegraph-cli-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(
        dir.join("forge.toml"),
        "[package]\nname = \"@t/bad\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("src/a.forge"),
        "resource R {\n  id : id\n  x : Nope\n}\n",
    )
    .unwrap();
    let out = forgec()
        .args(["check", dir.to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let s = String::from_utf8_lossy(&out.stderr);
    assert!(
        s.contains("error[E-SYM-001]: src/a.forge:3:7: unknown name `Nope`"),
        "{s}"
    );
}

#[test]
fn inspect_emits_domain_ir_json_with_a_build_hash_that_is_stable() {
    let a = forgec()
        .args(["inspect", examples().join("acme").to_str().unwrap()])
        .output()
        .unwrap();
    assert!(a.status.success(), "{}", String::from_utf8_lossy(&a.stderr));
    let b = forgec()
        .args(["inspect", examples().join("acme").to_str().unwrap()])
        .output()
        .unwrap();
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
    std::fs::write(
        dir.join("forge.toml"),
        "[package]\nname = \"@t/fmt\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();
    std::fs::write(dir.join("src/a.forge"), "resource   R {\nid:id\n}\n").unwrap();
    let out = forgec()
        .args(["fmt", "--check", dir.to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stdout).contains("src/a.forge"));
    let out = forgec()
        .args(["fmt", dir.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(
        std::fs::read_to_string(dir.join("src/a.forge")).unwrap(),
        "resource R {\n  id : id\n}\n"
    );
    let out = forgec()
        .args(["fmt", "--check", dir.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(out.status.success());
}

#[test]
fn lock_pins_dependencies_and_check_detects_a_stale_lock() {
    let dir = std::env::temp_dir().join(format!("forge-lock-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("app/src")).unwrap();
    std::fs::create_dir_all(dir.join("lib/src")).unwrap();
    std::fs::write(
        dir.join("lib/forge.toml"),
        "[package]\nname = \"@t/lib\"\nversion = \"1.0.0\"\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("lib/src/a.forge"),
        "export shape S {\n  a : text\n}\n",
    )
    .unwrap();
    std::fs::write(dir.join("app/forge.toml"), "[package]\nname = \"@t/app\"\nversion = \"0.1.0\"\n\n[dependencies]\nlib = { path = \"../lib\" }\n").unwrap();
    std::fs::write(
        dir.join("app/src/a.forge"),
        "import lib\nfunction F {\n  input lib.S\n}\n",
    )
    .unwrap();
    let app = dir.join("app");

    let out = forgec()
        .args(["lock", app.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let lock = std::fs::read_to_string(app.join("forge.lock")).unwrap();
    assert!(lock.contains("name = \"@t/lib\""), "{lock}");
    assert!(lock.contains("version = \"1.0.0\""), "{lock}");
    assert!(lock.contains("hash = \"sha256:"), "{lock}");

    assert!(
        forgec()
            .args(["check", app.to_str().unwrap()])
            .output()
            .unwrap()
            .status
            .success()
    );

    // Change the dependency's contract: the lock is now stale.
    std::fs::write(
        dir.join("lib/src/a.forge"),
        "export shape S {\n  a : text\n  b : text\n}\n",
    )
    .unwrap();
    let out = forgec()
        .args(["check", app.to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("E-LOCK-001"));

    assert!(
        forgec()
            .args(["lock", app.to_str().unwrap()])
            .output()
            .unwrap()
            .status
            .success()
    );
    assert!(
        forgec()
            .args(["check", app.to_str().unwrap()])
            .output()
            .unwrap()
            .status
            .success()
    );
}

#[test]
fn build_writes_the_generated_bundle_migration_and_client() {
    let out_dir = std::env::temp_dir().join(format!("forge-build-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out_dir);
    let out = forgec()
        .args([
            "build",
            examples().join("acme").to_str().unwrap(),
            "--out",
            out_dir.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let bundle: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(out_dir.join("app.json")).unwrap()).unwrap();
    let source_map: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(out_dir.join("source-map.json")).unwrap())
            .unwrap();
    assert_eq!(source_map["version"], "forge-source-map/1");
    assert_eq!(source_map["buildHash"], bundle["buildHash"]);
    assert!(source_map["anchors"]["@acme/commerce/_/ProcessOrder#step:submit"].is_object());
    assert!(bundle.get("sourceMap").is_none());
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
    let again = forgec()
        .args([
            "build",
            examples().join("acme").to_str().unwrap(),
            "--out",
            out_dir.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(again.status.success());
    let bundle2 = std::fs::read_to_string(out_dir.join("app.json")).unwrap();
    assert_eq!(
        serde_json::to_string(&bundle).unwrap(),
        serde_json::to_string(&serde_json::from_str::<serde_json::Value>(&bundle2).unwrap())
            .unwrap()
    );
}

#[test]
fn compat_classifies_changes_per_compatibility_stream() {
    let dir = std::env::temp_dir().join(format!("forge-compat-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for v in ["old", "new"] {
        std::fs::create_dir_all(dir.join(v).join("src")).unwrap();
        std::fs::write(
            dir.join(v).join("forge.toml"),
            "[package]\nname = \"@t/app\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
    }
    let old = "enum Tier {\n  Standard\n  Gold\n}\n\nexport resource Customer\n  @tenant\n  @timestamps\n  @versioned\n  @crud(\"/v1/customers\")\n{\n  id : id\n  code : text length 1..8 @unique\n  tier : Tier = Tier.Standard\n  note : text? length 0..100\n}\n\nexport resource Order\n  @tenant\n  @timestamps\n  @versioned\n  @crud(\"/v1/orders\", actions: [ship])\n{\n  id : id\n  customer : Customer\n\n  lifecycle status {\n    initial Draft\n    terminal Shipped\n\n    ship: Draft -> Shipped\n  }\n}\n\nchannel Ev {\n  message A {\n    id : text\n  }\n}\n\nshape WIn {\n  order : Order\n}\n\nworkflow W {\n  input WIn\n  version 1\n\n  step a = sleep 1s\n\n  return a\n}\n";
    // new: enum member added (exhaustive-consumer risk), field made optional -> required (breaking for writers),
    // `note` removed (breaking for readers + storage column drop), `region` added optional (additive; storage adds a column),
    // lifecycle gains a state and transition (event/lifecycle stream), workflow graph changed with the same version (pin violation).
    let new = "enum Tier {\n  Standard\n  Gold\n  Enterprise\n}\n\nexport resource Customer\n  @tenant\n  @timestamps\n  @versioned\n  @crud(\"/v1/customers\")\n{\n  id : id\n  code : text length 1..8 @unique\n  tier : Tier\n  region : text? length 0..8\n}\n\nexport resource Order\n  @tenant\n  @timestamps\n  @versioned\n  @crud(\"/v1/orders\", actions: [ship, cancel])\n{\n  id : id\n  customer : Customer\n\n  lifecycle status {\n    initial Draft\n    terminal Shipped\n    terminal Cancelled\n\n    ship: Draft -> Shipped\n    cancel: Draft -> Cancelled\n  }\n}\n\nchannel Ev {\n  message A {\n    id : text\n  }\n\n  message B {\n    id : text\n  }\n}\n\nshape WIn {\n  order : Order\n}\n\nworkflow W {\n  input WIn\n  version 1\n\n  step a = sleep 2s\n\n  return a\n}\n";
    std::fs::write(dir.join("old/src/a.forge"), old).unwrap();
    std::fs::write(dir.join("new/src/a.forge"), new).unwrap();
    for v in ["old", "new"] {
        let out = forgec()
            .args([
                "build",
                dir.join(v).to_str().unwrap(),
                "--out",
                dir.join(v).join("generated").to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let out = forgec()
        .args([
            "compat",
            dir.join("old/generated/app.json").to_str().unwrap(),
            dir.join("new/generated/app.json").to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(
        out.status.code(),
        Some(1),
        "breaking changes exit 1: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&out.stdout)).unwrap();
    assert_eq!(report["version"], "compat/1");
    assert_eq!(report["verdict"], "breaking");
    let findings: Vec<(String, String, String)> = report["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                f["stream"].as_str().unwrap().into(),
                f["severity"].as_str().unwrap().into(),
                f["code"].as_str().unwrap().into(),
            )
        })
        .collect();
    let has = |stream: &str, sev: &str, code: &str| {
        findings
            .iter()
            .any(|(s, v, c)| s == stream && v == sev && c == code)
    };
    assert!(has("api", "breaking", "field-removed"), "{findings:?}");
    assert!(has("api", "breaking", "field-required"), "{findings:?}");
    assert!(has("api", "additive", "field-added"), "{findings:?}");
    assert!(has("api", "risk", "enum-member-added"), "{findings:?}");
    assert!(has("api", "additive", "operation-added"), "{findings:?}");
    assert!(has("lifecycle", "additive", "state-added"), "{findings:?}");
    assert!(has("event", "risk", "message-added"), "{findings:?}");
    assert!(has("storage", "breaking", "column-removed"), "{findings:?}");
    assert!(has("storage", "migration", "column-added"), "{findings:?}");
    assert!(
        has("workflow", "breaking", "graph-changed-without-version"),
        "{findings:?}"
    );
    // Same bundle twice: compatible, exit 0.
    let same = forgec()
        .args([
            "compat",
            dir.join("new/generated/app.json").to_str().unwrap(),
            dir.join("new/generated/app.json").to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(same.status.success());
    let r: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&same.stdout)).unwrap();
    assert_eq!(r["verdict"], "compatible");

    // FORGE-067 / PAR-140: needs are named, live facts are never invented.
    let field_required = report["findings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["code"] == "field-required")
        .unwrap();
    assert_eq!(
        field_required["needs"],
        serde_json::json!(["backfill-review"])
    );
    assert!(
        report["facts"]["liveData"]
            .as_str()
            .unwrap()
            .starts_with("none")
    );
    let text = serde_json::to_string(&report).unwrap().to_lowercase();
    assert!(
        !text.contains("affectedrows") && !text.contains("rowcount") && !text.contains("\"rows\""),
        "no invented row counts"
    );
    // PAR-141: direction distinguishes exhaustive output consumers from old producers; additions are not all "compatible"
    let enum_added = report["findings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["code"] == "enum-member-added")
        .unwrap();
    assert_eq!(enum_added["direction"], "consumer");
    assert_eq!(enum_added["severity"], "risk");
    assert_eq!(field_required["direction"], "producer");
    assert_eq!(report["streams"]["api"], "breaking");
    assert_eq!(report["streams"]["storage"], "breaking");
    // whitespace and file moves: same IR, no findings
    std::fs::create_dir_all(dir.join("moved/src/deep")).unwrap();
    std::fs::write(
        dir.join("moved/forge.toml"),
        "[package]\nname = \"@t/app\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("moved/src/deep/renamed.forge"),
        format!(
            "// moved and reformatted\n\n{}\n\n\n",
            new.replace("\n\n", "\n\n\n")
        ),
    )
    .unwrap();
    let out = forgec()
        .args([
            "build",
            dir.join("moved").to_str().unwrap(),
            "--out",
            dir.join("moved/generated").to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let moved = forgec()
        .args([
            "compat",
            dir.join("new/generated/app.json").to_str().unwrap(),
            dir.join("moved/generated/app.json").to_str().unwrap(),
        ])
        .output()
        .unwrap();
    let r: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&moved.stdout)).unwrap();
    assert_eq!(r["verdict"], "compatible", "{r}");
    assert_eq!(r["findings"].as_array().unwrap().len(), 0);
    // PAR-142: an opaque policy bundle change is `unknown` unless a supported proof establishes the relation
    let mut o: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("new/generated/app.json")).unwrap())
            .unwrap();
    let mut n = o.clone();
    o["policy"] = serde_json::json!({ "kind": "rego-bundle", "digest": "sha256:aaaa" });
    n["policy"] = serde_json::json!({ "kind": "rego-bundle", "digest": "sha256:bbbb" });
    std::fs::write(dir.join("pol-old.json"), o.to_string()).unwrap();
    std::fs::write(dir.join("pol-new.json"), n.to_string()).unwrap();
    let out = forgec()
        .args([
            "compat",
            dir.join("pol-old.json").to_str().unwrap(),
            dir.join("pol-new.json").to_str().unwrap(),
        ])
        .output()
        .unwrap();
    let r: serde_json::Value = serde_json::from_str(&String::from_utf8_lossy(&out.stdout)).unwrap();
    assert_eq!(r["verdict"], "unknown");
    assert_eq!(r["findings"][0]["code"], "policy-changed-unknown");
    assert_eq!(r["facts"]["policyProof"], "none attached");
    n["policy"]["proof"] = serde_json::json!({ "basis": "forge-policy-diff", "for": "sha256:aaaa", "relation": "narrowing" });
    std::fs::write(dir.join("pol-new.json"), n.to_string()).unwrap();
    let out = forgec()
        .args([
            "compat",
            dir.join("pol-old.json").to_str().unwrap(),
            dir.join("pol-new.json").to_str().unwrap(),
        ])
        .output()
        .unwrap();
    let r: serde_json::Value = serde_json::from_str(&String::from_utf8_lossy(&out.stdout)).unwrap();
    assert_eq!(r["findings"][0]["code"], "policy-narrowed");
    assert_eq!(
        r["findings"][0]["needs"],
        serde_json::json!(["decision-epoch-bump"])
    );
    // FORGE-068: the migration plan is phased, names review needs, blocks unsafe exposure, and sizes nothing
    let mig = forgec()
        .args([
            "migrate",
            dir.join("old/generated/app.json").to_str().unwrap(),
            dir.join("new/generated/app.json").to_str().unwrap(),
        ])
        .output()
        .unwrap();
    let plan: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&mig.stdout)).unwrap();
    assert_eq!(plan["version"], "migration-plan/1");
    assert_eq!(
        mig.status.code(),
        Some(2),
        "a graph change without a version bump blocks the plan"
    );
    let kinds: Vec<(String, String, bool, bool)> = plan["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|st| {
            (
                st["phase"].as_str().unwrap().into(),
                st["kind"].as_str().unwrap().into(),
                st["requiresReview"].as_bool().unwrap(),
                st["blocked"].as_bool().unwrap(),
            )
        })
        .collect();
    assert!(
        kinds
            .iter()
            .any(|(p, k, _, _)| p == "expand" && k == "storage.expand"),
        "{kinds:?}"
    );
    assert!(
        kinds
            .iter()
            .any(|(p, k, r, _)| p == "backfill" && k == "data.backfill" && *r),
        "{kinds:?}"
    );
    assert!(
        kinds
            .iter()
            .any(|(p, k, r, _)| p == "contract" && k == "storage.contract" && *r),
        "{kinds:?}"
    );
    assert!(
        kinds
            .iter()
            .any(|(p, k, _, b)| p == "preflight" && k == "workflow.version" && *b),
        "{kinds:?}"
    );
    let expand = plan["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|st| st["kind"] == "storage.expand" && st["subject"] == "customer.region")
        .unwrap();
    assert!(
        expand["ddl"]["sqlite"]
            .as_str()
            .unwrap()
            .starts_with("ALTER TABLE customer ADD COLUMN region TEXT"),
        "{expand}"
    );
    assert!(
        expand["ddl"]["postgres"]
            .as_str()
            .unwrap()
            .contains("ADD COLUMN region TEXT"),
        "{expand}"
    );
    // phases are ordered and chained
    let phases: Vec<&str> = plan["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|st| st["phase"].as_str().unwrap())
        .collect();
    let order = [
        "preflight",
        "expand",
        "compat-release",
        "backfill",
        "verify",
        "traffic",
        "drain",
        "contract",
    ];
    let mut last = 0;
    for p in &phases {
        let i = order.iter().position(|x| x == p).unwrap();
        assert!(i >= last);
        last = i;
    }
    assert!(
        plan["unknown"]
            .as_array()
            .unwrap()
            .iter()
            .any(|u| u.as_str().unwrap().contains("row counts"))
    );
    assert!(
        !serde_json::to_string(&plan)
            .unwrap()
            .to_lowercase()
            .contains("rowcount")
    );
    // audience reports
    let pr = forgec()
        .args([
            "compat",
            dir.join("old/generated/app.json").to_str().unwrap(),
            dir.join("new/generated/app.json").to_str().unwrap(),
            "--report",
            "pr",
        ])
        .output()
        .unwrap();
    let md = String::from_utf8_lossy(&pr.stdout);
    assert!(
        md.contains("needs: backfill-review") && md.contains("### storage"),
        "{md}"
    );
    let sec = forgec()
        .args([
            "compat",
            dir.join("old/generated/app.json").to_str().unwrap(),
            dir.join("new/generated/app.json").to_str().unwrap(),
            "--report",
            "security",
        ])
        .output()
        .unwrap();
    let md = String::from_utf8_lossy(&sec.stdout);
    assert!(
        !md.contains("### api") && md.contains("## Security review"),
        "{md}"
    );
    let cl = forgec()
        .args([
            "compat",
            dir.join("old/generated/app.json").to_str().unwrap(),
            dir.join("new/generated/app.json").to_str().unwrap(),
            "--report",
            "changelog",
        ])
        .output()
        .unwrap();
    let md = String::from_utf8_lossy(&cl.stdout);
    assert!(
        md.contains("### api") && !md.contains("needs:") && !md.contains("### storage"),
        "{md}"
    );
}

/// Minimal LSP client over stdio: initialize, open a file with an error, expect diagnostics, format, shutdown.
#[test]
fn lsp_publishes_diagnostics_and_formats() {
    use std::io::{BufRead, BufReader, Read, Write};
    let dir = std::env::temp_dir().join(format!("forge-lsp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(
        dir.join("forge.toml"),
        "[package]\nname = \"@t/app\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();
    let path = dir.join("src/a.forge");
    std::fs::write(&path, "resource R {\n  id : id\n  x : txt\n}\n").unwrap();
    let uri = format!("file://{}", path.display());

    let mut child = forgec()
        .arg("lsp")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
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
            if line == "\r\n" || line.is_empty() {
                break;
            }
            if let Some(v) = line.strip_prefix("Content-Length:") {
                len = v.trim().parse().unwrap();
            }
        }
        let mut buf = vec![0u8; len];
        stdout.read_exact(&mut buf).unwrap();
        serde_json::from_slice(&buf).unwrap()
    };
    send(
        &mut stdin,
        serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "rootUri": format!("file://{}", dir.display()), "capabilities": {} } }),
    );
    let init = recv(&mut stdout);
    assert_eq!(init["id"], 1);
    assert_eq!(init["result"]["capabilities"]["textDocumentSync"], 2);
    assert_eq!(
        init["result"]["capabilities"]["documentFormattingProvider"],
        true
    );
    send(
        &mut stdin,
        serde_json::json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }),
    );
    send(
        &mut stdin,
        serde_json::json!({ "jsonrpc": "2.0", "method": "textDocument/didOpen", "params": { "textDocument": { "uri": uri, "languageId": "forge", "version": 1, "text": std::fs::read_to_string(&path).unwrap() } } }),
    );
    let diag = recv(&mut stdout);
    assert_eq!(diag["method"], "textDocument/publishDiagnostics");
    assert_eq!(diag["params"]["uri"], uri);
    let d = &diag["params"]["diagnostics"][0];
    assert_eq!(d["code"], "E-SYM-001");
    assert_eq!(d["range"]["start"]["line"], 2);
    assert!(
        d["message"].as_str().unwrap().contains("text"),
        "suggestion carried: {}",
        d["message"]
    );
    // fix through didChange: diagnostics clear
    send(
        &mut stdin,
        serde_json::json!({ "jsonrpc": "2.0", "method": "textDocument/didChange", "params": { "textDocument": { "uri": uri, "version": 2 }, "contentChanges": [{ "text": "resource R   {\n  id : id\n  x : text\n}\n" }] } }),
    );
    let diag2 = recv(&mut stdout);
    assert_eq!(diag2["params"]["diagnostics"].as_array().unwrap().len(), 0);
    send(
        &mut stdin,
        serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "textDocument/formatting", "params": { "textDocument": { "uri": uri }, "options": { "tabSize": 2, "insertSpaces": true } } }),
    );
    let fmt = recv(&mut stdout);
    assert_eq!(fmt["id"], 2);
    assert_eq!(
        fmt["result"][0]["newText"],
        "resource R {\n  id : id\n  x : text\n}\n"
    );
    send(
        &mut stdin,
        serde_json::json!({ "jsonrpc": "2.0", "id": 3, "method": "shutdown", "params": null }),
    );
    assert_eq!(recv(&mut stdout)["id"], 3);
    send(
        &mut stdin,
        serde_json::json!({ "jsonrpc": "2.0", "method": "exit", "params": null }),
    );
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
    let toml = |d: &str| {
        format!(
            "[package]\nname = \"@t/app\"\nversion = \"0.1.0\"\n\n[extensions.adapter]\nmanifest = \"../ext/manifest.json\"\nsha256 = \"{d}\"\n"
        )
    };
    std::fs::write(dir.join("app/forge.toml"), toml(&digest)).unwrap();
    let ok = forgec()
        .args(["check", dir.join("app").to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        ok.status.success(),
        "{}",
        String::from_utf8_lossy(&ok.stderr)
    );

    // Tampered manifest: digest mismatch is E-EXT-001.
    std::fs::write(
        dir.join("ext/manifest.json"),
        manifest.replace("\"native\"", "\"bounded-emulation\""),
    )
    .unwrap();
    let bad = forgec()
        .args(["check", dir.join("app").to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(bad.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&bad.stderr).contains("E-EXT-001"));

    // Code-bearing manifest with a correct digest: E-EXT-002 (declares, never runs).
    let code = manifest.replace(
        "\"kind\":\"adapter\"",
        "\"kind\":\"adapter\",\"main\":\"./index.js\"",
    );
    std::fs::write(dir.join("ext/manifest.json"), &code).unwrap();
    let d2 = {
        use sha2::Digest;
        hex::encode(sha2::Sha256::digest(code.as_bytes()))
    };
    std::fs::write(dir.join("app/forge.toml"), toml(&d2)).unwrap();
    let code_out = forgec()
        .args(["check", dir.join("app").to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(code_out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&code_out.stderr).contains("E-EXT-002"));
}

/// PAR-178: upgrading an M8 (edition 2026) application to edition 2027 is explicit: proposals are printed, nothing is
/// written, no grants appear, the schema does not change, and the old edition stays on record until the author moves it.
#[test]
fn edition_upgrade_is_explicit_and_non_destructive() {
    let dir = std::env::temp_dir().join(format!("forge-upgrade-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("old/src")).unwrap();
    std::fs::write(
        dir.join("old/forge.toml"),
        "[package]\nname = \"@t/app\"\nversion = \"0.1.0\"\nedition = \"2026\"\n",
    )
    .unwrap();
    let old = "export resource Customer\n  @tenant\n  @timestamps\n  @versioned\n  @crud(\"/v1/customers\")\n{\n  id : id\n  code : text length 1..8 @unique\n  email : email\n  note : text? length 0..100\n}\n";
    std::fs::write(dir.join("old/src/a.forge"), old).unwrap();
    let before = std::fs::read_to_string(dir.join("old/src/a.forge")).unwrap();
    let out = forgec()
        .args(["upgrade-edition", dir.join("old").to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&out.stdout)).unwrap();
    assert_eq!(report["currentEdition"], "2026");
    assert_eq!(report["appliesAutomatically"], false);
    let p = &report["proposals"][0];
    assert_eq!(p["resource"], "@t/app/_/Customer");
    assert_eq!(p["kind"], "recommended");
    assert_eq!(
        p["proposal"]["capability"]["read"],
        serde_json::json!(["id"])
    ); // minimal: identity only
    assert!(p["grants"].as_str().unwrap().starts_with("none"));
    assert!(p["storage"].as_str().unwrap().starts_with("none"));
    // nothing was written
    assert_eq!(
        std::fs::read_to_string(dir.join("old/src/a.forge")).unwrap(),
        before
    );
    assert!(
        std::fs::read_to_string(dir.join("old/forge.toml"))
            .unwrap()
            .contains("edition = \"2026\"")
    );
    // applying the proposal by hand (edition 2027, @purposeScoped, minimal capability, one purpose binding): the
    // compatibility report shows new governance authority to review and no storage change at all
    std::fs::create_dir_all(dir.join("new/src")).unwrap();
    std::fs::write(
        dir.join("new/forge.toml"),
        "[package]\nname = \"@t/app\"\nversion = \"0.1.0\"\nedition = \"2027\"\n",
    )
    .unwrap();
    let new = "purpose Support\nexport resource Customer\n  @tenant\n  @timestamps\n  @versioned\n  @purposeScoped\n  @crud(\"/v1/customers\")\n{\n  id : id\n  code : text length 1..8 @unique\n  email : email\n  note : text? length 0..100\n\n  capability Minimal {\n    read { id }\n  }\n\n  for Support { use Minimal }\n}\n";
    std::fs::write(dir.join("new/src/a.forge"), new).unwrap();
    for v in ["old", "new"] {
        let b = forgec()
            .args([
                "build",
                dir.join(v).to_str().unwrap(),
                "--out",
                dir.join(v).join("generated").to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(b.status.success(), "{}", String::from_utf8_lossy(&b.stderr));
    }
    let compat = forgec()
        .args([
            "compat",
            dir.join("old/generated/app.json").to_str().unwrap(),
            dir.join("new/generated/app.json").to_str().unwrap(),
        ])
        .output()
        .unwrap();
    let r: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&compat.stdout)).unwrap();
    let findings = r["findings"].as_array().unwrap();
    assert!(
        findings.iter().all(|f| f["stream"] != "storage"),
        "no schema change: {findings:?}"
    );
    assert!(
        findings.iter().any(|f| f["stream"] == "governance"
            && f["code"] == "surface-added"
            && f["needs"] == serde_json::json!(["grant-reapproval"])),
        "{findings:?}"
    );
    assert!(
        findings.iter().all(|f| f["stream"] != "dependencies"),
        "no grants or dependency edges are implied: {findings:?}"
    );
    // the upgraded package reports itself as 2027; the old one keeps saying 2026
    let oldb: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("old/generated/app.json")).unwrap())
            .unwrap();
    let newb: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("new/generated/app.json")).unwrap())
            .unwrap();
    assert_eq!(oldb["ir"]["package"]["edition"], "2026");
    assert_eq!(newb["ir"]["package"]["edition"], "2027");
    let done = forgec()
        .args(["upgrade-edition", dir.join("new").to_str().unwrap()])
        .output()
        .unwrap();
    let r2: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&done.stdout)).unwrap();
    assert_eq!(r2["status"], "already on edition 2027");
    assert_eq!(r2["proposals"].as_array().unwrap().len(), 0);
}

#[test]
fn inspect_concept_exports_a_partial_business_graph() {
    let out = forgec()
        .args([
            "inspect",
            examples().join("acme").to_str().unwrap(),
            "--concept",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["projection"]["concept"]["version"], "concept-ir/2");
    assert_eq!(value["conceptHash"].as_str().unwrap().len(), 64);
    assert!(value["projection"]["coverage"].is_object());
    assert_eq!(
        value["graph"]["nodes"]["@acme/commerce/_/Customer"],
        "entity"
    );
    assert!(value["projection"]["concept"].get("targets").is_none());
}

#[test]
fn check_concept_contract_fails_closed_and_reports_paths() {
    let dir = std::env::temp_dir().join(format!("forge-concept-contract-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(
        dir.join("forge.toml"),
        "[package]\nname = \"@test/contract\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("src/app.forge"),
        "resource Customer { id : id }\nfunction Work { output Customer.Record }",
    )
    .unwrap();
    let inspected = forgec()
        .arg("inspect")
        .arg(&dir)
        .arg("--concept")
        .output()
        .unwrap();
    assert!(
        inspected.status.success(),
        "{}",
        String::from_utf8_lossy(&inspected.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&inspected.stdout).unwrap();
    let mut contract = value["projection"]["concept"].clone();
    let file = dir.join("concept.json");
    std::fs::write(&file, serde_json::to_vec(&contract).unwrap()).unwrap();
    let run = || {
        forgec()
            .arg("check")
            .arg(&dir)
            .arg("--concept-contract")
            .arg(&file)
            .output()
            .unwrap()
    };
    let success = run();
    assert!(
        success.status.success(),
        "{}",
        String::from_utf8_lossy(&success.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&success.stdout).unwrap();
    assert_eq!(report["unproven"], serde_json::json!([]));
    contract["processes"]["@test/contract/_/Work"]["outputs"]["@test/contract/_/Work#output:return"]
        ["disposition"]["kind"] = "produceEntity".into();
    std::fs::write(&file, serde_json::to_vec(&contract).unwrap()).unwrap();
    let failure = run();
    assert_eq!(failure.status.code(), Some(1));
    let report: serde_json::Value = serde_json::from_slice(&failure.stdout).unwrap();
    assert_eq!(report["unproven"][0]["code"], "E-L0-UNPROVEN");
    assert_eq!(report["violations"], serde_json::json!([]));
    contract["version"] = "concept-ir/1".into();
    std::fs::write(&file, serde_json::to_vec(&contract).unwrap()).unwrap();
    assert!(!run().status.success());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn inspect_concept_supports_scoped_graphs() {
    let run = |anchor: &str| {
        forgec()
            .arg("inspect")
            .arg(examples().join("acme"))
            .args(["--concept", "--focus", anchor, "--hops", "0"])
            .output()
            .unwrap()
    };
    let result = run("@acme/commerce/_/Customer");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(value["graph"]["nodes"].as_object().unwrap().len(), 1);
    assert_eq!(value["graph"]["edges"], serde_json::json!([]));
    assert!(
        value["projection"]["concept"]["entities"]
            .as_object()
            .unwrap()
            .len()
            > 1
    );
    assert!(!run("missing").status.success());
}
