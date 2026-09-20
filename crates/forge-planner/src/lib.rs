//! Planners: DomainIR -> target-independent contracts, relational schema IR
//! (D1/SQLite), and DynamoDB key/access plans. Planners validate the physical
//! plan and refuse anything that would need a scan or an uncovered query.

pub mod contracts;
pub mod dynamo;
pub mod naming;
pub mod sql;

use forge_semantic::DomainIR;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanError {
    pub code: String,
    pub message: String,
    pub declaration: String,
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "error[{}]: {}: {}", self.code, self.declaration, self.message)
    }
}
impl std::error::Error for PlanError {}

#[derive(Debug, Clone, Serialize)]
pub struct Plans {
    pub contracts: contracts::Contracts,
    pub sql: sql::SqlSchema,
    pub dynamo: dynamo::DynamoPlan,
}

pub fn plan(ir: &DomainIR) -> Result<Plans, PlanError> {
    validate(ir)?;
    Ok(Plans { contracts: contracts::plan(ir), sql: sql::plan(ir), dynamo: dynamo::plan(ir) })
}

/// Physical-plan validation shared by both targets (plan §3.3): never turn an
/// indexed query into a scan or an equality partition into an ambiguous one.
fn validate(ir: &DomainIR) -> Result<(), PlanError> {
    for m in &ir.modules {
        for r in &m.resources {
            for l in &r.lists {
                for f in &l.fields {
                    let field = r.fields.iter().find(|x| &x.name == f).expect("checked by semantic pass");
                    if field.ty.optional {
                        return Err(PlanError {
                            code: "E-PLAN-001".into(),
                            message: format!("`list by {}` partitions on optional field `{f}`; null cannot form a strong access partition on both targets. Use a required field or a projection.", l.fields.join(", ")),
                            declaration: r.id.clone(),
                        });
                    }
                }
            }
        }
    }
    Ok(())
}
