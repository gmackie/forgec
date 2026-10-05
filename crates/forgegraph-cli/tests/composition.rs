use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Fixture(PathBuf);
impl Fixture {
    fn new(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("forge-composition-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn package(&self, dir: &str, name: &str, deps: &str, source: &str) {
        let root = self.0.join(dir);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("forge.toml"),
            format!(
                "[package]\nname = \"{name}\"\nversion = \"1.0.0\"\n\n[dependencies]\n{deps}\n"
            ),
        )
        .unwrap();
        std::fs::write(root.join("src/main.forge"), source).unwrap();
    }
    fn run(&self, cmd: &str) -> Output {
        Command::new(env!("CARGO_BIN_EXE_forgec"))
            .arg(cmd)
            .arg(self.0.join("app"))
            .output()
            .unwrap()
    }
    fn build(&self) -> Value {
        success(self.run("build"));
        serde_json::from_slice(&std::fs::read(self.0.join("app/generated/app.json")).unwrap())
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn success(out: Output) -> Output {
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    out
}
fn failure(out: Output, code: &str) {
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains(code),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
fn resource(name: &str) -> String {
    format!(
        "export resource {name}\n  @crud(\"/v1/{name}\")\n  @tenant\n  @versioned\n{{\n  id : id\n}}\n"
    )
}
fn ids(bundle: &Value) -> Vec<&str> {
    bundle["ir"]["modules"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|m| m["resources"].as_array().unwrap())
        .map(|r| r["id"].as_str().unwrap())
        .collect()
}
fn generated(root: &Path, path: &str) -> String {
    std::fs::read_to_string(root.join("app/generated").join(path)).unwrap()
}

#[test]
fn explicit_closure_preserves_identity_and_emits_cross_package_foreign_keys() {
    let f = Fixture::new("owned");
    f.package("records", "@t/records", "", &resource("Aggregate"));
    f.package("remote", "@t/remote", "", &resource("Remote"));
    f.package("app", "@t/app", "records = { path = '../records', deploy = true }\nremote = { path = '../remote' }", "import records\nresource Satellite\n  @tenant\n  @versioned\n{\n  id : id\n  aggregate : records.Aggregate\n}\n");
    success(f.run("check"));
    let bundle = f.build();
    assert_eq!(
        ids(&bundle),
        vec!["@t/app/_/Satellite", "@t/records/_/Aggregate"]
    );
    let tables = bundle["sql"]["tables"].as_array().unwrap();
    let satellite = tables
        .iter()
        .find(|t| t["resource"] == "@t/app/_/Satellite")
        .unwrap();
    assert_eq!(satellite["foreignKeys"][0]["references"], "aggregate");
    assert_eq!(
        satellite["foreignKeys"][0]["columns"],
        serde_json::json!(["tenant", "aggregate"])
    );
    assert_eq!(
        bundle["deployment"]["packages"].as_array().unwrap().len(),
        2
    );
    assert!(generated(&f.0, "client.ts").contains("@t/records/_/Aggregate.create"));
    let sql = generated(&f.0, "postgres/0001_init.sql");
    assert!(
        sql.find("CREATE TABLE aggregate").unwrap() < sql.find("CREATE TABLE satellite").unwrap()
    );
    assert_eq!(bundle, f.build());
}

#[test]
fn selected_transitive_diamond_is_deduplicated_and_remote_subtrees_stay_remote() {
    let f = Fixture::new("diamond");
    f.package("base", "@t/base", "", &resource("Base"));
    for name in ["left", "right"] {
        f.package(
            name,
            &format!("@t/{name}"),
            "base = { path = '../base', deploy = true }",
            &resource(if name == "left" { "Left" } else { "Right" }),
        );
    }
    f.package(
        "app",
        "@t/app",
        "left = { path = '../left', deploy = true }\nright = { path = '../right', deploy = true }",
        &resource("App"),
    );
    let bundle = f.build();
    assert_eq!(
        ids(&bundle),
        vec![
            "@t/app/_/App",
            "@t/base/_/Base",
            "@t/left/_/Left",
            "@t/right/_/Right"
        ]
    );
    f.package(
        "app",
        "@t/app",
        "left = { path = '../left' }",
        &resource("App"),
    );
    let remote = f.build();
    assert_eq!(ids(&remote), vec!["@t/app/_/App"]);
    assert!(remote.get("deployment").is_none());
}

#[test]
fn rejects_missing_owned_targets_and_name_collisions() {
    let f = Fixture::new("closed");
    f.package("owned", "@t/owned", "", &resource("Owned"));
    f.package("remote", "@t/remote", "", &resource("Remote"));
    f.package(
        "app",
        "@t/app",
        "owned = { path = '../owned', deploy = true }\nremote = { path = '../remote' }",
        "import remote\nresource Satellite {\n  id : id\n  target : remote.Remote\n}\n",
    );
    failure(f.run("check"), "E-ASSEMBLY-004");
    f.package(
        "app",
        "@t/app",
        "owned = { path = '../owned', deploy = true }",
        &resource("Owned"),
    );
    failure(f.run("build"), "E-PLAN-003");
}

#[test]
fn conflicts_and_cycles_fail_before_artifacts_are_written() {
    let f = Fixture::new("conflict");
    f.package("a", "@t/same", "", &resource("A"));
    f.package("b", "@t/same", "", &resource("B"));
    f.package(
        "app",
        "@t/app",
        "a = { path = '../a', deploy = true }\nb = { path = '../b', deploy = true }",
        &resource("App"),
    );
    failure(f.run("build"), "E-ASSEMBLY-001");
    assert!(!f.0.join("app/generated").exists());
    f.package(
        "a",
        "@t/a",
        "app = { path = '../app', deploy = true }",
        &resource("A"),
    );
    failure(f.run("check"), "dependency cycle");
}

#[test]
fn locks_pin_transitive_contracts_and_deployment_selection() {
    let f = Fixture::new("lock");
    f.package("base", "@t/base", "", &resource("Base"));
    f.package(
        "lib",
        "@t/lib",
        "base = { path = '../base', deploy = true }",
        &resource("Lib"),
    );
    f.package(
        "app",
        "@t/app",
        "lib = { path = '../lib', deploy = true }",
        &resource("App"),
    );
    success(f.run("lock"));
    success(f.run("check"));
    f.package("base", "@t/base", "", &resource("ChangedBase"));
    failure(f.run("check"), "E-LOCK-001");
    success(f.run("lock"));
    f.package(
        "app",
        "@t/app",
        "lib = { path = '../lib' }",
        &resource("App"),
    );
    failure(f.run("check"), "E-LOCK-001");
}

#[test]
fn dependency_extensions_are_verified_and_unsupported_assembly_is_rejected() {
    use sha2::{Digest, Sha256};
    let f = Fixture::new("extensions");
    f.package("lib", "@t/lib", "", &resource("Lib"));
    f.package(
        "app",
        "@t/app",
        "lib = { path = '../lib', deploy = true }",
        &resource("App"),
    );
    let path = f.0.join("lib/forge.toml");
    let manifest = std::fs::read_to_string(&path).unwrap();
    let extension = r#"{"version":"capability-manifest/1","id":"test","kind":"test","adapterVersion":"1","engine":"test","runtime":"test","capabilities":[]}"#;
    std::fs::write(f.0.join("lib/extension.json"), extension).unwrap();
    std::fs::write(
        &path,
        format!("{manifest}\n[extensions.test]\nmanifest = 'extension.json'\nsha256 = 'wrong'\n"),
    )
    .unwrap();
    failure(f.run("build"), "E-EXT-001");
    let digest = hex::encode(Sha256::digest(extension));
    std::fs::write(
        &path,
        format!(
            "{manifest}\n[extensions.test]\nmanifest = 'extension.json'\nsha256 = '{digest}'\n"
        ),
    )
    .unwrap();
    failure(f.run("build"), "E-ASSEMBLY-005");
}

#[test]
fn declaration_order_does_not_change_build_identity_or_generated_artifacts() {
    let f = Fixture::new("order");
    f.package("a", "@t/a", "", &resource("Alpha"));
    f.package("b", "@t/b", "", &resource("Beta"));
    f.package(
        "app",
        "@t/app",
        "a = { path = '../a', deploy = true }\nb = { path = '../b', deploy = true }",
        &resource("App"),
    );
    let first = f.build();
    f.package(
        "app",
        "@t/app",
        "b = { path = '../b', deploy = true }\na = { path = '../a', deploy = true }",
        &resource("App"),
    );
    assert_eq!(first, f.build());
}

#[test]
fn co_deployed_http_bindings_must_not_overlap() {
    let f = Fixture::new("routes");
    f.package(
        "lib",
        "@t/lib",
        "",
        &resource("Lib").replace("/v1/Lib", "/v1/shared"),
    );
    f.package(
        "app",
        "@t/app",
        "lib = { path = '../lib', deploy = true }",
        &resource("App").replace("/v1/App", "/v1/shared"),
    );
    failure(f.run("build"), "HTTP route collision");
}
