//! DynamoDB key/access plan (plan §11). Explanatory key templates; the runtime
//! encodes actual keys with the versioned identity and sort codecs.

use crate::naming;
use forge_semantic::ir::*;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamoPlan {
    pub version: String,
    pub identity_codec: String,
    pub sort_codec: String,
    /// Logical table; the deployment maps it to a physical table name.
    pub table: String,
    pub pending_index: String,
    pub resources: Vec<DynamoResource>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamoResource {
    pub id: String,
    pub name: String,
    pub wire_name: String,
    pub tenant_scoped: bool,
    pub claims: Vec<Claim>,
    pub access: Vec<Access>,
    pub references: Vec<Reference>,
    /// Transaction actions consumed by a plain create (entity + claims + access + audit + outbox), for budget reporting.
    pub create_actions: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub name: String,
    pub key_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    pub name: String,
    pub kind: String,
    pub partition_fields: Vec<String>,
    pub sort_fields: Vec<String>,
    pub sort_directions: Vec<String>,
    pub projection: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub field: String,
    pub target: String,
}

pub fn plan(ir: &DomainIR) -> DynamoPlan {
    let mut resources = Vec::new();
    for m in &ir.modules {
        for r in &m.resources {
            let claims: Vec<Claim> = r
                .uniques
                .iter()
                .map(|u| Claim {
                    name: u.name.clone(),
                    key_fields: u.within.iter().chain(u.fields.iter()).cloned().collect(),
                })
                .collect();
            let access: Vec<Access> = r
                .lists
                .iter()
                .map(|l| {
                    let mut projection = vec!["id".to_string()];
                    if r.decorators.versioned {
                        projection.push("version".into());
                    }
                    for f in l.fields.iter().chain(l.order.iter().map(|o| &o.field)) {
                        if !projection.contains(f) {
                            projection.push(f.clone());
                        }
                    }
                    Access {
                        name: l.name.clone(),
                        kind: "list".into(),
                        partition_fields: l.fields.clone(),
                        sort_fields: l.order.iter().map(|o| o.field.clone()).collect(),
                        sort_directions: l.order.iter().map(|o| o.direction.clone()).collect(),
                        projection,
                    }
                })
                .collect();
            let references: Vec<Reference> = r
                .fields
                .iter()
                .filter_map(|f| {
                    if let TypeBase::Reference { resource } = &f.ty.base {
                        Some(Reference {
                            field: f.name.clone(),
                            target: resource.clone(),
                        })
                    } else {
                        None
                    }
                })
                .collect();
            let create_actions = 1 + claims.len() + access.len() + references.len() + 2; // entity, claims, access items, parent guards, audit, outbox
            resources.push(DynamoResource {
                id: r.id.clone(),
                name: r.name.clone(),
                wire_name: naming::wire(&r.name),
                tenant_scoped: r.decorators.tenant,
                claims,
                access,
                references,
                create_actions,
            });
        }
    }
    DynamoPlan {
        version: "dynamo-plan/1".into(),
        identity_codec: "identity.v1".into(),
        sort_codec: "sort.v1".into(),
        table: "data".into(),
        pending_index: "pending-index".into(),
        resources,
    }
}
