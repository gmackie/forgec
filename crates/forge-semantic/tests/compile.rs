use forge_semantic::{compile, load_package, Package};
use std::path::Path;

fn examples() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples"))
}

fn inline(name: &str, files: &[(&str, &str)]) -> Package {
    Package::inline(name, files.iter().map(|(p, s)| (p.to_string(), s.to_string())).collect())
}

fn codes(pkg: Package) -> Vec<String> {
    let mut c: Vec<String> = compile(&pkg, &[]).diagnostics.iter().map(|d| d.code.clone()).collect();
    c.sort();
    c.dedup();
    c
}

#[test]
fn reference_app_compiles_without_diagnostics_and_ir_is_a_stable_snapshot() {
    let payments = load_package(&examples().join("payments")).unwrap();
    let pay = compile(&payments, &[]);
    assert!(pay.diagnostics.is_empty(), "{:#?}", pay.diagnostics);
    let acme = load_package(&examples().join("acme")).unwrap();
    let out = compile(&acme, &[pay.ir.as_ref().unwrap()]);
    assert!(out.diagnostics.is_empty(), "{:#?}", out.diagnostics);
    insta::assert_json_snapshot!(out.ir.unwrap());
}

#[test]
fn ir_is_identical_regardless_of_file_order_and_path_separators() {
    let acme = load_package(&examples().join("acme")).unwrap();
    let payments = load_package(&examples().join("payments")).unwrap();
    let pay = compile(&payments, &[]).ir.unwrap();
    let a = serde_json::to_string(&compile(&acme, &[&pay]).ir.unwrap()).unwrap();
    let mut files = acme.files.clone();
    files.reverse();
    for f in &mut files {
        f.path = f.path.replace('/', "\\");
    }
    let reordered = Package { files, ..acme.clone() };
    let b = serde_json::to_string(&compile(&reordered, &[&pay]).ir.unwrap()).unwrap();
    assert_eq!(a, b);
}

#[test]
fn stable_ids_do_not_depend_on_file_location() {
    let a = inline("@t/x", &[("src/a/customer.forge", "resource Customer {\n  id : id\n}\n")]);
    let b = inline("@t/x", &[("src/zzz/moved.forge", "resource Customer {\n  id : id\n}\n")]);
    let ia = serde_json::to_string(&compile(&a, &[]).ir.unwrap()).unwrap();
    let ib = serde_json::to_string(&compile(&b, &[]).ir.unwrap()).unwrap();
    assert_eq!(ia, ib);
    assert!(ia.contains("\"@t/x/_/Customer\""));
}

#[test]
fn unknown_type_and_unknown_field_references_are_rejected_with_suggestions() {
    let p = inline("@t/x", &[("src/a.forge", "resource Customer {\n  id : id\n  tier : CustomerTeir\n  list by tiers\n}\n")]);
    let out = compile(&p, &[]);
    let c: Vec<&str> = out.diagnostics.iter().map(|d| d.code.as_str()).collect();
    assert_eq!(c, vec!["E-SYM-001", "E-QRY-002"]);
    assert!(out.ir.is_none());
}

#[test]
fn lifecycle_diagnostics() {
    let missing_initial = inline("@t/x", &[("src/a.forge", "resource O {\n  id : id\n  lifecycle status {\n    terminal Done\n    finish: Open -> Done\n  }\n}\n")]);
    assert_eq!(codes(missing_initial), vec!["E-LC-001"]);

    let outgoing_from_terminal = inline("@t/x", &[("src/a.forge", "resource O {\n  id : id\n  lifecycle status {\n    initial Open\n    terminal Done\n    finish: Open -> Done\n    reopen: Done -> Open\n  }\n}\n")]);
    assert_eq!(codes(outgoing_from_terminal), vec!["E-LC-002"]);

    let duplicate_action = inline("@t/x", &[("src/a.forge", "resource O {\n  id : id\n  lifecycle status {\n    initial Open\n    finish: Open -> Done\n    finish: Open -> Closed\n  }\n}\n")]);
    assert!(codes(duplicate_action).contains(&"E-LC-003".to_string()));

    let unreachable = inline("@t/x", &[("src/a.forge", "resource O {\n  id : id\n  lifecycle status {\n    initial Open\n    finish: Open -> Done\n    weird: Orphan -> Done\n  }\n}\n")]);
    assert!(codes(unreachable).contains(&"E-LC-004".to_string()));

    let typo = inline("@t/x", &[("src/a.forge", "resource O {\n  id : id\n  lifecycle status {\n    initial Open\n    approve: Open -> Approved\n    ship: Aproved -> Shipped\n  }\n}\n")]);
    assert!(codes(typo).contains(&"W-LC-011".to_string()));
}

