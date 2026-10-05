//! Resource expressions run in the portable runtime. The compiler must accept exactly the
//! functions the runtime evaluates, and type them as the runtime returns them (#196).
use forgegraph_semantic::{Package, compile};

fn compile_with(member: &str) -> forgegraph_semantic::Compilation {
    compile(
        &Package::inline(
            "@test/expressions",
            vec![(
                "src/a.forge".into(),
                format!("resource Window @versioned {{\n id : id\n at : datetime\n remaining : integer\n {member}\n}}"),
            )],
        ),
        &[],
    )
}

fn field_type(c: &forgegraph_semantic::Compilation, name: &str) -> serde_json::Value {
    let ir = serde_json::to_value(c.ir.as_ref().unwrap()).unwrap();
    let fields = ir["modules"][0]["resources"][0]["fields"].as_array().unwrap().clone();
    fields.into_iter().find(|f| f["name"] == name).unwrap()["type"]["base"].clone()
}

#[test]
fn floor_over_datetime_compiles_to_an_integer() {
    let c = compile_with("hour := floor(at / 3600)");
    assert!(c.ir.is_some(), "{}", c.render());
    assert_eq!(field_type(&c, "hour"), serde_json::json!({"kind": "scalar", "name": "integer", "args": []}));
    let c = compile_with("seconds := at - at");
    assert_eq!(field_type(&c, "seconds")["name"], "integer");
}

#[test]
fn functions_the_runtime_cannot_evaluate_are_rejected() {
    for member in ["hour := round(at / 3600)", "x := Math.floor(remaining)", "x := floor(remaining, 2)", "rules { ceil(remaining) > 0 }"] {
        let c = compile_with(member);
        assert!(
            c.diagnostics.iter().any(|d| d.code == "E-EXPR-004"),
            "{member}: {}",
            c.render()
        );
    }
}

/// Parity with `EXPRESSION_FUNCTIONS` in packages/runtime/src/decode.ts.
#[test]
fn compiler_and_runtime_agree_on_expression_functions() {
    let decode = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/runtime/src/decode.ts")).unwrap();
    let list = decode
        .split("export const EXPRESSION_FUNCTIONS = [")
        .nth(1)
        .and_then(|rest| rest.split(']').next())
        .expect("runtime declares EXPRESSION_FUNCTIONS");
    let names: Vec<&str> = list.split(',').map(|s| s.trim().trim_matches('"')).filter(|s| !s.is_empty()).collect();
    assert!(!names.is_empty());
    for name in names {
        let c = compile_with(&format!("x := {name}(remaining)"));
        assert!(c.ir.is_some(), "runtime evaluates `{name}` but the compiler rejects it: {}", c.render());
    }
}
