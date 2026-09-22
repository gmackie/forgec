//! Planners: DomainIR -> target-independent contracts, relational schema IR
//! (D1/SQLite), and DynamoDB key/access plans. Planners validate the physical
//! plan and refuse anything that would need a scan or an uncovered query.

pub mod contracts;
pub mod dynamo;
pub mod messaging;
pub mod migrations;
pub mod naming;
pub mod observability;
pub mod realtime;
pub mod schedules;
pub mod sql;
pub mod ui;
pub mod workflows;

use forgegraph_semantic::DomainIR;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanError {
    pub code: String,
    pub message: String,
    pub declaration: String,
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "error[{}]: {}: {}",
            self.code, self.declaration, self.message
        )
    }
}
impl std::error::Error for PlanError {}

#[derive(Debug, Clone, Serialize)]
pub struct Plans {
    pub contracts: contracts::Contracts,
    pub sql: sql::SqlSchema,
    pub dynamo: dynamo::DynamoPlan,
    pub ui: ui::UiDescriptor,
    pub messaging: messaging::MessagingPlan,
    pub workflows: workflows::WorkflowsPlan,
    pub schedules: schedules::SchedulesPlan,
    pub realtime: realtime::RealtimePlan,
    pub observability: observability::ObservabilityPlan,
}

pub fn plan(ir: &DomainIR) -> Result<Plans, PlanError> {
    validate(ir)?;
    Ok(Plans {
        contracts: contracts::plan(ir),
        sql: sql::plan(ir),
        dynamo: dynamo::plan(ir),
        ui: ui::plan(ir),
        messaging: messaging::plan(ir),
        workflows: workflows::plan(ir),
        schedules: schedules::plan(ir),
        realtime: realtime::plan(ir),
        observability: observability::plan(ir),
    })
}

fn validate_collection(
    ir: &DomainIR,
    ty: &forgegraph_semantic::ir::TypeSpec,
    depth: usize,
    path: &str,
) -> Result<(), PlanError> {
    use forgegraph_semantic::ir::TypeBase;
    let fail = |message: &str| PlanError {
        code: "E-PLAN-COLLECTION-001".into(),
        declaration: path.into(),
        message: message.into(),
    };
    if depth > 4 {
        return Err(fail(
            "collection/shape nesting exceeds portable depth four or contains a recursive shape",
        ));
    }
    match &ty.base {
        TypeBase::Collection { element, .. } => validate_collection(ir, element, depth + 1, path)?,
        TypeBase::Shape { id } if depth > 0 => {
            let shape = ir.find_shape(id).ok_or_else(|| {
                fail("collection shape must be available in the compiled package")
            })?;
            for f in &shape.fields {
                validate_collection(ir, &f.ty, depth + 1, path)?;
            }
        }
        TypeBase::Reference { .. } | TypeBase::Record { .. } | TypeBase::Message { .. }
            if depth > 0 =>
        {
            return Err(fail(
                "nested resource references/records/messages require integrity and purpose-aware codecs not supported by this profile; use ids or shapes",
            ));
        }
        TypeBase::Scalar { name, .. } if depth > 0 && name == "json" => {
            return Err(fail("opaque JSON is not a typed collection element"));
        }
        _ => {}
    }
    Ok(())
}

