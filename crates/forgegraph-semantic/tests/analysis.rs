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
    edited.files[0].text.push_str("\n// edit");
    let start = std::time::Instant::now();
    equivalent(&mut cache, &edited, &[]);
    eprintln!(
        "500 files: cold={cold:?}, warm={warm:?}, edited plus clean verification={:?}; stats={:?}",
        start.elapsed(),
        cache.stats()
    );
}
