//! UI descriptor (plan §23): one target-independent description of tables,
//! forms, relationship pickers and actions. The workspace renders from it and
//! the client; it never touches storage.

use crate::naming;
use forge_semantic::ir::*;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiDescriptor {
    pub version: String,
    pub package: String,
    pub resources: Vec<UiResource>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiResource {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub label: String,
    pub plural: String,
    /// URL segment in the workspace and the wire name of the API route family.
    pub route: String,
    pub title_field: String,
    pub fields: Vec<UiField>,
    pub table_columns: Vec<String>,
    pub lists: Vec<UiList>,
    pub finds: Vec<UiFind>,
    pub actions: Vec<UiAction>,
    pub soft_delete: bool,
    pub versioned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<ContentPolicy>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiField {
    pub name: String,
    pub label: String,
    pub widget: String,
    pub required: bool,
    pub editable_on_create: bool,
    pub editable_on_update: bool,
    pub sortable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<UiOption>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<UiReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UiOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiReference {
    pub resource: String,
    pub route: String,
    pub title_field: String,
    /// A bounded list operation the picker can page through, and the parameters it needs.
    pub lookup: String,
    pub lookup_params: Vec<String>,
    /// A find-by operation for resolving a typed key, if one exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub find: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiList {
    pub name: String,
    pub op: String,
    pub params: Vec<String>,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiFind {
    pub name: String,
    pub op: String,
    pub params: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiAction {
    pub name: String,
    pub label: String,
    pub op: String,
    pub from: Vec<String>,
    pub to: String,
    pub input_fields: Vec<UiField>,
}

fn label_of(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if i == 0 {
            out.push(c.to_ascii_uppercase());
        } else if c.is_ascii_uppercase() {
            out.push(' ');
            out.push(c);
        } else {
            out.push(c);
        }
    }
    out
}

fn plural_of(label: &str) -> String {
    if label.ends_with('s') { format!("{label}es") } else { format!("{label}s") }
}

fn widget_of(ir: &DomainIR, f: &Field) -> (String, Option<Vec<UiOption>>) {
    if f.server_owned && f.name != "id" {
        if let TypeBase::Status { .. } = f.ty.base {
            return ("status".into(), None);
        }
        return ("readonly".into(), None);
    }
    match &f.ty.base {
        TypeBase::Scalar { name, .. } => (
            match name.as_str() {
                "boolean" => "checkbox",
                "integer" => "integer",
                "decimal" | "money" => "decimal",
                "date" => "date",
                "datetime" => "datetime",
                "localTime" => "time",
                "email" => "email",
                "url" => "url",
                "timezone" => "timezone",
                "json" => "json",
                "id" => "readonly",
                _ => {
                    if f.ty.constraints.iter().any(|c| matches!(c, Constraint::Length { max: Some(m), .. } if *m > 200)) { "textarea" } else { "text" }
                }
            }
            .into(),
            None,
        ),
        TypeBase::Enum { id } => ("select".into(), ir.find_enum(id).map(|e| e.members.iter().map(|m| UiOption { value: m.value.clone(), label: label_of(&m.name) }).collect())),
        TypeBase::Reference { .. } => ("reference".into(), None),
        TypeBase::Status { .. } => ("status".into(), None),
        _ => ("json".into(), None),
    }
}

fn title_field_of(r: &Resource) -> String {
    for cand in ["name", "label", "title", "code"] {
        if r.fields.iter().any(|f| f.name == cand) {
            return cand.into();
        }
    }
    "id".into()
}

fn field(ir: &DomainIR, r: &Resource, f: &Field) -> UiField {
    let (widget, options) = widget_of(ir, f);
    let writable = !f.server_owned && !f.synthesized && f.derived.is_none();
    let reference = if let TypeBase::Reference { resource } = &f.ty.base {
        ir.find_resource(resource).map(|target| {
            let lookup = target.lists.iter().find(|l| l.fields.is_empty()).or(target.lists.first()).map(|l| (format!("{}.list.{}", target.id, l.name), l.fields.clone())).unwrap_or_else(|| (format!("{}.list", target.id), vec![]));
            UiReference {
                resource: target.id.clone(),
                route: naming::wire(&target.name).replace('_', "-"),
                title_field: title_field_of(target),
                lookup: lookup.0,
                lookup_params: lookup.1,
                find: target.finds.first().map(|x| format!("{}.find.{}", target.id, x.name)),
            }
        })
    } else {
        None
    };
    let (mut min_length, mut max_length) = (None, None);
    for c in &f.ty.constraints {
        if let Constraint::Length { min, max } = c {
            min_length = *min;
            max_length = *max;
        }
    }
    let currency = if let TypeBase::Scalar { name, args } = &f.ty.base { if name == "money" { Some(args.first().cloned().unwrap_or_else(|| "USD".into())) } else { None } } else { None };
    let _ = r;
    UiField {
        name: f.name.clone(),
        label: label_of(&f.name),
        widget,
        required: !f.ty.optional && f.default.is_none() && writable,
        editable_on_create: writable,
        editable_on_update: writable && !f.immutable,
        sortable: matches!(f.ty.base, TypeBase::Scalar { .. } | TypeBase::Enum { .. }),
        options,
        reference,
        min_length,
        max_length,
        currency,
        doc: f.doc.clone(),
    }
}

pub fn plan(ir: &DomainIR) -> UiDescriptor {
    let mut resources = Vec::new();
    for m in &ir.modules {
        for r in &m.resources {
            let fields: Vec<UiField> = r.fields.iter().filter(|f| !f.hidden).map(|f| field(ir, r, f)).collect();
            let title_field = title_field_of(r);
            let _ = &title_field;
            // Status first when there is a lifecycle, then the title field, then declared fields.
            let mut table_columns: Vec<String> = Vec::new();
            if let Some(lc) = &r.lifecycle {
                table_columns.push(lc.field.clone());
            }
            table_columns.push(title_field.clone());
            for f in fields.iter().filter(|f| !f.name.starts_with("upload") && f.widget != "json" && !["id", "version", "createdAt", "updatedAt", "deletedAt"].contains(&f.name.as_str())) {
                if !table_columns.contains(&f.name) && table_columns.len() < 7 {
                    table_columns.push(f.name.clone());
                }
            }
            if r.kind == "blob" {
                table_columns.push("uploadState".into());
            }
            let actions = r
                .lifecycle
                .as_ref()
                .map(|lc| {
                    lc.transitions
                        .iter()
                        .filter(|t| r.operations.iter().any(|o| o.action.as_ref() == Some(&t.action) && o.http.is_some()))
                        .map(|t| UiAction { name: t.action.clone(), label: label_of(&t.action), op: format!("{}.status.{}", r.id, t.action), from: t.from.clone(), to: t.to.clone(), input_fields: t.input.iter().map(|f| field(ir, r, f)).collect() })
                        .collect()
                })
                .unwrap_or_default();
            resources.push(UiResource {
                id: r.id.clone(),
                name: r.name.clone(),
                kind: r.kind.clone(),
                label: label_of(&r.name),
                plural: plural_of(&label_of(&r.name)),
                route: naming::wire(&r.name).replace('_', "-").to_string() + if r.name.ends_with('s') { "es" } else { "s" },
                title_field,
                fields,
                table_columns,
                lists: r.lists.iter().map(|l| UiList { name: l.name.clone(), op: format!("{}.list.{}", r.id, l.name), params: l.fields.clone(), label: if l.fields.is_empty() { "All".into() } else { format!("By {}", l.fields.iter().map(|f| label_of(f)).collect::<Vec<_>>().join(" & ")) } }).collect(),
                finds: r.finds.iter().map(|f| UiFind { name: f.name.clone(), op: format!("{}.find.{}", r.id, f.name), params: f.fields.clone() }).collect(),
                actions,
                soft_delete: r.decorators.soft_delete,
                versioned: r.decorators.versioned,
                content: r.content.clone(),
            });
        }
    }
    UiDescriptor { version: "ui/1".into(), package: ir.package.name.clone(), resources }
}