#[test]
fn lifecycle_synthesizes_status_field_enum_and_transition_operations() {
    let p = inline("@t/x", &[("src/a.forge", "resource O {\n  id : id\n  lifecycle status {\n    initial Open\n    terminal Done\n    finish: Open -> Done\n      input {\n        note : text\n      }\n  }\n}\n")]);
    let ir = compile(&p, &[]).ir.unwrap();
    let json = serde_json::to_value(&ir).unwrap();
    let res = &json["modules"][0]["resources"][0];
    assert_eq!(res["lifecycle"]["states"], serde_json::json!(["Open", "Done"]));
    assert_eq!(res["lifecycle"]["initial"], "Open");
    let status = res["fields"].as_array().unwrap().iter().find(|f| f["name"] == "status").unwrap();
    assert_eq!(status["serverOwned"], true);
    assert_eq!(status["type"]["base"]["kind"], "status");
    let ops: Vec<&str> = res["operations"].as_array().unwrap().iter().map(|o| o["id"].as_str().unwrap()).collect();
    assert!(ops.contains(&"@t/x/_/O.status.finish"), "{ops:?}");
    let enums = json["modules"][0]["enums"].as_array().unwrap();
    assert!(enums.iter().any(|e| e["id"] == "@t/x/_/O.Status" && e["synthesized"] == true));
}

#[test]
fn enum_and_default_checks() {
    let dup = inline("@t/x", &[("src/a.forge", "enum T {\n  A = \"x\"\n  B = \"x\"\n}\n")]);
    assert_eq!(codes(dup), vec!["E-ENUM-001"]);
    let bad_default = inline("@t/x", &[("src/a.forge", "enum T {\n  A\n}\nresource R {\n  id : id\n  t : T = T.Zed\n}\n")]);
    assert_eq!(codes(bad_default), vec!["E-TYPE-010"]);
    let derived_with_default = inline("@t/x", &[("src/a.forge", "resource R {\n  id : id\n  a : integer\n  b := a + 1 @immutable\n}\n")]);
    assert_eq!(codes(derived_with_default), vec!["E-DEC-003"]);
}

#[test]
fn query_and_uniqueness_checks() {
    let find_uncovered = inline("@t/x", &[("src/a.forge", "resource R {\n  id : id\n  code : text\n  find by code\n}\n")]);
    assert_eq!(codes(find_uncovered), vec!["E-QRY-001"]);
    let ok = inline("@t/x", &[("src/a.forge", "resource R {\n  id : id\n  code : text @unique\n  find by code\n}\n")]);
    assert_eq!(codes(ok), Vec::<String>::new());
}

#[test]
fn decorator_checks() {
    let unknown = inline("@t/x", &[("src/a.forge", "resource R\n  @tenannt\n{\n  id : id\n}\n")]);
    assert_eq!(codes(unknown), vec!["E-DEC-001"]);
    let collision = inline("@t/x", &[("src/a.forge", "resource R\n  @timestamps\n{\n  id : id\n  createdAt : datetime\n}\n")]);
    assert_eq!(codes(collision), vec!["E-RES-001"]);
    let crud_args = inline("@t/x", &[("src/a.forge", "resource R\n  @crud\n{\n  id : id\n}\n")]);
    assert_eq!(codes(crud_args), vec!["E-DEC-002"]);
    let unknown_action = inline("@t/x", &[("src/a.forge", "resource O\n  @crud(\"/v1/o\", actions: [aprove])\n{\n  id : id\n  lifecycle status {\n    initial Open\n    approve: Open -> Approved\n  }\n}\n")]);
    assert_eq!(codes(unknown_action), vec!["E-DEC-004"]);
    let http_path_param = inline("@t/x", &[("src/a.forge", "shape In {\n  a : text\n}\nfunction F\n  @http(POST, \"/v1/f/{missing}\")\n{\n  input In\n}\n")]);
    assert_eq!(codes(http_path_param), vec!["E-HTTP-001"]);
}

