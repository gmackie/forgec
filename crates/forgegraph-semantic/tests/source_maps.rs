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

#[test]
fn actor_and_queue_clauses_have_stable_precise_anchors() {
    let source = "shape State { value : integer }\nshape Command { value : integer }\nfunction Handle { input Command\n output State\n}\nactor Session keyed by session {\n state State\n on Update -> Handle\n}\nworkQueue Jobs {\n execute Handle\n lease 30s\n retry 3\n capacity 10\n runners 2\n}\n";
    let package = Package::inline(
        "@test/maps",
        vec![("src/runtime.forge".into(), source.into())],
    );
    let compilation = compile(&package, &[]);
    assert!(compilation.ir.is_some(), "{}", compilation.render());
    let map = compilation.source_map("build", "test", None);
    for (anchor, clause) in [
        ("Session#state", "state State"),
        ("Session#handler:Update", "on Update -> Handle"),
        ("Jobs#execute", "execute Handle"),
        ("Jobs#config:lease", "lease 30s"),
        ("Jobs#config:retry", "retry 3"),
        ("Jobs#config:capacity", "capacity 10"),
        ("Jobs#config:runners", "runners 2"),
    ] {
        let span = &map["anchors"][format!("@test/maps/_/{anchor}")];
        assert!(span.is_object(), "missing {anchor}");
        let text = &source
            [span["start"].as_u64().unwrap() as usize..span["end"].as_u64().unwrap() as usize];
        assert_eq!(text.trim(), clause);
    }
    let moved = Package::inline(
        "@test/maps",
        vec![(
            "src/moved.forge".into(),
            source.replace(" state State", " // comment\n   state State"),
        )],
    );
    let moved = compile(&moved, &[]);
    assert_eq!(compilation.ir, moved.ir);
    let moved_map = moved.source_map("build", "test", None);
    assert_eq!(
        map["anchors"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        moved_map["anchors"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>()
    );
    assert_eq!(
        map["derivations"]["@test/maps/_/Session#handler:Update"][0],
        serde_json::json!({"kind":"actor-handler","from":"@test/maps/_/Handle"})
    );
    assert_eq!(
        map["derivations"]["@test/maps/_/Jobs#execute"][0],
        serde_json::json!({"kind":"queue-execute","from":"@test/maps/_/Handle"})
    );
}

#[test]
fn runtime_clause_identity_survives_retargeting_and_tracks_imported_functions() {
    let dep = Package::inline("@test/handlers", vec![("src/lib.forge".into(),
        "export shape State { value : integer }\nexport shape Command { value : integer }\nexport function First { input Command\n output State }\nexport function Second { input Command\n output State }\n".into())]);
    let dependency = compile(&dep, &[]);
    assert!(dependency.ir.is_some(), "{}", dependency.render());
    let source = "import handlers\nfunction LocalFirst { input handlers.Command\n output handlers.State }\nfunction LocalSecond { input handlers.Command\n output handlers.State }\nactor Session keyed by session {\n state handlers.State\n on Update -> LocalFirst\n}\nworkQueue Jobs {\n execute handlers.First\n lease 30s\n retry 3\n capacity 10\n runners 2\n}\n";
    let mut package = Package::inline("@test/maps", vec![("src/main.forge".into(), source.into())]);
    package
        .dependencies
        .push(("handlers".into(), "@test/handlers".into()));
    let first = compile(&package, &[dependency.ir.as_ref().unwrap()]);
    assert!(first.ir.is_some(), "{}", first.render());
    let first = first.source_map("build1", "test", None);
    package.files[0].text = source
        .replace("handlers.First", "handlers.Second")
        .replace("on Update -> LocalFirst", "on Update -> LocalSecond")
        .replace("lease 30s", "lease 60s");
    let second = compile(&package, &[dependency.ir.as_ref().unwrap()]);
    assert!(second.ir.is_some(), "{}", second.render());
    let second = second.source_map("build2", "test", None);
    assert_eq!(
        first["anchors"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        second["anchors"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>()
    );
    for (anchor, first_target, second_target) in [
        (
            "@test/maps/_/Session#handler:Update",
            "@test/maps/_/LocalFirst",
            "@test/maps/_/LocalSecond",
        ),
        (
            "@test/maps/_/Jobs#execute",
            "@test/handlers/_/First",
            "@test/handlers/_/Second",
        ),
    ] {
        assert_eq!(first["derivations"][anchor][0]["from"], first_target);
        assert_eq!(second["derivations"][anchor][0]["from"], second_target);
    }
}
