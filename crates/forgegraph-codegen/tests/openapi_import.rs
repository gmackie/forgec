//! FORGE-052 (PAR-116/117/118): a pinned, offline OpenAPI importer. Remote
//! references resolve only through explicit pins to local files; callback and
//! server URLs on private/metadata hosts are refused; nullable/optional
//! semantics and enums are preserved or the feature is reported unsupported;
//! foreign identifiers stay `text` and never become Forge references.
use forgegraph_codegen::openapi_import::{ImportOptions, Pin, import_openapi};
use std::path::{Path, PathBuf};

fn fixtures() -> PathBuf {
    Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/openapi-import"
    ))
    .to_path_buf()
}

fn pinned() -> ImportOptions {
    ImportOptions {
        package: "@vendor/billing".into(),
        pins: vec![Pin {
            url: "https://schemas.vendor.example/common/v1.json".into(),
            file: fixtures().join("common-v1.json"),
            sha256: None,
        }],
        allow_hosts: vec!["billing.vendor.example".into(), "hooks.acme.example".into()],
    }
}

#[test]
fn pinned_refs_resolve_offline_and_unpinned_remote_refs_fail() {
    let doc = std::fs::read_to_string(fixtures().join("vendor.json")).unwrap();
    // Without a pin, the remote $ref is a hard error and nothing is fetched (PAR-116).
    let no_pins = import_openapi(
        &doc,
        &ImportOptions {
            package: "@vendor/billing".into(),
            ..ImportOptions::default()
        },
    );
    let err = no_pins.expect_err("unpinned remote ref must fail");
    assert!(
        err.contains("schemas.vendor.example/common/v1.json"),
        "{err}"
    );
    assert!(err.contains("pin"), "{err}");
    // With a pin, the reference resolves from the local file.
    let out = import_openapi(&doc, &pinned()).unwrap();
    let src = &out.files["src/index.forge"];
    assert!(src.contains("shape InvoiceCreateMeta {"), "{src}");
    assert!(src.contains("priority : integer? >= 0 <= 9"), "{src}");
}

