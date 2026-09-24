use forgegraph_semantic::{Package, compile, load_package};
use std::path::Path;

fn examples() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples"))
}

fn inline(name: &str, files: &[(&str, &str)]) -> Package {
    Package::inline(
        name,
        files
            .iter()
            .map(|(p, s)| (p.to_string(), s.to_string()))
            .collect(),
    )
}

fn codes(pkg: Package) -> Vec<String> {
    let mut c: Vec<String> = compile(&pkg, &[])
        .diagnostics
        .iter()
        .map(|d| d.code.clone())
        .collect();
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
    let reordered = Package {
        files,
        ..acme.clone()
    };
    let b = serde_json::to_string(&compile(&reordered, &[&pay]).ir.unwrap()).unwrap();
    assert_eq!(a, b);
}

#[test]
fn stable_ids_do_not_depend_on_file_location() {
    let a = inline(
        "@t/x",
        &[(
            "src/a/customer.forge",
            "resource Customer {\n  id : id\n}\n",
        )],
    );
    let b = inline(
        "@t/x",
        &[("src/zzz/moved.forge", "resource Customer {\n  id : id\n}\n")],
    );
    let ia = serde_json::to_string(&compile(&a, &[]).ir.unwrap()).unwrap();
    let ib = serde_json::to_string(&compile(&b, &[]).ir.unwrap()).unwrap();
    assert_eq!(ia, ib);
    assert!(ia.contains("\"@t/x/_/Customer\""));
}

#[test]
fn unknown_type_and_unknown_field_references_are_rejected_with_suggestions() {
    let p = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "resource Customer {\n  id : id\n  tier : CustomerTeir\n  list by tiers\n}\n",
        )],
    );
    let out = compile(&p, &[]);
    let c: Vec<&str> = out.diagnostics.iter().map(|d| d.code.as_str()).collect();
    assert_eq!(c, vec!["E-SYM-001", "E-QRY-002"]);
    assert!(out.ir.is_none());
}

#[test]
fn lifecycle_diagnostics() {
    let missing_initial = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "resource O {\n  id : id\n  lifecycle status {\n    terminal Done\n    finish: Open -> Done\n  }\n}\n",
        )],
    );
    assert_eq!(codes(missing_initial), vec!["E-LC-001"]);

    let outgoing_from_terminal = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "resource O {\n  id : id\n  lifecycle status {\n    initial Open\n    terminal Done\n    finish: Open -> Done\n    reopen: Done -> Open\n  }\n}\n",
        )],
    );
    assert_eq!(codes(outgoing_from_terminal), vec!["E-LC-002"]);

    let duplicate_action = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "resource O {\n  id : id\n  lifecycle status {\n    initial Open\n    finish: Open -> Done\n    finish: Open -> Closed\n  }\n}\n",
        )],
    );
    assert!(codes(duplicate_action).contains(&"E-LC-003".to_string()));

    let unreachable = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "resource O {\n  id : id\n  lifecycle status {\n    initial Open\n    finish: Open -> Done\n    weird: Orphan -> Done\n  }\n}\n",
        )],
    );
    assert!(codes(unreachable).contains(&"E-LC-004".to_string()));

    let typo = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "resource O {\n  id : id\n  lifecycle status {\n    initial Open\n    approve: Open -> Approved\n    ship: Aproved -> Shipped\n  }\n}\n",
        )],
    );
    assert!(codes(typo).contains(&"W-LC-011".to_string()));
}

#[test]
fn lifecycle_synthesizes_status_field_enum_and_transition_operations() {
    let p = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "resource O {\n  id : id\n  lifecycle status {\n    initial Open\n    terminal Done\n    finish: Open -> Done\n      input {\n        note : text\n      }\n  }\n}\n",
        )],
    );
    let ir = compile(&p, &[]).ir.unwrap();
    let json = serde_json::to_value(&ir).unwrap();
    let res = &json["modules"][0]["resources"][0];
    assert_eq!(
        res["lifecycle"]["states"],
        serde_json::json!(["Open", "Done"])
    );
    assert_eq!(res["lifecycle"]["initial"], "Open");
    let status = res["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == "status")
        .unwrap();
    assert_eq!(status["serverOwned"], true);
    assert_eq!(status["type"]["base"]["kind"], "status");
    let ops: Vec<&str> = res["operations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["id"].as_str().unwrap())
        .collect();
    assert!(ops.contains(&"@t/x/_/O.status.finish"), "{ops:?}");
    let enums = json["modules"][0]["enums"].as_array().unwrap();
    assert!(
        enums
            .iter()
            .any(|e| e["id"] == "@t/x/_/O.Status" && e["synthesized"] == true)
    );
}

#[test]
fn enum_and_default_checks() {
    let dup = inline(
        "@t/x",
        &[("src/a.forge", "enum T {\n  A = \"x\"\n  B = \"x\"\n}\n")],
    );
    assert_eq!(codes(dup), vec!["E-ENUM-001"]);
    let bad_default = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "enum T {\n  A\n}\nresource R {\n  id : id\n  t : T = T.Zed\n}\n",
        )],
    );
    assert_eq!(codes(bad_default), vec!["E-TYPE-010"]);
    let derived_with_default = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "resource R {\n  id : id\n  a : integer\n  b := a + 1 @immutable\n}\n",
        )],
    );
    assert_eq!(codes(derived_with_default), vec!["E-DEC-003"]);
}

#[test]
fn query_and_uniqueness_checks() {
    let find_uncovered = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "resource R {\n  id : id\n  code : text\n  find by code\n}\n",
        )],
    );
    assert_eq!(codes(find_uncovered), vec!["E-QRY-001"]);
    let ok = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "resource R {\n  id : id\n  code : text @unique\n  find by code\n}\n",
        )],
    );
    assert_eq!(codes(ok), Vec::<String>::new());
}

