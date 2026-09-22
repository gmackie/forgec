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
    let plans = Plans {
        contracts: contracts::plan(ir),
        sql: sql::plan(ir),
        dynamo: dynamo::plan(ir),
        ui: ui::plan(ir),
        messaging: messaging::plan(ir),
        workflows: workflows::plan(ir),
        schedules: schedules::plan(ir),
        realtime: realtime::plan(ir),
        observability: observability::plan(ir),
    };
    validate_names(&plans)?;
    Ok(plans)
}

/// Existing emitters use short physical/client names. Until namespacing is supported,
/// refuse ambiguous output instead of generating a schema that overwrites a sibling.
fn validate_names(plans: &Plans) -> Result<(), PlanError> {
    fn unique<'a>(
        kind: &str,
        items: impl Iterator<Item = (&'a str, &'a str)>,
    ) -> Result<(), PlanError> {
        let mut seen = std::collections::BTreeMap::new();
        for (name, id) in items {
            if let Some(previous) = seen.insert(name, id) {
                return Err(PlanError {
                    code: "E-PLAN-003".into(),
                    message: format!(
                        "{kind} collision `{name}` between `{previous}` and `{id}`; co-deployed names must be distinct"
                    ),
                    declaration: id.into(),
                });
            }
        }
        Ok(())
    }
    unique(
        "table",
        plans
            .sql
            .tables
            .iter()
            .chain(&plans.sql.system_tables)
            .map(|t| (t.name.as_str(), t.resource.as_deref().unwrap_or("system"))),
    )?;
    unique(
        "index",
        plans
            .sql
            .indexes
            .iter()
            .map(|i| (i.name.as_str(), i.table.as_str())),
    )?;
    unique(
        "resource name",
        plans
            .contracts
            .resources
            .iter()
            .map(|r| (r.name.as_str(), r.id.as_str())),
    )?;
    unique(
        "wire name",
        plans
            .contracts
            .resources
            .iter()
            .map(|r| (r.wire_name.as_str(), r.id.as_str())),
    )?;
    unique(
        "function name",
        plans
            .contracts
            .functions
            .iter()
            .map(|f| (f.name.as_str(), f.id.as_str())),
    )?;
    let mut routes = std::collections::BTreeMap::new();
    for (http, id) in plans
        .contracts
        .resources
        .iter()
        .flat_map(|r| {
            r.operations
                .iter()
                .filter_map(|o| o.http.as_ref().map(|h| (h, o.id.as_str())))
        })
        .chain(
            plans
                .contracts
                .functions
                .iter()
                .filter_map(|f| f.http.as_ref().map(|h| (h, f.id.as_str()))),
        )
    {
        let key = (http.method.as_str(), http.path.as_str());
        if let Some(previous) = routes.insert(key, id) {
            return Err(PlanError {
                code: "E-PLAN-003".into(),
                message: format!(
                    "HTTP route collision `{} {}` between `{previous}` and `{id}`",
                    key.0, key.1
                ),
                declaration: id.into(),
            });
        }
    }
    Ok(())
}

/// Physical-plan validation shared by both targets (plan §3.3): never turn an
/// indexed query into a scan or an equality partition into an ambiguous one.
fn validate(ir: &DomainIR) -> Result<(), PlanError> {
    for m in &ir.modules {
        for r in &m.resources {
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
