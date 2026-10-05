use forgegraph_semantic::assembly::assemble;
use forgegraph_semantic::ir::{CallTarget, Step, Workflow};
use forgegraph_semantic::{DomainIR, Package, compile};

fn ir(name: &str) -> DomainIR {
    compile(
        &Package::inline(
            name,
            vec![(
                "src/main.forge".into(),
                "resource R {\n  id : id\n}\n".into(),
            )],
        ),
        &[],
    )
    .ir
    .unwrap()
}

#[test]
fn assembly_deduplicates_equal_packages_but_rejects_conflicting_versions() {
    let root = ir("@t/root");
    let lib = ir("@t/lib");
    let assembled = assemble(&root, &[lib.clone(), lib.clone()]).unwrap();
    assert_eq!(assembled.modules.len(), 2);
    assert_eq!(assembled.modules[0].id, "@t/lib/_");
    let mut changed = lib.clone();
    changed.package.version = "2.0.0".into();
    assert!(
        assemble(&root, &[lib, changed])
            .unwrap_err()
            .contains("E-ASSEMBLY-001")
    );
}

#[test]
fn deployment_profile_and_targets_must_be_supported() {
    let root = ir("@t/root");
    let mut lib = ir("@t/lib");
    lib.package.targets = vec!["cloudflare-d1".into()];
    assert!(
        assemble(&root, &[lib.clone()])
            .unwrap_err()
            .contains("targets")
    );
    lib.package.targets = root.package.targets.clone();
    lib.package.profile = "other-profile".into();
    assert!(assemble(&root, &[lib]).unwrap_err().contains("profile"));
}

#[test]
fn nested_workflow_transition_requires_owned_target() {
    let mut root = ir("@t/root");
    let lib = ir("@t/lib");
    root.modules[0].workflows.push(Workflow {
        id: "@t/root/_/W".into(),
        name: "W".into(),
        exported: false,
        doc: None,
        input: None,
        output: None,
        http: None,
        graph_hash: "test".into(),
        version: 1,
        errors: vec![],
        steps: vec![Step::Parallel {
            id: "parallel".into(),
            branches: vec![vec![Step::Call {
                id: "transition".into(),
                target: CallTarget::Transition {
                    resource: "@t/remote/_/R".into(),
                    action: "finish".into(),
                },
                args: vec![],
                catches: vec![],
            }]],
        }],
    });
    assert!(assemble(&root, &[lib]).unwrap_err().contains("workflow"));
}