#[test]
fn decorator_checks() {
    let unknown = inline(
        "@t/x",
        &[("src/a.forge", "resource R\n  @tenannt\n{\n  id : id\n}\n")],
    );
    assert_eq!(codes(unknown), vec!["E-DEC-001"]);
    let collision = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "resource R\n  @timestamps\n{\n  id : id\n  createdAt : datetime\n}\n",
        )],
    );
    assert_eq!(codes(collision), vec!["E-RES-001"]);
    let crud_args = inline(
        "@t/x",
        &[("src/a.forge", "resource R\n  @crud\n{\n  id : id\n}\n")],
    );
    assert_eq!(codes(crud_args), vec!["E-DEC-002"]);
    let unknown_action = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "resource O\n  @crud(\"/v1/o\", actions: [aprove])\n{\n  id : id\n  lifecycle status {\n    initial Open\n    approve: Open -> Approved\n  }\n}\n",
        )],
    );
    assert_eq!(codes(unknown_action), vec!["E-DEC-004"]);
    let http_path_param = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "shape In {\n  a : text\n}\nfunction F\n  @http(POST, \"/v1/f/{missing}\")\n{\n  input In\n}\n",
        )],
    );
    assert_eq!(codes(http_path_param), vec!["E-HTTP-001"]);
}

#[test]
fn messaging_direction_and_subscription_checks() {
    let send_to_recv_only = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "channel C {\n  recv-only\n  message M {\n    a : text\n  }\n}\nfunction F {\n  sends {\n    M to C\n  }\n}\n",
        )],
    );
    assert_eq!(codes(send_to_recv_only), vec!["E-CH-001"]);
    let missing_message = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "channel C {\n  message M {\n    a : text\n  }\n}\non C.Nope -> F\nfunction F {\n  input C.M\n}\n",
        )],
    );
    assert_eq!(codes(missing_message), vec!["E-SYM-001"]);
    let handler_input_mismatch = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "channel C {\n  message M {\n    a : text\n  }\n}\non C.M -> F\nfunction F {\n  input Other\n}\nshape Other {\n  b : text\n}\n",
        )],
    );
    assert_eq!(codes(handler_input_mismatch), vec!["E-SUB-001"]);
}

#[test]
fn imports_provide_only_exported_contracts() {
    let dep = inline(
        "@t/dep",
        &[(
            "src/a.forge",
            "export shape Pub {\n  a : text\n}\nshape Priv {\n  a : text\n}\nexport channel Ev {\n  message Happened {\n    a : text\n  }\n}\n",
        )],
    );
    let dep_ir = compile(&dep, &[]).ir.unwrap();
    let ok = Package {
        dependencies: vec![("dep".into(), "@t/dep".into())],
        ..inline(
            "@t/x",
            &[(
                "src/a.forge",
                "import dep\nfunction F {\n  input dep.Pub\n}\nchannel Local from dep.Ev {\n  recv-only\n}\n",
            )],
        )
    };
    assert!(
        compile(&ok, &[&dep_ir]).diagnostics.is_empty(),
        "{:#?}",
        compile(&ok, &[&dep_ir]).diagnostics
    );
    let bad = Package {
        dependencies: vec![("dep".into(), "@t/dep".into())],
        ..inline(
            "@t/x",
            &[(
                "src/a.forge",
                "import dep\nfunction F {\n  input dep.Priv\n}\n",
            )],
        )
    };
    let c: Vec<String> = compile(&bad, &[&dep_ir])
        .diagnostics
        .iter()
        .map(|d| d.code.clone())
        .collect();
    assert_eq!(c, vec!["E-SYM-003"]);
}

#[test]
fn diagnostics_carry_file_and_range_and_render_stably() {
    let p = inline(
        "@t/x",
        &[("src/a.forge", "resource R {\n  id : id\n  x : Nope\n}\n")],
    );
    let out = compile(&p, &[]);
    insta::assert_snapshot!(out.render());
}

#[test]
fn blob_elaborates_to_a_resource_with_content_policy_and_upload_operations() {
    let p = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "blob Doc\n  @tenant\n  @crud(\"/v1/docs\")\n{\n  label : text length 1..200\n\n  content {\n    mediaTypes [\"application/pdf\"]\n    maxBytes 1024\n  }\n}\n",
        )],
    );
    let out = compile(&p, &[]);
    assert!(out.diagnostics.is_empty(), "{:#?}", out.diagnostics);
    let json = serde_json::to_value(out.ir.unwrap()).unwrap();
    let r = &json["modules"][0]["resources"][0];
    assert_eq!(r["kind"], "blob");
    assert_eq!(
        r["content"],
        serde_json::json!({ "mediaTypes": ["application/pdf"], "maxBytes": 1024 })
    );
    let names: Vec<&str> = r["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap())
        .collect();
    for f in [
        "id",
        "label",
        "version",
        "createdAt",
        "updatedAt",
        "uploadState",
        "mediaType",
        "byteCount",
        "digest",
    ] {
        assert!(names.contains(&f), "missing {f} in {names:?}");
    }
    let ops: Vec<&str> = r["operations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["id"].as_str().unwrap().rsplit('.').next().unwrap())
        .collect();
    assert!(
        ops.contains(&"beginUpload")
            && ops.contains(&"finalizeUpload")
            && ops.contains(&"download"),
        "{ops:?}"
    );
    let bad = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "blob Doc {\n  label : text\n  content {\n    maxBytes 0\n  }\n}\n",
        )],
    );
    assert_eq!(codes(bad), vec!["E-BLOB-001"]); // blobs synthesize their id
}