/// Physical-plan validation shared by both targets (plan §3.3): never turn an
/// indexed query into a scan or an equality partition into an ambiguous one.
fn validate(ir: &DomainIR) -> Result<(), PlanError> {
    for m in &ir.modules {
        for projection in &m.projections {
            if let Some(source) = ir
                .modules
                .iter()
                .flat_map(|m| &m.resources)
                .find(|r| r.id == projection.source)
                && !source.decorators.versioned
            {
                return Err(PlanError {code:"E-PLAN-PROJECTION-001".into(),declaration:projection.id.clone(),message:"incremental projections require a @versioned source for revision-based contribution deduplication".into()});
            }
        }
        for alias in &m.types {
            validate_collection(ir, &alias.ty, 0, &alias.id)?;
        }
        for (id, ty) in m
            .functions
            .iter()
            .flat_map(|f| f.input.iter().chain(&f.output).map(move |ty| (&f.id, ty)))
            .chain(
                m.workflows
                    .iter()
                    .flat_map(|w| w.input.iter().chain(&w.output).map(move |ty| (&w.id, ty))),
            )
        {
            validate_collection(ir, ty, 0, id)?;
        }
        for channel in &m.channels {
            for field in channel.messages.iter().flat_map(|msg| &msg.fields) {
                validate_collection(ir, &field.ty, 0, &channel.id)?;
            }
        }
        for cache in &m.caches {
            for field in &cache.keys {
                if matches!(
                    field.ty.base,
                    forgegraph_semantic::ir::TypeBase::Collection { .. }
                ) {
                    return Err(PlanError {
                        code: "E-PLAN-COLLECTION-002".into(),
                        declaration: cache.id.clone(),
                        message: "collection cache keys are not supported by the portable profile"
                            .into(),
                    });
                }
            }
        }
        for shape in &m.shapes {
            for f in &shape.fields {
                validate_collection(ir, &f.ty, 0, &shape.id)?;
            }
        }
        for r in &m.resources {
            let secrets: Vec<_> = r
                .fields
                .iter()
                .filter(|f| f.secret)
                .map(|f| f.name.as_str())
                .collect();
            if !secrets.is_empty() {
                let indexed = r
                    .uniques
                    .iter()
                    .flat_map(|u| u.fields.iter().chain(&u.within))
                    .chain(
                        r.lists
                            .iter()
                            .flat_map(|l| l.fields.iter().chain(l.order.iter().map(|o| &o.field))),
                    );
                if indexed.into_iter().any(|f| secrets.contains(&f.as_str()))
                    || !r.rules.is_empty()
                    || r.fields.iter().any(|f| f.derived.is_some())
                {
                    return Err(PlanError {code:"E-PLAN-SECRET-001".into(),declaration:r.id.clone(),message:"credential resources cannot index secrets or use row rules/derived fields in this profile".into()});
                }
                if m.projections.iter().any(|p| p.source == r.id) || !m.views.is_empty() {
                    return Err(PlanError {
                        code: "E-PLAN-SECRET-001".into(),
                        declaration: r.id.clone(),
                        message: "credential resources cannot feed read models in this profile"
                            .into(),
                    });
                }
            }
            for f in &r.fields {
                validate_collection(ir, &f.ty, 0, &r.id)?;
            }
            for key in r
                .uniques
                .iter()
                .flat_map(|u| u.fields.iter().chain(&u.within))
                .chain(
                    r.lists
                        .iter()
                        .flat_map(|l| l.fields.iter().chain(l.order.iter().map(|o| &o.field))),
                )
            {
                if r.fields.iter().any(|f| {
                    &f.name == key
                        && matches!(
                            f.ty.base,
                            forgegraph_semantic::ir::TypeBase::Collection { .. }
                        )
                }) {
                    return Err(PlanError {code:"E-PLAN-COLLECTION-002".into(),declaration:r.id.clone(),message:"collections cannot be index, uniqueness or order keys in the portable profile".into()});
                }
            }
            for search in r.lists.iter().filter(|l| l.search_mode.is_some()) {
                if search.search_mode.as_deref()!=Some("exact") || search.fields.len()>4 || search.fields.iter().any(|name|r.fields.iter().find(|f|&f.name==name).is_some_and(|f|matches!(&f.ty.base,forgegraph_semantic::ir::TypeBase::Scalar {name,..} if name=="text") && !f.ty.constraints.iter().any(|c|matches!(c,forgegraph_semantic::ir::Constraint::Length {max:Some(max),..} if *max<=128)))) {
                    return Err(PlanError {code:"E-PLAN-SEARCH-001".into(),declaration:r.id.clone(),message:"portable exact search supports at most four equality fields and requires text length <= 128; no scan fallback is available".into()});
                }
            }
            for l in &r.lists {
                for f in &l.fields {
                    let field = r
                        .fields
                        .iter()
                        .find(|x| &x.name == f)
                        .expect("checked by semantic pass");
                    if l.order.iter().any(|o| o.direction != l.order[0].direction) {
                        return Err(PlanError {
                            code: "E-PLAN-002".into(),
                            message: format!(
                                "`list by {}` mixes ascending and descending order keys; the portable profile requires one direction per query (DynamoDB serves a page with a single range scan direction).",
                                l.fields.join(", ")
                            ),
                            declaration: r.id.clone(),
                        });
                    }
                    if field.ty.optional {
                        return Err(PlanError {
                            code: "E-PLAN-001".into(),
                            message: format!(
                                "`list by {}` partitions on optional field `{f}`; null cannot form a strong access partition on both targets. Use a required field or a projection.",
                                l.fields.join(", ")
                            ),
                            declaration: r.id.clone(),
                        });
                    }
                }
            }
        }
    }
    Ok(())
}
