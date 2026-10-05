use forgegraph_semantic::{Package, compile, load_package};
use std::path::Path;
#[test]
fn queues_have_sealed_bounded_execution_configuration() {
    let c = compile(
        &load_package(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../examples/work-queues"
        )))
        .unwrap(),
        &[],
    );
    assert!(c.ir.is_some(), "{}", c.render());
    let ir = c.ir.unwrap();
    assert!(ir.requires.contains(&"work-queues/1".into()));
    let q = &ir.modules[0].work_queues[0];
    assert_eq!(q.lease_ms, 90000);
    assert_eq!(q.max_attempts, 3);
    assert_eq!(q.max_tasks, 128);
}
#[test]
fn invalid_settings_fail_closed() {
    for body in [
        "lease 90s",
        "execute F\nretry 0",
        "execute F\ncapacity 129",
        "execute F\nlease 0s",
        "execute F\nretry 3\nretry 4",
    ] {
        let c = compile(
            &Package::inline(
                "@test/queues",
                vec![(
                    "src/a.forge".into(),
                    format!("function F {{}}\nworkQueue Q {{\n{body}\n}}"),
                )],
            ),
            &[],
        );
        assert!(c.ir.is_none(), "accepted {body}");
    }
}