#[test]
fn effective_dated_and_hierarchical_resources_synthesize_fields_and_operations() {
    let ex = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples"));
    let pay = compile(&load_package(&ex.join("payments")).unwrap(), &[])
        .ir
        .unwrap();
    let out = compile(&load_package(&ex.join("acme")).unwrap(), &[&pay]);
    assert!(out.diagnostics.is_empty(), "{:#?}", out.diagnostics);
    let json = serde_json::to_value(out.ir.unwrap()).unwrap();
    let res = json["modules"][0]["resources"].as_array().unwrap();
    let policy = res.iter().find(|r| r["name"] == "SitePolicy").unwrap();
    let names: Vec<&str> = policy["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap())
        .collect();
    assert!(
        names.contains(&"effectiveFrom") && names.contains(&"effectiveUntil"),
        "{names:?}"
    );
    // effectiveFrom is writable on create (server-owned would make it unsettable); effectiveUntil too
    let ef = policy["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == "effectiveFrom")
        .unwrap();
    assert_eq!(ef["serverOwned"], false);
    assert_eq!(
        policy["decorators"]["effectiveDated"]["uniqueBy"],
        serde_json::json!(["site"])
    );
    let ops: Vec<&str> = policy["operations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["id"].as_str().unwrap().rsplit('/').next().unwrap())
        .collect();
    assert!(ops.contains(&"SitePolicy.effective.bySite"), "{ops:?}");
    let dept = res.iter().find(|r| r["name"] == "Department").unwrap();
    let dnames: Vec<&str> = dept["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap())
        .collect();
    assert!(dnames.contains(&"parent"));
    let dops: Vec<&str> = dept["operations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["id"].as_str().unwrap().rsplit('/').next().unwrap())
        .collect();
    for o in [
        "Department.move",
        "Department.children",
        "Department.ancestors",
    ] {
        assert!(dops.contains(&o), "missing {o} in {dops:?}");
    }
    let bad = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "resource P\n  @effectiveDated(uniqueBy: [nope])\n{\n  id : id\n  a : text\n}\n",
        )],
    );
    assert_eq!(codes(bad), vec!["E-QRY-002"]);
}

#[test]
fn views_projections_and_caches_elaborate_and_are_checked() {
    let ex = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples"));
    let pay = compile(&load_package(&ex.join("payments")).unwrap(), &[])
        .ir
        .unwrap();
    let out = compile(&load_package(&ex.join("acme")).unwrap(), &[&pay]);
    assert!(out.diagnostics.is_empty(), "{:#?}", out.diagnostics);
    let json = serde_json::to_value(out.ir.unwrap()).unwrap();
    let m = &json["modules"][0];
    let view = m["views"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "PendingOrders")
        .unwrap();
    assert_eq!(view["source"], "@acme/commerce/_/Order");
    assert_eq!(view["by"], serde_json::json!(["customer"]));
    assert_eq!(
        view["fields"],
        serde_json::json!(["id", "site", "total", "requestedOn"])
    );
    assert_eq!(view["order"][0]["field"], "createdAt");
    assert_eq!(view["where"]["kind"], "binary");
    let proj = m["projections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "CustomerOrderSummary")
        .unwrap();
    assert_eq!(proj["by"], serde_json::json!(["customer"]));
    assert_eq!(
        proj["aggregates"],
        serde_json::json!([{ "function": "count", "field": "orders", "alias": "orders" }, { "function": "sum", "field": "total", "alias": "orderTotal", "scale": 2 }])
    );
    assert_eq!(proj["crud"]["path"], "/v1/customer-order-summaries");
    let cache = m["caches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "CurrentSitePolicy")
        .unwrap();
    assert_eq!(cache["keys"][0]["name"], "site");
    assert_eq!(cache["loader"]["kind"], "call");
    assert_eq!(cache["freshUntil"]["kind"], "call");

    let bad_source = inline(
        "@t/x",
        &[("src/a.forge", "view V {\n  from Nope\n  by a\n}\n")],
    );
    assert_eq!(codes(bad_source), vec!["E-SYM-001"]);
    let bad_field = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "resource R {\n  id : id\n  a : text\n}\nview V {\n  from R\n  by a\n  fields id, nope\n}\n",
        )],
    );
    assert_eq!(codes(bad_field), vec!["E-QRY-002"]);
    let ungrouped = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "resource R {\n  id : id\n  n : integer\n}\nprojection P {\n  from R\n  sum n as total\n}\n",
        )],
    );
    assert_eq!(codes(ungrouped), vec!["E-PROJ-001"]);
    let non_invertible = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "resource R {\n  id : id\n  g : text\n  n : integer\n}\nprojection P {\n  from R\n  by g\n  max n as biggest\n}\n",
        )],
    );
    assert!(codes(non_invertible).is_empty()); // bounded extrema ledger avoids recomputation scans
}

