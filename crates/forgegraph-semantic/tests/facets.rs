use forgegraph_semantic::{Package, compile};
fn package(source: &str) -> Package {
    let mut p = Package::inline(
        "@test/facets",
        vec![("src/model.forge".into(), source.into())],
    );
    p.edition = "2027".into();
    p
}
fn model(source: &str) -> forgegraph_semantic::DomainIR {
    let c = compile(&package(source), &[]);
    assert!(c.ir.is_some(), "{}", c.render());
    c.ir.unwrap()
}
#[test]
fn expands_fields_defaults_refinements_governance_and_origins() {
    let ir = model(
        "dataClass Note extends data.communication.content\nfacet Spatial {\n x : integer >= 0 = 0\n note : text? @data(Note)\n}\nresource Entity @versioned @facet(Spatial) {\n id : id\n doubled := x + x\n list by x\n}\n",
    );
    let r = &ir.modules[0].resources[0];
    let x = r.fields.iter().find(|f| f.name == "x").unwrap();
    assert!(x.default.is_some());
    assert!(!x.ty.constraints.is_empty());
    assert!(
        r.fields
            .iter()
            .find(|f| f.name == "note")
            .unwrap()
            .ty
            .data_class
            .is_some()
    );
    assert_eq!(
        ir.modules[0].facet_origins["@test/facets/_/Entity#field:x"],
        "@test/facets/_/Spatial#field:x"
    );
    assert!(r.fields.iter().any(|f| f.name == "doubled"));
}
#[test]
fn repeated_and_compact_applications_have_identical_ir() {
    let base = "facet A { a : text? }\nfacet B { b : boolean = true }\n";
    let a = model(&format!("{base}resource R @facet(A, B) {{ id : id }}"));
    let b = model(&format!(
        "{base}resource R @facet(B) @facet(A) {{ id : id }}"
    ));
    assert_eq!(a, b);
    let mut moved = package(&format!("{base}resource R @facet(A, B) {{ id : id }}"));
    moved.files[0].path = "renamed/other.forge".into();
    assert_eq!(a, compile(&moved, &[]).ir.unwrap());
}
#[test]
fn rejects_collisions_invalid_templates_and_using_facets_as_types() {
    for source in [
        "facet A { x : text }\nresource R @facet(A) {\n id : id\n x : text\n}",
        "facet A { x : text }\nfacet B { x : text }\nresource R @facet(A,B) { id : id }",
        "facet A { x : text }\nresource R @facet(A,A) { id : id }",
        "facet A { x : text @unique }",
        "facet A { id : id }",
        "facet A { x := 1 }",
        "facet A { version : integer }\nresource R @versioned @facet(A) { id : id }",
        "facet A { x : text }\nresource R {\n id : id\n a : A\n}",
        "resource R @facet(Missing) { id : id }",
        "resource R @facet() { id : id }",
        "facet A { lifecycle status { initial Open } }",
    ] {
        let c = compile(&package(source), &[]);
        assert!(c.ir.is_none(), "unexpected success: {source}");
    }
}
#[test]
fn imported_templates_require_visibility_and_preserve_resolved_types() {
    let mut dependency = package(
        "export enum Kind { One }\nexport facet Audit { kind : Kind = Kind.One }\nfacet Private { hidden : text }",
    );
    dependency.name = "@test/common".into();
    let dep = compile(&dependency, &[]).ir.unwrap();
    let mut consumer = package("import common\nresource Event @facet(common.Audit) { id : id }");
    consumer
        .dependencies
        .push(("common".into(), "@test/common".into()));
    let out = compile(&consumer, &[&dep]);
    assert!(out.ir.is_some(), "{}", out.render());
    let ir = out.ir.unwrap();
    assert_eq!(
        ir.modules[0].facet_origins["@test/facets/_/Event#field:kind"],
        "@test/common/_/Audit#field:kind"
    );
    consumer.files[0].text = consumer.files[0]
        .text
        .replace("common.Audit", "common.Private");
    assert!(compile(&consumer, &[&dep]).ir.is_none());
}
#[test]
fn facet_formatting_is_idempotent_and_keeps_comments() {
    let source = "/// Spatial\nfacet Spatial{x:integer}\nresource R @facet(Spatial){id:id}\n";
    let once = forgegraph_syntax::format(&forgegraph_syntax::parse(source));
    assert!(once.contains("/// Spatial"));
    assert_eq!(
        once,
        forgegraph_syntax::format(&forgegraph_syntax::parse(&once))
    );
    assert!(forgegraph_syntax::parse(&once).errors().is_empty());
}
#[test]
fn source_index_links_applications_and_effective_field_references_to_origins() {
    let mut pkg = package("resource R @facet(Spatial) {\n id : id\n doubled := x + x\n}\n");
    pkg.files.push(forgegraph_semantic::SourceFile {
        path: "src/facet.forge".into(),
        text: "facet Spatial { x : integer }".into(),
    });
    let out = compile(&pkg, &[]);
    assert!(out.ir.is_some(), "{}", out.render());
    assert_eq!(
        out.source_index["@test/facets/_/R#field:x"].file,
        "src/facet.forge"
    );
    assert!(
        out.references
            .iter()
            .any(|r| r.target == "@test/facets/_/Spatial#field:x")
    );
    assert!(
        out.references
            .iter()
            .any(|r| r.target == "@test/facets/_/Spatial")
    );
}
#[test]
fn compatibility_findings_explain_affected_facet_consumers() {
    let old = serde_json::json!({"contracts":{"resources":[{"id":"@test/_/R","record":{"properties":{"x":{}}},"create":{"properties":{"x":{}},"required":[]}}]},"ir":{"modules":[{"facetOrigins":{"@test/_/R#field:x":"@test/_/Spatial#field:x"}}]}});
    let mut new = old.clone();
    new["contracts"]["resources"][0]["create"]["required"] = serde_json::json!(["x"]);
    let report = forgegraph_semantic::diff::compare(&old, &new);
    assert!(
        report
            .findings
            .iter()
            .any(|f| f.code == "field-required" && f.detail.contains("Spatial#field:x"))
    );
}