#[test]
fn messaging_direction_and_subscription_checks() {
    let send_to_recv_only = inline("@t/x", &[("src/a.forge", "channel C {\n  recv-only\n  message M {\n    a : text\n  }\n}\nfunction F {\n  sends {\n    M to C\n  }\n}\n")]);
    assert_eq!(codes(send_to_recv_only), vec!["E-CH-001"]);
    let missing_message = inline("@t/x", &[("src/a.forge", "channel C {\n  message M {\n    a : text\n  }\n}\non C.Nope -> F\nfunction F {\n  input C.M\n}\n")]);
    assert_eq!(codes(missing_message), vec!["E-SYM-001"]);
    let handler_input_mismatch = inline("@t/x", &[("src/a.forge", "channel C {\n  message M {\n    a : text\n  }\n}\non C.M -> F\nfunction F {\n  input Other\n}\nshape Other {\n  b : text\n}\n")]);
    assert_eq!(codes(handler_input_mismatch), vec!["E-SUB-001"]);
}

#[test]
fn imports_provide_only_exported_contracts() {
    let dep = inline("@t/dep", &[("src/a.forge", "export shape Pub {\n  a : text\n}\nshape Priv {\n  a : text\n}\nexport channel Ev {\n  message Happened {\n    a : text\n  }\n}\n")]);
    let dep_ir = compile(&dep, &[]).ir.unwrap();
    let ok = Package { dependencies: vec![("dep".into(), "@t/dep".into())], ..inline("@t/x", &[("src/a.forge", "import dep\nfunction F {\n  input dep.Pub\n}\nchannel Local from dep.Ev {\n  recv-only\n}\n")]) };
    assert!(compile(&ok, &[&dep_ir]).diagnostics.is_empty(), "{:#?}", compile(&ok, &[&dep_ir]).diagnostics);
    let bad = Package { dependencies: vec![("dep".into(), "@t/dep".into())], ..inline("@t/x", &[("src/a.forge", "import dep\nfunction F {\n  input dep.Priv\n}\n")]) };
    let c: Vec<String> = compile(&bad, &[&dep_ir]).diagnostics.iter().map(|d| d.code.clone()).collect();
    assert_eq!(c, vec!["E-SYM-003"]);
}

#[test]
fn diagnostics_carry_file_and_range_and_render_stably() {
    let p = inline("@t/x", &[("src/a.forge", "resource R {\n  id : id\n  x : Nope\n}\n")]);
    let out = compile(&p, &[]);
    insta::assert_snapshot!(out.render());
}

#[test]
fn blob_elaborates_to_a_resource_with_content_policy_and_upload_operations() {
    let p = inline("@t/x", &[("src/a.forge", "blob Doc\n  @tenant\n  @crud(\"/v1/docs\")\n{\n  label : text length 1..200\n\n  content {\n    mediaTypes [\"application/pdf\"]\n    maxBytes 1024\n  }\n}\n")]);
    let out = compile(&p, &[]);
    assert!(out.diagnostics.is_empty(), "{:#?}", out.diagnostics);
    let json = serde_json::to_value(out.ir.unwrap()).unwrap();
    let r = &json["modules"][0]["resources"][0];
    assert_eq!(r["kind"], "blob");
    assert_eq!(r["content"], serde_json::json!({ "mediaTypes": ["application/pdf"], "maxBytes": 1024 }));
    let names: Vec<&str> = r["fields"].as_array().unwrap().iter().map(|f| f["name"].as_str().unwrap()).collect();
    for f in ["id", "label", "version", "createdAt", "updatedAt", "uploadState", "mediaType", "byteCount", "digest"] {
        assert!(names.contains(&f), "missing {f} in {names:?}");
    }
    let ops: Vec<&str> = r["operations"].as_array().unwrap().iter().map(|o| o["id"].as_str().unwrap().rsplit('.').next().unwrap()).collect();
    assert!(ops.contains(&"beginUpload") && ops.contains(&"finalizeUpload") && ops.contains(&"download"), "{ops:?}");
    let bad = inline("@t/x", &[("src/a.forge", "blob Doc {\n  label : text\n  content {\n    maxBytes 0\n  }\n}\n")]);
    assert_eq!(codes(bad), vec!["E-BLOB-001"]); // blobs synthesize their id
}
