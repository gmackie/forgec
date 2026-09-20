//! Relational schema IR and its SQLite/D1 rendering (plan §10.1).

use crate::naming;
use forge_semantic::ir::*;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlSchema {
    pub version: String,
    pub dialect: String,
    pub tables: Vec<Table>,
    pub indexes: Vec<Index>,
    pub system_tables: Vec<Table>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Table {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    pub columns: Vec<Column>,
    pub primary_key: Vec<String>,
    pub foreign_keys: Vec<ForeignKey>,
    pub checks: Vec<Check>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    pub sql_type: String,
    pub nullable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    /// How the runtime maps the field value to the column: text | integer | minorUnits | bool | json
    pub storage: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    pub columns: Vec<String>,
    pub references: String,
    pub referenced_columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    pub expression: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub name: String,
    pub table: String,
    pub columns: Vec<String>,
    pub unique: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constraint: Option<String>,
}

pub fn storage_of(ty: &TypeSpec) -> (&'static str, &'static str) {
    match &ty.base {
        TypeBase::Scalar { name, .. } => match name.as_str() {
            "integer" => ("INTEGER", "integer"),
            "decimal" | "money" => ("INTEGER", "minorUnits"),
            "boolean" => ("INTEGER", "bool"),
            "json" => ("TEXT", "json"),
            _ => ("TEXT", "text"),
        },
        TypeBase::Shape { .. } | TypeBase::Record { .. } | TypeBase::Message { .. } => ("TEXT", "json"),
        _ => ("TEXT", "text"),
    }
}

pub fn plan(ir: &DomainIR) -> SqlSchema {
    let mut tables = Vec::new();
    let mut indexes = Vec::new();
    for m in &ir.modules {
        for r in &m.resources {
            let tname = naming::table(&r.name);
            let mut columns = Vec::new();
            let mut foreign_keys = Vec::new();
            if r.decorators.tenant {
                columns.push(Column { name: "tenant".into(), sql_type: "TEXT".into(), nullable: false, field: None, storage: "text".into() });
            }
            for f in &r.fields {
                if f.derived.is_some() {
                    continue; // computed on read
                }
                let (sql_type, storage) = storage_of(&f.ty);
                columns.push(Column { name: naming::column(&f.name), sql_type: sql_type.into(), nullable: f.ty.optional, field: Some(f.name.clone()), storage: storage.into() });
                if let TypeBase::Reference { resource } = &f.ty.base {
                    if let Some(target) = ir.find_resource(resource) {
                        let (mut cols, mut refs) = (vec![], vec![]);
                        if r.decorators.tenant && target.decorators.tenant {
                            cols.push("tenant".to_string());
                            refs.push("tenant".to_string());
                        }
                        cols.push(naming::column(&f.name));
                        refs.push("id".into());
                        foreign_keys.push(ForeignKey { columns: cols, references: naming::table(&target.name), referenced_columns: refs });
                    }
                }
            }
            let key = |extra: &[String]| -> Vec<String> {
                let mut k = Vec::new();
                if r.decorators.tenant {
                    k.push("tenant".to_string());
                }
                k.extend(extra.iter().map(|f| naming::column(f)));
                k
            };
            let primary_key = key(&["id".to_string()]);
            for u in &r.uniques {
                let mut cols: Vec<String> = u.within.clone();
                cols.extend(u.fields.clone());
                indexes.push(Index { name: format!("{tname}_uq_{}", u.name), table: tname.clone(), columns: key(&cols), unique: true, query: None, constraint: Some(u.name.clone()) });
            }
            for l in &r.lists {
                let mut cols: Vec<String> = l.fields.clone();
                for o in &l.order {
                    if !cols.contains(&o.field) {
                        cols.push(o.field.clone());
                    }
                }
                indexes.push(Index { name: format!("{tname}_ix_{}", naming::snake(&l.name)), table: tname.clone(), columns: key(&cols), unique: false, query: Some(l.name.clone()), constraint: None });
            }
            let mut checks = Vec::new();
            if let Some(lc) = &r.lifecycle {
                checks.push(Check { name: format!("{tname}_status"), expression: format!("status IN ({})", lc.states.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(", ")) });
            }
            tables.push(Table { name: tname, resource: Some(r.id.clone()), columns, primary_key, foreign_keys, checks });
        }
    }
    SqlSchema { version: "sql-schema/1".into(), dialect: "sqlite".into(), tables, indexes, system_tables: system_tables() }
}

fn col(name: &str, sql_type: &str, nullable: bool) -> Column {
    Column { name: name.into(), sql_type: sql_type.into(), nullable, field: None, storage: "text".into() }
}

/// System facilities shared by every resource (plan §10.1). Created only when
/// the corresponding feature is enabled; M2 enables audit, outbox, receipts.
pub fn system_tables() -> Vec<Table> {
    vec![
        Table {
            name: "_forge_assert".into(),
            resource: None,
            columns: vec![col("op_id", "TEXT", false), col("satisfied", "INTEGER", false)],
            primary_key: vec!["op_id".into()],
            foreign_keys: vec![],
            checks: vec![Check { name: "forge_precondition".into(), expression: "satisfied = 1".into() }],
        },
        Table {
            name: "forge_audit".into(),
            resource: None,
            columns: vec![col("tenant", "TEXT", false), col("op_id", "TEXT", false), col("resource", "TEXT", false), col("record_id", "TEXT", false), col("kind", "TEXT", false), col("new_version", "INTEGER", true), col("actor", "TEXT", false), col("at", "TEXT", false), col("payload", "TEXT", true)],
            primary_key: vec!["tenant".into(), "op_id".into()],
            foreign_keys: vec![],
            checks: vec![],
        },
        Table {
            name: "forge_outbox".into(),
            resource: None,
            columns: vec![col("tenant", "TEXT", false), col("op_id", "TEXT", false), col("ordinal", "INTEGER", false), col("channel", "TEXT", false), col("message", "TEXT", false), col("payload", "TEXT", false), col("status", "TEXT", false), col("lease_owner", "TEXT", true), col("lease_until", "INTEGER", true), col("attempts", "INTEGER", false), col("created_at", "TEXT", false)],
            primary_key: vec!["tenant".into(), "op_id".into(), "ordinal".into()],
            foreign_keys: vec![],
            checks: vec![],
        },
        Table {
            name: "forge_document".into(),
            resource: None,
            columns: vec![col("tenant", "TEXT", false), col("kind", "TEXT", false), col("id", "TEXT", false), col("version", "INTEGER", false), col("body", "TEXT", false)],
            primary_key: vec!["tenant".into(), "kind".into(), "id".into()],
            foreign_keys: vec![],
            checks: vec![],
        },
        Table {
            name: "forge_receipt".into(),
            resource: None,
            columns: vec![col("tenant", "TEXT", false), col("operation", "TEXT", false), col("key", "TEXT", false), col("request_hash", "TEXT", false), col("status", "INTEGER", false), col("response", "TEXT", false), col("created_at", "TEXT", false)],
            primary_key: vec!["tenant".into(), "operation".into(), "key".into()],
            foreign_keys: vec![],
            checks: vec![],
        },
    ]
}

fn q(name: &str) -> String {
    format!("\"{name}\"")
}

/// Deterministic SQLite DDL.
pub fn render_sqlite(s: &SqlSchema) -> String {
    let mut out = String::from("-- Generated by forge build; do not edit.\nPRAGMA foreign_keys = ON;\n");
    for t in s.system_tables.iter().chain(s.tables.iter()) {
        out.push_str(&format!("\nCREATE TABLE {} (\n", t.name));
        let mut lines: Vec<String> = t.columns.iter().map(|c| format!("  {} {}{}", q(&c.name), c.sql_type, if c.nullable { "" } else { " NOT NULL" })).collect();
        lines.push(format!("  PRIMARY KEY ({})", t.primary_key.iter().map(|c| c.to_string()).collect::<Vec<_>>().join(", ")));
        for fk in &t.foreign_keys {
            lines.push(format!("  FOREIGN KEY ({}) REFERENCES {} ({})", fk.columns.join(", "), fk.references, fk.referenced_columns.join(", ")));
        }
        for c in &t.checks {
            lines.push(format!("  CONSTRAINT {} CHECK ({})", c.name, c.expression));
        }
        out.push_str(&lines.join(",\n"));
        out.push_str("\n);\n");
    }
    out.push('\n');
    out.push_str("CREATE INDEX forge_outbox_pending ON forge_outbox (status, lease_until);\n");
    for i in &s.indexes {
        out.push_str(&format!("CREATE {}INDEX {} ON {} ({});\n", if i.unique { "UNIQUE " } else { "" }, i.name, i.table, i.columns.join(", ")));
    }
    out
}