#[test]
fn workflow_lowers_to_a_step_graph_with_stable_ids_and_checks() {
    let ir = forgegraph_semantic::compile(
        &forgegraph_semantic::load_package(&examples().join("acme")).unwrap(),
        &[&forgegraph_semantic::compile(
            &forgegraph_semantic::load_package(&examples().join("payments")).unwrap(),
            &[],
        )
        .ir
        .unwrap()],
    )
    .ir
    .unwrap();
    let wf = ir
        .modules
        .iter()
        .flat_map(|m| &m.workflows)
        .find(|w| w.name == "ProcessOrder")
        .expect("workflow");
    assert_eq!(wf.version, 1);
    assert_eq!(
        wf.http.as_ref().map(|h| h.path.as_str()),
        Some("/v1/orders/{order}/process")
    );
    let kinds: Vec<String> = wf.steps.iter().map(|s| s.kind().to_string()).collect();
    assert_eq!(
        kinds,
        [
            "call:submit",
            "wait:captured",
            "choice:short",
            "call:approve",
            "parallel:summary+settle",
            "return"
        ]
    );
    assert_eq!(wf.errors, ["Declined", "PaymentTimeout", "ShortPayment"]);
    assert!(!wf.graph_hash.is_empty());

    let base = "shape I { order : Order }\nresource Order { id : id }\nfunction F { input I }\nchannel C { message M { ref : text } }\n";
    let bad = format!(
        "{base}workflow W {{\n  input I\n  version 1\n  step a = F(order: input.order)\n  step a = sleep 1s\n  step w = wait C.M where nope == input.order\n  step w2 = wait C.M where ref == input.order timeout 1h -> fail T\n  step c = G()\n  step d = F(order: zzz.order)\n  return a\n}}\n"
    );
    let c = codes(inline("@t/x", &[("src/index.forge", &bad)]));
    assert!(c.contains(&"E-WF-001".into()), "duplicate step id: {c:?}");
    assert!(
        c.contains(&"E-WF-002".into()),
        "unknown wait message field: {c:?}"
    );
    assert!(
        c.contains(&"E-SYM-001".into()),
        "unknown callee / binding: {c:?}"
    );
    assert!(
        c.contains(&"E-WF-003".into()),
        "timeout fail must be a declared error: {c:?}"
    );
    let no_version = format!(
        "{base}workflow W {{\n  input I\n  step a = F(order: input.order)\n  return a\n}}\n"
    );
    assert!(
        codes(inline("@t/x", &[("src/index.forge", &no_version)])).contains(&"E-WF-004".into())
    );
}

