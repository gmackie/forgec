//! Explicit co-deployment, after each package has been compiled in its own scope.
//! Never rewrite package-qualified identities or expose transitive declarations to imports.
use crate::ir::{CallTarget, DomainIR, Step, TypeBase, Use};
use std::collections::{BTreeMap, BTreeSet};

/// Assemble the already selected transitive closure. Equal diamonds are deduplicated;
/// different contracts under one package identity are rejected, even at the same version.
/// An empty closure preserves historical contract-only import behavior.
pub fn assemble(root: &DomainIR, selected: &[DomainIR]) -> Result<DomainIR, String> {
    if selected.is_empty() {
        return Ok(root.clone());
    }
    let mut packages = BTreeMap::new();
    for ir in std::iter::once(root).chain(selected) {
        if let Some(previous) = packages.insert(&ir.package.name, ir)
            && previous != ir
        {
            return Err(format!(
                "E-ASSEMBLY-001: conflicting package identity `{}` (versions {} / {})",
                ir.package.name, previous.package.version, ir.package.version
            ));
        }
        if !ir.package.targets.is_empty()
            && root
                .package
                .targets
                .iter()
                .any(|target| !ir.package.targets.contains(target))
        {
            return Err(format!(
                "E-ASSEMBLY-002: package `{}` does not support all deployment targets",
                ir.package.name
            ));
        }
        if !ir.package.targets.is_empty() && root.package.targets.is_empty() {
            return Err(format!(
                "E-ASSEMBLY-002: deployment must explicitly select targets supported by `{}`",
                ir.package.name
            ));
        }
        if ir.package.profile != root.package.profile {
            return Err(format!(
                "E-ASSEMBLY-002: package `{}` has incompatible profile `{}`",
                ir.package.name, ir.package.profile
            ));
        }
    }
    let mut out = root.clone();
    out.modules = packages
        .values()
        .flat_map(|ir| {
            ir.modules.iter().cloned().map(|mut module| {
                module.id = format!("{}/{}", ir.package.name, module.id);
                module
            })
        })
        .collect();
    out.modules.sort_by(|a, b| a.id.cmp(&b.id));
    let mut modules = BTreeSet::new();
    for module in &out.modules {
        for workflow in &module.workflows {
            validate_steps(&out, &workflow.id, &workflow.steps)?;
        }
        if !modules.insert(&module.id) {
            return Err(format!(
                "E-ASSEMBLY-003: duplicate module identity `{}`",
                module.id
            ));
        }
        for function in &module.functions {
            for dependency in &function.uses {
                if let Use::Resource { resource, .. } | Use::Transition { resource, .. } =
                    dependency
                    && out.find_resource(resource).is_none()
                {
                    return Err(format!(
                        "E-ASSEMBLY-004: `{}` uses resource `{resource}` outside the deployment",
                        function.id
                    ));
                }
            }
        }
        for (id, source) in module
            .views
            .iter()
            .map(|v| (&v.id, &v.source))
            .chain(module.projections.iter().map(|p| (&p.id, &p.source)))
        {
            if out.find_resource(source).is_none() {
                return Err(format!(
                    "E-ASSEMBLY-004: `{id}` reads resource `{source}` outside the deployment"
                ));
            }
        }
    }
    out.requires = packages
        .values()
        .flat_map(|ir| ir.requires.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    // Durable references must be in the same model/store. Remote callable contracts
    // remain legal, but imports cannot masquerade as remote foreign keys.
    for module in &out.modules {
        for resource in &module.resources {
            for field in &resource.fields {
                if let TypeBase::Reference { resource: target } = &field.ty.base
                    && out.find_resource(target).is_none()
                {
                    return Err(format!(
                        "E-ASSEMBLY-004: `{}.{}` references `{target}` outside the deployment; select its dependency with deploy = true",
                        resource.id, field.name
                    ));
                }
            }
        }
    }
    Ok(out)
}

fn validate_steps(ir: &DomainIR, workflow: &str, steps: &[Step]) -> Result<(), String> {
    for step in steps {
        match step {
            Step::Call {
                target: CallTarget::Transition { resource, .. },
                ..
            } if ir.find_resource(resource).is_none() => {
                return Err(format!(
                    "E-ASSEMBLY-004: workflow `{workflow}` calls transition on `{resource}` outside the deployment"
                ));
            }
            Step::Choice {
                then, otherwise, ..
            } => {
                validate_steps(ir, workflow, then)?;
                validate_steps(ir, workflow, otherwise)?;
            }
            Step::Parallel { branches, .. } => {
                for branch in branches {
                    validate_steps(ir, workflow, branch)?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}
