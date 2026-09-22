use forgegraph_semantic::{Package, compile};

#[test]
fn file_moves_preserve_ir_and_anchors_but_update_source_locations() {
    let source = "facet Spatial { x : integer }\nresource R @facet(Spatial) {\n id : id\n note : text?\n lifecycle status {\n initial Open\n terminal Done\n finish: Open -> Done\n input { note : text }\n }\n}\n";
    let mut package = Package::inline("@test/maps", vec![("src/a.forge".into(), source.into())]);
    package.edition = "2027".into();
    let first = compile(&package, &[]);
    assert!(first.ir.is_some(), "{}", first.render());
    let map = first.source_map("build", "test", Some("revision"));
    assert_eq!(map, first.source_map("build", "test", Some("revision")));
    let anchors = map["anchors"].as_object().unwrap();
    assert!(anchors.contains_key("@test/maps/_/R#field:note"));
    assert!(anchors.contains_key("@test/maps/_/R#lifecycle:status/transition:finish/field:note"));
    assert_eq!(
        map["derivations"]["@test/maps/_/R#field:x"][0]["from"],
        "@test/maps/_/Spatial#field:x"
    );
    assert_eq!(
        map["derivations"]["@test/maps/_/R#op:create"][0]["from"],
        "@test/maps/_/R"
    );
    package.files[0].path = "src/moved.forge".into();
    let second = compile(&package, &[]);
    assert_eq!(first.ir, second.ir);
    let moved = second.source_map("build", "test", Some("revision"));
    assert_eq!(
        map["sources"]["src/a.forge"],
        moved["sources"]["src/moved.forge"]
    );
    assert_eq!(
        map["anchors"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        moved["anchors"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>()
    );
    for span in moved["anchors"].as_object().unwrap().values() {
        assert_eq!(span["file"], "src/moved.forge");
        assert!(
            source
                .get(
                    span["start"].as_u64().unwrap() as usize
                        ..span["end"].as_u64().unwrap() as usize
                )
                .is_some()
        );
    }
}

#[test]
fn workflow_steps_have_named_anchors() {
    let package = Package::inline(
        "@test/maps",
        vec![(
            "src/a.forge".into(),
            "workflow W {\n version 1\n step pause = sleep 5s\n}\n".into(),
        )],
    );
    let compilation = compile(&package, &[]);
    assert!(compilation.ir.is_some(), "{}", compilation.render());
    let map = compilation.source_map("build", "test", None);
    assert!(
        map["anchors"]["@test/maps/_/W#step:pause"].is_object(),
        "{map:#}"
    );
}