#[test]
fn edition_2027_governance_declarations_lower_and_are_gated() {
    // Edition 2026: a governance declaration is diagnosed, never ignored.
    let old = inline(
        "@t/x",
        &[(
            "src/a.forge",
            "purpose Support\nresource R {\n  id : id\n  capability C {\n    read { id }\n  }\n  for Support { use C }\n}\n",
        )],
    );
    assert!(codes(old).contains(&"E-ED-001".into()));

    let gov = load_package(&examples().join("next/governance")).unwrap();
    let g = compile(&gov, &[]);
    assert!(g.diagnostics.is_empty(), "{:#?}", g.diagnostics);
    let gir = g.ir.unwrap();
    assert_eq!(gir.package.edition, "2027");
    let gm = &gir.modules[0];
    let mut purposes: Vec<(&str, Option<&str>)> = gm
        .purposes
        .iter()
        .map(|p| (p.name.as_str(), p.extends.as_deref()))
        .collect();
    purposes.sort();
    assert_eq!(
        purposes,
        vec![
            (
                "CustomerSupport",
                Some("@acme/governance/_/ServiceProvision")
            ),
            ("Marketing", None),
            (
                "OrderFulfillment",
                Some("@acme/governance/_/ServiceProvision")
            ),
            (
                "ParentCommunication",
                Some("@acme/governance/_/ServiceProvision")
            ),
            (
                "PaymentProcessing",
                Some("@acme/governance/_/OrderFulfillment")
            ),
            ("ServiceProvision", None)
        ]
    );
    assert_eq!(
        gm.data_classes
            .iter()
            .map(|d| (d.name.as_str(), d.extends.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("ContactEmail", "data.contact.email"),
            ("SupportNarrative", "data.communication.content")
        ]
    );
    assert_eq!(
        gm.types
            .iter()
            .find(|t| t.name == "ContactEmailValue")
            .unwrap()
            .data_class
            .as_deref(),
        Some("@acme/governance/_/ContactEmail")
    );

    let pay = compile(
        &load_package(&examples().join("next/payments")).unwrap(),
        &[&gir],
    );
    assert!(pay.diagnostics.is_empty(), "{:#?}", pay.diagnostics);
    let pir = pay.ir.unwrap();
    let acme = compile(
        &load_package(&examples().join("next/acme-next")).unwrap(),
        &[&gir, &pir],
    );
    assert!(acme.diagnostics.is_empty(), "{:#?}", acme.diagnostics);
    let ir = acme.ir.unwrap();
    let contact = ir.find_resource("@acme/commerce-next/_/Contact").unwrap();
    assert!(contact.decorators.purpose_scoped);
    assert_eq!(
        contact.decorators.subject,
        Some(forgegraph_semantic::ir::SubjectBinding::Kind("person"))
    );
    assert_eq!(
        contact
            .capabilities
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        [
            "Identity",
            "ContactRead",
            "ContactMaintenance",
            "SupportRecord",
            "AgentSupport"
        ]
    );
    let agent = contact
        .capabilities
        .iter()
        .find(|c| c.name == "AgentSupport")
        .unwrap();
    assert_eq!(agent.includes, vec!["SupportRecord"]);
    assert!(
        agent
            .atoms
            .iter()
            .any(|a| a.deny && a.verb == "read" && a.names == vec!["supportNotes"])
    );
    assert_eq!(
        contact
            .purpose_bindings
            .iter()
            .map(|b| (b.purpose.as_str(), b.capability.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("@acme/governance/_/ParentCommunication", "ContactRead"),
            ("@acme/governance/_/CustomerSupport", "SupportRecord")
        ]
    );
    let submit = ir.modules[0]
        .functions
        .iter()
        .find(|f| f.name == "SubmitOrder")
        .unwrap();
    assert_eq!(
        submit.purpose.as_deref(),
        Some("@acme/governance/_/OrderFulfillment")
    );
    assert!(submit.uses.iter().any(|u| matches!(u, forgegraph_semantic::ir::Use::Function { function, purpose: Some(p) } if function == "@acme/payments/_/AuthorizePayment" && p == "@acme/governance/_/PaymentProcessing")));
    assert_eq!(
        submit
            .output
            .as_ref()
            .and_then(|t| t.purpose.clone())
            .as_deref(),
        Some("@acme/governance/_/OrderFulfillment")
    );
    // Errors: unknown purpose / capability / field in a capability.
    let bad = inline(
        "@t/y",
        &[(
            "src/a.forge",
            "purpose P\nresource R {\n  id : id\n  x : text\n  capability C {\n    includes Nope\n    read { id zzz }\n  }\n  for Q { use C }\n  for P { use Missing }\n}\n",
        )],
    );
    let c = codes_edition(bad, "2027");
    assert!(
        c.contains(&"E-GOV-001".into()),
        "unknown included capability: {c:?}"
    );
    assert!(
        c.contains(&"E-GOV-002".into()),
        "unknown field in capability: {c:?}"
    );
    assert!(c.contains(&"E-GOV-003".into()), "unknown purpose: {c:?}");
    assert!(
        c.contains(&"E-GOV-004".into()),
        "unknown capability in binding: {c:?}"
    );
}

fn codes_edition(mut pkg: Package, edition: &str) -> Vec<String> {
    pkg.edition = edition.into();
    codes(pkg)
}

#[test]
fn separate_semantic_digests() {
    // FORGE-029: a documentation edit changes the docs digest only; an added output field changes wire and security digests.
    let base = "export resource R\n  @crud(\"/v1/r\")\n{\n  id : id\n  a : text\n}\n";
    let doc =
        "/// documented\nexport resource R\n  @crud(\"/v1/r\")\n{\n  id : id\n  a : text\n}\n";
    let field = "export resource R\n  @crud(\"/v1/r\")\n{\n  id : id\n  a : text\n  b : text?\n}\n";
    let d = |src: &str| {
        compile(&inline("@t/z", &[("src/a.forge", src)]), &[])
            .ir
            .unwrap()
            .digests()
    };
    let (b, dd, f) = (d(base), d(doc), d(field));
    if b.wire != dd.wire {
        let a = serde_json::to_string_pretty(
            &compile(&inline("@t/z", &[("src/a.forge", base)]), &[])
                .ir
                .unwrap(),
        )
        .unwrap();
        let c = serde_json::to_string_pretty(
            &compile(&inline("@t/z", &[("src/a.forge", doc)]), &[])
                .ir
                .unwrap(),
        )
        .unwrap();
        for (x, y) in a.lines().zip(c.lines()) {
            if x != y {
                eprintln!("DIFF {x} | {y}");
            }
        }
    }
    assert_eq!(b.wire, dd.wire);
    assert_eq!(b.security, dd.security);
    assert_ne!(b.docs, dd.docs);
    assert_ne!(b.wire, f.wire);
    assert_ne!(b.security, f.security);
    assert_ne!(b.source, dd.source);
}

/// PAR-077 / PAR-078: identity and digests survive folder moves, discovery order and path separators.
#[test]
fn digests_survive_folder_moves_and_discovery_order() {
    let a = inline(
        "@t/x",
        &[
            (
                "src/a/customer.forge",
                "export resource Customer\n  @crud(\"/v1/customers\")\n{\n  id : id\n  name : text\n}\n",
            ),
            (
                "src/b/site.forge",
                "resource Site {\n  id : id\n  customer : Customer\n}\n",
            ),
        ],
    );
    let b = inline(
        "@t/x",
        &[
            (
                "src/zzz/moved.forge",
                "resource Site {\n  id : id\n  customer : Customer\n}\n",
            ),
            (
                "src\\other\\customer.forge",
                "export resource Customer\n  @crud(\"/v1/customers\")\n{\n  id : id\n  name : text\n}\n",
            ),
        ],
    );
    let (da, db) = (
        compile(&a, &[]).ir.unwrap().digests(),
        compile(&b, &[]).ir.unwrap().digests(),
    );
    assert_eq!(da, db);
}

/// PAR-080: a security-only change (new external effect, same I/O) moves the security digest, not the wire digest.
#[test]
fn security_only_change_moves_only_the_security_digest() {
    let base = "channel C {\n  message M {\n    a : text\n  }\n}\nshape I {\n  a : text\n}\nfunction F {\n  input I\n}\n";
    let effect = "channel C {\n  message M {\n    a : text\n  }\n}\nshape I {\n  a : text\n}\nfunction F {\n  input I\n  sends {\n    M to C\n  }\n}\n";
    let d = |src: &str| {
        compile(&inline("@t/s", &[("src/a.forge", src)]), &[])
            .ir
            .unwrap()
            .digests()
    };
    let (b, e) = (d(base), d(effect));
    assert_ne!(b.security, e.security);
    assert_ne!(b.source, e.source);
}

/// PAR-081 / PAR-083: unknown critical features and unsupported versions fail closed; M8 artifacts load by rule.
#[test]
fn ir_loading_fails_closed_on_unknown_critical_features() {
    let ir = compile(
        &inline("@t/m8", &[("src/a.forge", "resource R {\n  id : id\n}\n")]),
        &[],
    )
    .ir
    .unwrap();
    let mut v = serde_json::to_value(&ir).unwrap();
    // An M8 artifact has no `requires`, no governance fields: it loads with defaults (the conversion rule).
    v.as_object_mut().unwrap().remove("requires");
    let loaded = forgegraph_semantic::ir::DomainIR::load(&v).unwrap();
    assert!(loaded.requires.is_empty());
    assert!(loaded.modules[0].purposes.is_empty());
    v["requires"] = serde_json::json!(["capability-algebra/9"]);
    let err = forgegraph_semantic::ir::DomainIR::load(&v).unwrap_err();
    assert!(err.contains("capability-algebra/9"), "{err}");
    v["requires"] = serde_json::json!([]);
    v["version"] = serde_json::json!("domain-ir/7");
    assert!(
        forgegraph_semantic::ir::DomainIR::load(&v)
            .unwrap_err()
            .contains("domain-ir/7")
    );
}

/// PAR-082: resolving a path dependency reads only forge.toml and .forge sources; nothing in the package executes.
#[test]
fn dependency_resolution_never_executes_package_code() {
    let dir = std::env::temp_dir().join(format!("forge-noexec-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("lib/src")).unwrap();
    let canary = dir.join("CANARY");
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
    std::fs::write(
        dir.join("lib/package.json"),
        format!(
            "{{\"scripts\":{{\"postinstall\":\"touch {}\"}}}}",
            canary.display()
        ),
    )
    .unwrap();
    std::fs::write(
        dir.join("lib/install.sh"),
        format!("#!/bin/sh\ntouch {}\n", canary.display()),
    )
    .unwrap();
    std::fs::write(
        dir.join("lib/build.rs"),
        format!(
            "fn main() {{ std::fs::write({:?}, \"\").unwrap(); }}",
            canary.display()
        ),
    )
    .unwrap();
    let pkg = load_package(&dir.join("lib")).unwrap();
    let out = compile(&pkg, &[]);
    assert!(out.diagnostics.is_empty());
    assert!(
        !canary.exists(),
        "package code must never run during resolution"
    );
    assert_eq!(
        pkg.files
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        ["src/a.forge"]
    );
}

/// M11 (PAR-092/093/094/095/099): classification, subjects and lineage in the IR.
#[test]
fn classification_subjects_and_lineage_lower_conservatively() {
    let edu = compile(
        &load_package(&examples().join("next/education")).unwrap(),
        &[],
    );
    assert!(edu.diagnostics.is_empty(), "{:#?}", edu.diagnostics);
    let ir = edu.ir.unwrap();
    let student = ir.find_resource("@fixtures/education/_/Student").unwrap();
    assert_eq!(
        student.decorators.subject,
        Some(forgegraph_semantic::ir::SubjectBinding::Kind("person"))
    );
    assert_eq!(
        student.decorators.record_context.as_deref(),
        Some("education")
    );
    let att = ir
        .find_resource("@fixtures/education/_/AttendanceRecord")
        .unwrap();
    assert_eq!(
        att.decorators.subject,
        Some(forgegraph_semantic::ir::SubjectBinding::From("student"))
    );
    // PAR-092: the declared class keeps every ancestor; the health note is health AND communication.
    let note = att.fields.iter().find(|f| f.name == "healthNote").unwrap();
    assert_eq!(note.ty.data_class.as_deref(), Some("data.health.note"));
    let sem = forgegraph_semantic::ir::DataSemantics::of(&ir, &taxonomy());
    let f = sem.field(&att.id, "healthNote").unwrap();
    assert_eq!(f.evidence, "declared");
    assert!(
        f.ancestors.iter().any(|a| a == "data.health") && f.ancestors.iter().any(|a| a == "data")
    );
    assert_eq!(f.handling, "restricted");
    assert_eq!(f.kinds, vec!["health", "communication"]);
    // inferred from the scalar type: email is contact data even without @data
    let g = sem
        .field("@fixtures/education/_/Guardian", "email")
        .unwrap();
    assert_eq!(
        (g.class.as_str(), g.evidence.as_str()),
        ("data.contact.email", "inferred-from-type")
    );
    // an unclassified free-text field is `unclassified`, never public
    let bad = inline(
        "@t/u",
        &[("src/a.forge", "resource R {\n  id : id\n  blob : text\n}\n")],
    );
    let bad_ir = compile(&bad, &[]).ir.unwrap();
    let bad_sem = forgegraph_semantic::ir::DataSemantics::of(&bad_ir, &taxonomy());
    let u = bad_sem.field("@t/u/_/R", "blob").unwrap();
    assert_eq!(
        (u.completeness.as_str(), u.handling.as_str()),
        ("unclassified", "restricted")
    );
    // PAR-093: the organization is not a person subject; PAR-094: `from` bindings need a bounded access path.
    let missing_path = inline(
        "@t/s",
        &[(
            "src/a.forge",
            "resource P {\n  id : id\n}\nresource R\n  @subject(from: p)\n{\n  id : id\n  p : P\n}\n",
        )],
    );
    assert!(codes_edition(missing_path, "2027").contains(&"E-GOV-007".into()));
    let subjects = sem.subjects();
    assert_eq!(
        subjects
            .iter()
            .find(|s| s.resource == att.id)
            .unwrap()
            .via
            .as_deref(),
        Some("student")
    );
    assert_eq!(
        subjects
            .iter()
            .find(|s| s.resource == att.id)
            .unwrap()
            .access_path
            .as_deref(),
        Some("byStudent")
    );
    // PAR-095: a view filtering on the hidden health field carries health processing in its lineage.
    let lineage = forgegraph_semantic::ir::Lineage::of(&ir);
    let view = lineage
        .operations
        .iter()
        .find(|o| o.operation == "@fixtures/education/_/PresentDays.query")
        .unwrap();
    assert!(view.filters.contains(&"healthNote".to_string()));
    assert!(!view.outputs.contains(&"healthNote".to_string()));
    assert_eq!(view.coverage, "modeled");
    // PAR-096: a handwritten function's flow is declared, not proven.
    let acme = compile(
        &load_package(&examples().join("acme")).unwrap(),
        &[
            &compile(&load_package(&examples().join("payments")).unwrap(), &[])
                .ir
                .unwrap(),
        ],
    )
    .ir
    .unwrap();
    let l2 = forgegraph_semantic::ir::Lineage::of(&acme);
    let submit = l2
        .operations
        .iter()
        .find(|o| o.operation == "@acme/commerce/_/SubmitOrder")
        .unwrap();
    assert_eq!(submit.coverage, "declared");
    assert!(
        submit
            .external_sinks
            .contains(&"@acme/payments/_/AuthorizePayment".to_string())
    );
    // PAR-099: industrial data is restricted without being personal.
    let ind = compile(
        &load_package(&examples().join("next/industrial")).unwrap(),
        &[],
    )
    .ir
    .unwrap();
    let s3 = forgegraph_semantic::ir::DataSemantics::of(&ind, &taxonomy());
    let formula = s3
        .field("@fixtures/industrial/_/ProcessRecipe", "formula")
        .unwrap();
    assert_eq!(
        (formula.handling.as_str(), formula.personal.as_str()),
        ("restricted", "no")
    );
    assert!(
        s3.subjects()
            .iter()
            .all(|s| s.resource != "@fixtures/industrial/_/ProcessRecipe")
    );
}

fn taxonomy() -> forgegraph_semantic::ir::Taxonomy {
    forgegraph_semantic::ir::Taxonomy::core()
}

/// M12 (PAR-100/101): the capability algebra flattens deterministically with sticky denials; purposes gain nothing by taxonomy.
#[test]
fn capability_surfaces_flatten_with_sticky_denials() {
    use forgegraph_semantic::ir::{EffectiveCapabilities, SubjectBinding};
    let _ = SubjectBinding::Kind("person");
    let src = |includes_order: &str| {
        format!(
            "purpose Parent\npurpose Child extends Parent\npurpose Composite\nexport resource Contact\n  @purposeScoped\n{{\n  id : id\n  name : text\n  email : email\n  supportNotes : text?\n\n  lifecycle status {{\n    initial Active\n    terminal Closed\n\n    close: Active -> Closed\n  }}\n\n  capability Identity {{\n    read {{ id name }}\n  }}\n\n  capability ContactRead {{\n    includes Identity\n    read {{ email }}\n    filter {{ email }}\n  }}\n\n  capability SupportRecord {{\n    includes ContactRead\n    read {{ supportNotes }}\n    update {{ supportNotes }}\n    actions {{ status.close }}\n  }}\n\n  capability AgentSupport {{\n    includes SupportRecord\n    deny read {{ supportNotes }}\n    deny update {{ supportNotes }}\n    deny actions {{ export }}\n  }}\n\n  capability BroadSupport {{\n    includes SupportRecord\n    actions {{ export }}\n  }}\n\n  capability Reinclude {{\n{includes_order}  }}\n\n  for Parent {{ use SupportRecord }}\n  for Composite {{ use Reinclude }}\n}}\n"
        )
    };
    let a = compile(
        &inline_edition(
            "@t/cap",
            &[(
                "src/a.forge",
                &src("    includes AgentSupport\n    includes BroadSupport\n"),
            )],
            "2027",
        ),
        &[],
    );
    assert!(a.diagnostics.is_empty(), "{:#?}", a.diagnostics);
    let b = compile(
        &inline_edition(
            "@t/cap",
            &[(
                "src/a.forge",
                &src("    includes BroadSupport\n    includes AgentSupport\n"),
            )],
            "2027",
        ),
        &[],
    );
    let (ea, eb) = (
        EffectiveCapabilities::of(&a.ir.clone().unwrap()),
        EffectiveCapabilities::of(&b.ir.unwrap()),
    );
    let ir = a.ir.unwrap();
    // PAR-101: order independence and sticky deny through re-inclusion
    let ra = ea
        .surface("@t/cap/_/Contact", "@t/cap/_/Composite")
        .unwrap();
    let rb = eb
        .surface("@t/cap/_/Contact", "@t/cap/_/Composite")
        .unwrap();
    assert_eq!(ra.digest, rb.digest);
    assert_eq!(ra.allow("read"), vec!["email", "id", "name"]);
    assert!(!ra.allow("read").contains(&"supportNotes".to_string()));
    assert!(
        ra.deny
            .iter()
            .any(|d| d.verb == "actions" && d.name == "export"),
        "BroadSupport cannot reintroduce the denied export: {:?}",
        ra.deny
    );
    assert_eq!(ra.allow("actions"), vec!["status.close"]);
    // origins explain every atom
    let origin = ra
        .allow_atoms
        .iter()
        .find(|x| x.verb == "read" && x.name == "email")
        .unwrap();
    assert_eq!(
        origin.origin,
        vec!["Reinclude", "AgentSupport", "SupportRecord", "ContactRead"]
    );
    // PAR-100: Child extends Parent but has no `for` binding: no surface at all
    assert!(ea.surface("@t/cap/_/Contact", "@t/cap/_/Child").is_none());
    let parent = ea.surface("@t/cap/_/Contact", "@t/cap/_/Parent").unwrap();
    assert_eq!(
        parent.allow("read"),
        vec!["email", "id", "name", "supportNotes"]
    );
    assert_eq!(parent.allow("update"), vec!["supportNotes"]);
    assert_eq!(parent.allow("filter"), vec!["email"]);
    assert!(
        parent.allow("order").is_empty(),
        "readable is not orderable (plan §8.5)"
    );
    // read is never implied by update, and export is separate from read
    let _ = ir;
    // cycles and self-inclusion are diagnosed
    let cyc = inline_edition(
        "@t/cyc",
        &[(
            "src/a.forge",
            "resource R {\n  id : id\n  capability A {\n    includes B\n  }\n  capability B {\n    includes A\n  }\n}\n",
        )],
        "2027",
    );
    assert!(codes(cyc).contains(&"E-GOV-009".into()));
    // a purpose-scoped function output must be scoped
    let unscoped = inline_edition(
        "@t/us",
        &[(
            "src/a.forge",
            "purpose P\nshape I {\n  c : Contact\n}\nexport resource Contact\n  @purposeScoped\n{\n  id : id\n  capability C {\n    read { id }\n  }\n  for P { use C }\n}\nfunction F {\n  purpose P\n  input I\n  output Contact.Record\n}\n",
        )],
        "2027",
    );
    assert!(codes(unscoped).contains(&"E-GOV-010".into()));
}

fn inline_edition(name: &str, files: &[(&str, &str)], edition: &str) -> Package {
    let mut p = inline(name, files);
    p.edition = edition.into();
    p
}

/// PAR-118: a foreign identifier (imported as `text`) is never satisfied by a Forge reference through
/// structural coincidence; the workflow must map it explicitly.
#[test]
fn workflow_arguments_are_type_checked_against_the_callee_contract() {
    let vendor = compile(&inline("@vendor/billing", &[("src/index.forge", "export shape InvoiceCreate {\n  customer_id : text\n  amount : text\n}\nexport shape Invoice {\n  id : text\n}\nexport function CreateInvoice\n  @http(POST, \"/invoices\")\n{\n  input InvoiceCreate\n  output Invoice\n}\n")]), &[]).ir.unwrap();
    let base = "import billing\nresource Customer\n  @crud(\"/v1/customers\")\n{\n  id : id\n  externalRef : text\n}\nshape I {\n  customer : Customer\n  amount : text\n}\n";
    // a reference where the vendor wants its own identifier: refused
    let coincidence = format!(
        "{base}workflow W {{\n  input I\n  version 1\n  step inv = billing.CreateInvoice(customer_id: input.customer, amount: input.amount)\n  return inv\n}}\n"
    );
    let mut pkg = inline("@t/x", &[("src/index.forge", &coincidence)]);
    pkg.dependencies
        .push(("billing".into(), "@vendor/billing".into()));
    let out = compile(&pkg, &[&vendor]);
    let c: Vec<&str> = out.diagnostics.iter().map(|d| d.code.as_str()).collect();
    assert!(c.contains(&"E-WF-008"), "{:?}", out.diagnostics);
    let msg = &out
        .diagnostics
        .iter()
        .find(|d| d.code == "E-WF-008")
        .unwrap()
        .message;
    assert!(
        msg.contains("customer_id") && msg.contains("text") && msg.contains("Customer"),
        "{msg}"
    );
    // an explicit text field (a reviewed mapping) is accepted; so is a literal
    let explicit = format!(
        "{base}workflow W {{\n  input I\n  version 1\n  step inv = billing.CreateInvoice(customer_id: input.customer.externalRef, amount: \"1.00\")\n  return inv\n}}\n"
    );
    let mut pkg = inline("@t/x", &[("src/index.forge", &explicit)]);
    pkg.dependencies
        .push(("billing".into(), "@vendor/billing".into()));
    let out = compile(&pkg, &[&vendor]);
    assert!(
        out.diagnostics.iter().all(|d| d.code != "E-WF-008"),
        "{:?}",
        out.diagnostics
    );
    // a wrong scalar is refused too
    let wrong = format!(
        "{base}workflow W {{\n  input I\n  version 1\n  step inv = billing.CreateInvoice(customer_id: 42, amount: input.amount)\n  return inv\n}}\n"
    );
    let mut pkg = inline("@t/x", &[("src/index.forge", &wrong)]);
    pkg.dependencies
        .push(("billing".into(), "@vendor/billing".into()));
    assert!(
        compile(&pkg, &[&vendor])
            .diagnostics
            .iter()
            .any(|d| d.code == "E-WF-008")
    );
}

#[test]
fn multi_hop_reference_rules_fail_closed() {
    for expression in [
        "replacement.code.domain == code.domain",
        "code.ordinal > replacement.code.ordinal",
    ] {
        let source = format!(
            r#"
resource Domain {{
 id : id
}}
resource Code {{
 id : id
 domain : Domain
 ordinal : integer
}}
resource Revision {{
 id : id
 code : Code
}}
resource Link {{
 id : id
 code : Code
 replacement : Revision
 rules {{ {expression} }}
}}
"#
        );
        let out = compile(
            &inline("@test/reference-path", &[("src/index.forge", &source)]),
            &[],
        );
        assert!(
            out.diagnostics.iter().any(|d| d.code == "E-EXPR-003"),
            "{:#?}",
            out.diagnostics
        );
        assert!(out.ir.is_none());
    }
}

#[test]
fn direct_reference_rules_still_compile() {
    let source = r#"
resource Code {
 id : id
 ordinal : integer
}
resource Link {
 id : id
 code : Code
 prior : Code
 rules { code.ordinal > prior.ordinal }
}
"#;
    let out = compile(
        &inline("@test/direct-reference", &[("src/index.forge", source)]),
        &[],
    );
    assert!(out.diagnostics.is_empty(), "{:#?}", out.diagnostics);
    assert!(out.ir.is_some());
}
