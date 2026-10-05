use forgegraph_semantic::{Package, analysis::AnalysisCache, compile};
use std::rc::Rc;

fn package() -> Package {
    let mut package = Package::inline(
        "@test/cache",
        vec![
            (
                "src/facet.forge".into(),
                "facet Spatial { x : integer }".into(),
            ),
            (
                "src/resource.forge".into(),
                "resource R @facet(Spatial) { id : id }".into(),
            ),
            (
                "src/workflow.forge".into(),
                "workflow W { version 1\n step pause = sleep 1s }".into(),
            ),
        ],
    );
    package.edition = "2027".into();
    package
}
fn equivalent(
    cache: &mut AnalysisCache,
    package: &Package,
    deps: &[&forgegraph_semantic::DomainIR],
) {
    let cached = cache.analyze("root", package, deps);
    let clean = compile(package, deps);
    assert_eq!(cached.ir, clean.ir);
    assert_eq!(cached.diagnostics, clean.diagnostics);
    assert_eq!(cached.source_index, clean.source_index);
    assert_eq!(cached.references, clean.references);
    assert_eq!(cached.workflow_scopes, clean.workflow_scopes);
    assert_eq!(cached.workflow_fields, clean.workflow_fields);
    assert_eq!(
        cached.source_map("build", "test", None),
        clean.source_map("build", "test", None)
    );
}
#[test]
fn edits_moves_deletions_and_recovery_match_clean_compilation() {
    let mut cache = AnalysisCache::default();
    let mut package = package();
    equivalent(&mut cache, &package, &[]);
    let first = cache.analyze("root", &package, &[]);
    assert!(Rc::ptr_eq(&first, &cache.analyze("root", &package, &[])));
    assert_eq!(cache.stats().parse_misses, 3);
    package.files[0].text = "facet Spatial { x : text }".into();
    equivalent(&mut cache, &package, &[]);
    assert_eq!(cache.stats().parse_misses, 4);
    assert_eq!(cache.stats().parse_hits, 2);
    package.files[2].text = "workflow W { version 1\n step pause = sleep 2s }".into();
    equivalent(&mut cache, &package, &[]);
    package.files[1].path = "src/moved.forge".into();
    equivalent(&mut cache, &package, &[]);
    package.files[0].text = "facet Spatial { x : Missing }".into();
    equivalent(&mut cache, &package, &[]);
    package.files.remove(0);
    equivalent(&mut cache, &package, &[]);
    package = self::package();
    equivalent(&mut cache, &package, &[]);
}
#[test]
fn imported_changes_invalidate_consumers_but_not_unrelated_packages() {
    let mut cache = AnalysisCache::default();
    let mut dep = Package::inline(
        "@test/dep",
        vec![(
            "src/a.forge".into(),
            "export shape Value { x : text }".into(),
        )],
    );
    let mut consumer = Package::inline(
        "@test/consumer",
        vec![(
            "src/a.forge".into(),
            "import dep\nfunction F { input dep.Value }".into(),
        )],
    );
    consumer
        .dependencies
        .push(("dep".into(), "@test/dep".into()));
    let unrelated = package();
    let other = cache.analyze("other", &unrelated, &[]);
    let dependency = cache.analyze("dep", &dep, &[]);
    equivalent(&mut cache, &consumer, &[dependency.ir.as_ref().unwrap()]);
    dep.files[0].text = "export shape Value { x : integer }".into();
    let dependency = cache.analyze("dep", &dep, &[]);
    equivalent(&mut cache, &consumer, &[dependency.ir.as_ref().unwrap()]);
    assert!(Rc::ptr_eq(&other, &cache.analyze("other", &unrelated, &[])));
    equivalent(&mut cache, &consumer, &[]); // dependency disappeared
    assert_eq!(cache.dependencies()["root"], vec!["@test/dep"]);
}
#[test]
fn eviction_changes_only_performance() {
    let mut cache = AnalysisCache::new(1, 1);
    let package = package();
    equivalent(&mut cache, &package, &[]);
    cache.analyze("other", &package, &[]);
    equivalent(&mut cache, &package, &[]);
    assert!(cache.stats().evictions > 0);
}
#[test]
#[ignore = "manual latency benchmark: cargo test -p forgegraph-semantic --test analysis large_package_latency -- --ignored --nocapture"]
fn large_package_latency() {
    let package = Package::inline(
        "@test/large",
        (0..500)
            .map(|i| {
                (
                    format!("src/{i}.forge"),
                    format!("resource R{i} {{ id : id\n value : text }}"),
                )
            })
            .collect(),
    );
    let mut cache = AnalysisCache::default();
    let start = std::time::Instant::now();
    cache.analyze("root", &package, &[]);
    let cold = start.elapsed();
    let start = std::time::Instant::now();
    for _ in 0..20 {
        cache.analyze("root", &package, &[]);
    }
    let warm = start.elapsed() / 20;
    let mut edited = package.clone();
    edited.files[0].text = edited.files[0]
        .text
        .replace("value : text", "value : integer");
    let start = std::time::Instant::now();
    let cached = cache.analyze("root", &edited, &[]);
    let incremental = start.elapsed();
    let start = std::time::Instant::now();
    let clean = compile(&edited, &[]);
    let clean_time = start.elapsed();
    assert_eq!(cached.ir, clean.ir);
    equivalent(&mut cache, &edited, &[]);
    assert_eq!(cache.stats().declaration_hits, 499);
    assert_eq!(cache.stats().declaration_misses, 501);
    eprintln!(
        "500 files: cold={cold:?}, warm={warm:?}, one declaration edit={incremental:?}, clean={clean_time:?}; stats={:?}",
        cache.stats()
    );
}

