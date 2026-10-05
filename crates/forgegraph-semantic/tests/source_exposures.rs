use forgegraph_semantic::{Package, compile};
#[test]
fn source_http_exposures_lower_routes_and_retain_provenance() {
    let p = Package::inline("@test/exposure", vec![("src/model.forge".into(), "resource Item { id : id\n name : text }\nfunction Ping {}".into()), ("src/api.forge".into(), "source Api {\n @http(\"/items\") resource Item\n @http(POST, \"/ping\") function Ping\n}".into())]);
    let c = compile(&p, &[]);
    assert!(c.ir.is_some(), "{}", c.render());
    let ir = c.ir.as_ref().unwrap();
    let r = ir.find_resource("@test/exposure/_/Item").unwrap();
    assert_eq!(
        r.operations
            .iter()
            .find(|o| o.kind == "get")
            .unwrap()
            .http
            .as_ref()
            .unwrap()
            .path,
        "/items/{id}"
    );
    assert_eq!(
        ir.modules[0].functions[0].http.as_ref().unwrap().path,
        "/ping"
    );
    let map = c.source_map("build", "test", None);
    assert_eq!(
        map["anchors"]["@test/exposure/_/Api#expose:Item"]["file"],
        "src/api.forge"
    );
    assert!(
        map["derivations"]["@test/exposure/_/Item#op:get"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["kind"] == "source-exposure")
    );
    assert!(
        c.references
            .iter()
            .any(|r| r.target == "@test/exposure/_/Item" && r.span.file == "src/api.forge")
    );
}

#[test]
fn exposure_conflicts_kinds_paths_and_schedule_mixing_fail_closed() {
    for body in [
        "@http(\"/x\") resource Ping",
        "@http(GET, \"/x\") function Item",
        "@http(\"relative\") resource Item",
        "@http(\"/x/{id}\") resource Item",
        "@http(GET, \"/x/{missing}\") function Ping",
        "@http(\"/x\") resource Item\n @http(\"/y\") resource Item",
        "@http(\"/x\") resource Item\n cron \"0 * * * *\"\n -> Ping",
        "@other(\"/x\") resource Item",
    ] {
        let p = Package::inline(
            "@test/exposure",
            vec![(
                "src/model.forge".into(),
                format!(
                    "resource Item {{ id : id }}\nfunction Ping {{}}\nsource Api {{\n {body}\n}}"
                ),
            )],
        );
        let c = compile(&p, &[]);
        assert!(c.ir.is_none(), "accepted invalid exposure: {body}");
    }
    for source in [
        "resource Item @crud(\"/old\") { id : id }\nsource Api { @http(\"/new\") resource Item }",
        "function Ping @http(POST, \"/old\") {}\nsource Api { @http(POST, \"/new\") function Ping }",
    ] {
        let c = compile(
            &Package::inline(
                "@test/exposure",
                vec![("src/model.forge".into(), source.into())],
            ),
            &[],
        );
        assert!(c.ir.is_none(), "accepted conflicting binding: {source}");
    }
}

#[test]
fn source_routes_are_l1_and_file_moves_preserve_semantic_identity() {
    use forgegraph_semantic::concept::project;
    let text = "resource Item { id : id }\nsource Api {\n @http(\"/items\")\n resource Item\n}";
    let formatted = forgegraph_syntax::format(&forgegraph_syntax::parse(text));
    assert_eq!(
        formatted,
        forgegraph_syntax::format(&forgegraph_syntax::parse(&formatted))
    );
    let compile_at = |path: &str, text: &str| {
        compile(
            &Package::inline("@test/exposure", vec![(path.into(), text.into())]),
            &[],
        )
    };
    let a = compile_at("src/a.forge", &formatted);
    assert!(a.ir.is_some(), "{}", a.render());
    let moved = compile_at("src/b.forge", &formatted);
    assert_eq!(
        a.ir.as_ref().unwrap().content_hash(),
        moved.ir.as_ref().unwrap().content_hash()
    );
    assert_ne!(
        a.source_map("build", "test", None),
        moved.source_map("build", "test", None)
    );
    let changed = compile_at("src/a.forge", &formatted.replace("/items", "/inventory"));
    assert_ne!(
        a.ir.as_ref().unwrap().content_hash(),
        changed.ir.as_ref().unwrap().content_hash()
    );
    assert_eq!(
        project(a.ir.as_ref().unwrap()).concept.content_hash(),
        project(changed.ir.as_ref().unwrap()).concept.content_hash()
    );
}