#[test]
fn import_is_deterministic_and_compiles() {
    let doc = std::fs::read_to_string(fixtures().join("vendor.json")).unwrap();
    let a = import_openapi(&doc, &pinned()).unwrap();
    let b = import_openapi(&doc, &pinned()).unwrap();
    assert_eq!(a.files, b.files);
    assert_eq!(a.report, b.report);
    // The generated package compiles as a Forge package.
    let dir = tempfile::tempdir().unwrap();
    for (path, text) in &a.files {
        let p = dir.path().join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    let pkg = forgegraph_semantic::load_package(dir.path()).unwrap();
    let compiled = forgegraph_semantic::compile(&pkg, &[]);
    assert!(
        compiled
            .diagnostics
            .iter()
            .all(|d| d.severity != forgegraph_semantic::Severity::Error),
        "{:?}",
        compiled.diagnostics
    );
    let ir = compiled.ir.unwrap();
    assert_eq!(ir.package.name, "@vendor/billing");
    let f = ir
        .modules
        .iter()
        .flat_map(|m| m.functions.iter())
        .find(|f| f.name == "CreateInvoice")
        .expect("operation became a function");
    assert_eq!(f.http.as_ref().unwrap().path, "/invoices");
    assert_eq!(
        f.errors,
        vec!["PaymentRequired".to_string(), "Invalid".to_string()]
    );
    insta::assert_snapshot!("vendor_index", a.files["src/index.forge"]);
    insta::assert_json_snapshot!("vendor_report", a.report);
}

#[test]
fn nullability_optionality_and_enums_are_preserved_or_reported() {
    let doc = std::fs::read_to_string(fixtures().join("vendor.json")).unwrap();
    let out = import_openapi(&doc, &pinned()).unwrap();
    let src = &out.files["src/index.forge"];
    // required + not nullable, optional + nullable, and OpenAPI 3.0 `nullable`
    assert!(src.contains("amount : text pattern"), "{src}");
    assert!(src.contains("memo : text? length <= 200"), "{src}");
    assert!(src.contains("note : text?"), "{src}");
    assert!(src.contains("paid_at : datetime?"), "{src}");
    // enums become Forge enums, shared by identical value sets
    assert!(src.contains("enum Currency {"), "{src}");
    assert!(src.contains("currency : Currency"), "{src}");
    assert!(src.contains("enum InvoiceStatus {"), "{src}");
    // unsupported features are diagnostics, not silent approximations (PAR-117)
    let unsupported: Vec<&str> = out
        .report
        .unsupported
        .iter()
        .map(|u| u.feature.as_str())
        .collect();
    assert!(unsupported.contains(&"oneOf"), "{unsupported:?}");
    assert!(unsupported.contains(&"binary-media"), "{unsupported:?}");
    assert!(unsupported.contains(&"query-array-form"), "{unsupported:?}");
    assert!(
        out.report
            .unsupported
            .iter()
            .any(|u| u.at == "components.schemas.Invoice.attachment")
    );
    // the legacy PDF operation is skipped rather than mistyped
    assert!(!src.contains("LegacyReport"), "{src}");
    assert!(
        out.report
            .skipped_operations
            .contains(&"legacyReport".to_string())
    );
}

#[test]
fn foreign_identifiers_stay_text_and_are_listed_for_review() {
    let doc = std::fs::read_to_string(fixtures().join("vendor.json")).unwrap();
    let out = import_openapi(&doc, &pinned()).unwrap();
    let src = &out.files["src/index.forge"];
    // `customer_id` looks like an id but is the vendor's: it is text, never `Customer` (PAR-118)
    assert!(src.contains("customer_id : text"), "{src}");
    assert!(!src.contains(": Customer"), "{src}");
    assert!(
        out.report
            .foreign_identifiers
            .iter()
            .any(|f| f.field == "customer_id" && f.shape == "InvoiceCreate")
    );
    // the review file says how to wire them: an explicit resolver, never structural coincidence
    let review = &out.files["FOREIGN_IDS.md"];
    assert!(review.contains("customer_id"));
    assert!(review.contains("resolver"));
}

#[test]
fn callbacks_webhooks_and_servers_on_private_hosts_are_refused() {
    let doc = std::fs::read_to_string(fixtures().join("vendor.json")).unwrap();
    let out = import_openapi(&doc, &pinned()).unwrap();
    // callbacks and webhooks are recorded as inbound contracts (they need a reviewed endpoint, not a URL in a spec)
    let names: Vec<&str> = out
        .report
        .callbacks
        .iter()
        .map(|c| c.name.as_str())
        .collect();
    assert_eq!(
        names,
        vec!["createInvoice.onPaid", "webhook:invoice.voided"]
    );
    // a server URL on a private/metadata host fails closed
    for bad in [
        "http://169.254.169.254/latest",
        "http://10.0.0.5/api",
        "http://localhost:8080",
        "http://metadata.google.internal/",
        "http://[::1]/",
        "http://127.1/",
    ] {
        let doc2 = doc.replace("https://billing.vendor.example/v2", bad);
        let err = import_openapi(&doc2, &pinned()).expect_err(bad);
        assert!(
            err.contains("private") || err.contains("forbidden"),
            "{bad}: {err}"
        );
    }
    // a public host that is not in the allow-list is also refused: the import names what it trusts
    let doc3 = doc.replace(
        "https://billing.vendor.example/v2",
        "https://other.example/v2",
    );
    assert!(import_openapi(&doc3, &pinned()).is_err());
    // a pinned file whose digest does not match is refused
    let mut opts = pinned();
    opts.pins[0].sha256 = Some("00".repeat(32));
    assert!(
        import_openapi(&doc, &opts)
            .err()
            .unwrap()
            .contains("sha256")
    );
}