#[test]
fn editor_source_map_reuses_only_the_exact_cached_compilation() {
    let mut cache = AnalysisCache::default();
    let mut package = package();
    let before = cache.analyze("root", &package, &[]);
    let first = cache.editor_source_map("root", &before);
    assert!(Rc::ptr_eq(
        &first,
        &cache.editor_source_map("root", &before)
    ));
    package.files[1].path = "src/moved.forge".into();
    let after = cache.analyze("root", &package, &[]);
    let second = cache.editor_source_map("root", &after);
    assert!(!Rc::ptr_eq(&first, &second));
    assert_ne!(first["sources"], second["sources"]);
    assert_eq!(
        *second,
        after.source_map("editor", env!("CARGO_PKG_VERSION"), None)
    );
    assert_eq!(*first, *cache.editor_source_map("root", &before));
    cache.clear();
    assert_eq!(*second, *cache.editor_source_map("root", &after));
    assert_eq!(
        after.source_map("new-build", "new-compiler", Some("revision"))["revision"],
        "revision"
    );
    assert!(
        cache
            .editor_source_map("root", &after)
            .get("revision")
            .is_none()
    );
}

#[test]
fn declaration_invalidation_reuses_unrelated_lowering_and_tracks_transitive_edges() {
    let mut cache = AnalysisCache::default();
    let mut package = package();
    package
        .files
        .push(forgegraph_semantic::package::SourceFile {
            path: "src/unrelated.forge".into(),
            text: "resource Unrelated { id : id\n name : text }".into(),
        });
    equivalent(&mut cache, &package, &[]);
    let before = serde_json::to_value(cache.stats()).unwrap();
    package.files[0].text = "facet Spatial { x : text }".into();
    equivalent(&mut cache, &package, &[]);
    let after = serde_json::to_value(cache.stats()).unwrap();
    assert!(
        after["declarationHits"].as_u64().unwrap_or(0)
            > before["declarationHits"].as_u64().unwrap_or(0)
    );
    assert_eq!(
        after["declarationMisses"].as_u64().unwrap()
            - before["declarationMisses"].as_u64().unwrap(),
        2
    );
    package.files[2].text = "workflow W { version 1\n step pause = sleep 2s }".into();
    let before = cache.stats();
    equivalent(&mut cache, &package, &[]);
    let after = cache.stats();
    let before = serde_json::to_value(before).unwrap();
    let after = serde_json::to_value(after).unwrap();
    assert_eq!(
        after["declarationMisses"].as_u64().unwrap()
            - before["declarationMisses"].as_u64().unwrap(),
        1
    );
}

#[test]
fn source_routes_reuse_unrelated_declarations_and_update_target() {
    let mut cache = AnalysisCache::default();
    let mut p = Package::inline(
        "@test/routes",
        vec![
            (
                "src/api.forge".into(),
                "source Api { @http(\"/items\") resource Item }".into(),
            ),
            ("src/item.forge".into(), "resource Item { id : id }".into()),
            (
                "src/other.forge".into(),
                "resource Other { id : id }".into(),
            ),
        ],
    );
    equivalent(&mut cache, &p, &[]);
    let before = cache.stats();
    p.files[0].text = p.files[0].text.replace("/items", "/things");
    equivalent(&mut cache, &p, &[]);
    assert_eq!(cache.stats().declaration_hits - before.declaration_hits, 1);
    assert_eq!(
        cache.stats().declaration_misses - before.declaration_misses,
        2
    );
    p.files[0].text = "source Api { @http(\"/things\") resource Other }".into();
    equivalent(&mut cache, &p, &[]);
    p.files.remove(0);
    equivalent(&mut cache, &p, &[]);
}

#[test]
fn transitive_types_offsets_symbols_and_recovery_match_clean() {
    let mut cache = AnalysisCache::default();
    let mut p = Package::inline(
        "@test/transitive",
        vec![
            ("src/a.forge".into(), "shape A { x : text }".into()),
            ("src/b.forge".into(), "shape B { a : A }".into()),
            ("src/c.forge".into(), "function C { input B }".into()),
            ("src/d.forge".into(), "resource D { id : id }".into()),
        ],
    );
    equivalent(&mut cache, &p, &[]);
    let before = cache.stats();
    p.files[0].text = "shape A { x : integer }".into();
    equivalent(&mut cache, &p, &[]);
    assert_eq!(cache.stats().declaration_hits - before.declaration_hits, 1);
    assert_eq!(
        cache.stats().declaration_misses - before.declaration_misses,
        3
    );
    for text in [
        "\n\nshape A { x : integer }",
        "shape A { x : Missing }",
        "shape Renamed { x : text }",
        "shape A { x : text }\nshape Extra { x : text }",
        "shape A { x : text }",
    ] {
        p.files[0].text = text.into();
        equivalent(&mut cache, &p, &[]);
    }
}

#[test]
fn shared_workflow_editor_types_survive_removing_first_use() {
    let mut cache = AnalysisCache::default();
    let mut p = Package::inline(
        "@test/shared",
        vec![
            (
                "src/type.forge".into(),
                "shape Input { value : text }".into(),
            ),
            (
                "src/a.forge".into(),
                "workflow A { version 1\n input Input\n step wait = sleep 1s }".into(),
            ),
            (
                "src/b.forge".into(),
                "workflow B { version 1\n input Input\n step wait = sleep 1s }".into(),
            ),
        ],
    );
    equivalent(&mut cache, &p, &[]);
    assert!(cache.analyze("root", &p, &[]).ir.is_some());
    p.files[1].text = "workflow A { version 1\n step wait = sleep 1s }".into();
    equivalent(&mut cache, &p, &[]);
}
