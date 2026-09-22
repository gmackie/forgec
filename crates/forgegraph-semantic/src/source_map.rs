//! Build-bound source sidecar. No file location participates in DomainIR identity.
use crate::{Compilation, compiler::SourceSpan, ir::hash_hex};
use forgegraph_syntax::{SyntaxKind as K, SyntaxNode};
use serde_json::{Value, json};
use std::collections::BTreeMap;

impl Compilation {
    pub fn source_map(
        &self,
        build_hash: &str,
        compiler_version: &str,
        revision: Option<&str>,
    ) -> Value {
        let mut sources = BTreeMap::new();
        let mut anchors = self.source_index.clone();
        let mut derivations: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for file in &self.files {
            sources.insert(file.path.clone(),json!({"digest":format!("sha256:{}",hash_hex(&file.text)),"byteLength":file.text.len()}));
            let parsed = self
                .parsed
                .get(&file.path.replace('\\', "/"))
                .expect("compiled file has a parse tree");
            let module = parsed
                .root()
                .declarations()
                .find_map(|d| {
                    if let forgegraph_syntax::ast::Declaration::Module(m) = d {
                        m.path().map(|p| p.text())
                    } else {
                        None
                    }
                })
                .unwrap_or_else(|| "_".into());
            for decl in parsed.root().declarations() {
                let Some(ir) = self.ir.as_ref() else { continue };
                let name = match decl.name() {
                    Some(name) => name.text().to_string(),
                    None if decl.syntax().kind() == K::SUBSCRIPTION_DECL => {
                        format!("#subscription:{}", normalized_key(decl.syntax()))
                    }
                    None => continue,
                };
                let id = format!("{}/{}/{}", ir.package.name, module, name);
                anchors.entry(id.clone()).or_insert_with(|| SourceSpan {
                    file: file.path.clone(),
                    start: u32::from(decl.syntax().text_range().start()) as usize,
                    end: u32::from(decl.syntax().text_range().end()) as usize,
                });
                for node in decl.syntax().descendants().skip(1) {
                    let Some(component) = anchor_component(&node) else {
                        continue;
                    };
                    let mut parents = node
                        .ancestors()
                        .skip(1)
                        .take_while(|n| n != decl.syntax())
                        .filter_map(|n| anchor_component(&n))
                        .collect::<Vec<_>>();
                    parents.reverse();
                    parents.push(component);
                    let anchor = format!("{id}#{}", parents.join("/"));
                    anchors.entry(anchor).or_insert_with(|| SourceSpan {
                        file: file.path.clone(),
                        start: u32::from(node.text_range().start()) as usize,
                        end: u32::from(node.text_range().end()) as usize,
                    });
                }
            }
        }
        if let Some(ir) = &self.ir {
            for module in &ir.modules {
                for (effective, origin) in &module.facet_origins {
                    let resource = effective.split("#field:").next().unwrap();
                    let facet = origin.split("#field:").next().unwrap();
                    let application = format!("{resource}#facet:{facet}");
                    if let Some(owner) = self.source_index.get(resource)
                        && let Some(reference) = self.references.iter().find(|r| {
                            r.target == facet
                                && r.span.file == owner.file
                                && r.span.start >= owner.start
                                && r.span.end <= owner.end
                        })
                    {
                        anchors.insert(application.clone(), reference.span.clone());
                    }
                    derivations.insert(
                        effective.clone(),
                        vec![
                            json!({"kind":"facet-field","from":origin}),
                            json!({"kind":"facet-application","from":application}),
                        ],
                    );
                }
                for resource in &module.resources {
                    for operation in &resource.operations {
                        let suffix = operation
                            .id
                            .strip_prefix(&format!("{}.", resource.id))
                            .unwrap_or(&operation.id);
                        let anchor = format!("{}#op:{suffix}", resource.id);
                        if let Some(span) = self.source_index.get(&resource.id) {
                            anchors.insert(anchor.clone(), span.clone());
                        }
                        derivations.insert(
                            anchor,
                            vec![json!({"kind":"generated-operation","from":resource.id})],
                        );
                    }
                }
            }
        }
        let mut out = json!({"version":"forge-source-map/1","package":self.ir.as_ref().map(|ir|&ir.package.name),"buildHash":build_hash,"compilerVersion":compiler_version,"sources":sources,"anchors":anchors,"derivations":derivations});
        if let Some(revision) = revision {
            out["revision"] = json!(revision);
        }
        out
    }
}

fn normalized_key(node: &SyntaxNode) -> String {
    let material = node
        .descendants_with_tokens()
        .filter_map(|e| e.into_token())
        .filter(|t| !t.kind().is_trivia() && t.kind() != K::NEWLINE)
        .map(|t| t.text().to_string())
        .collect::<Vec<_>>()
        .join("\0");
    hash_hex(&material)
}
fn anchor_component(node: &SyntaxNode) -> Option<String> {
    let kind = match node.kind() {
        K::FIELD_DECL => "field",
        K::DECORATOR => "decorator",
        K::RULE => "rule",
        K::UNIQUE_DECL => "unique",
        K::FIND_DECL => "find",
        K::LIST_DECL => "list",
        K::LIFECYCLE_BLOCK => "lifecycle",
        K::TRANSITION_DECL => "transition",
        K::CAPABILITY_DECL => "capability",
        K::CAPABILITY_ITEM => "capability-atom",
        K::PURPOSE_BINDING | K::FUNCTION_PURPOSE => "purpose",
        K::USE_DECL => "uses",
        K::MESSAGE_DECL => "message",
        K::STEP_DECL => "step",
        K::CRON_DECL => "schedule",
        K::AGGREGATE_DECL => "aggregate",
        K::TARGET_DECL => "target",
        _ => return None,
    };
    let tokens: Vec<_> = node
        .children_with_tokens()
        .filter_map(|e| e.into_token())
        .filter(|t| t.kind() == K::IDENT)
        .collect();
    let named = match node.kind() {
        K::FIELD_DECL | K::TRANSITION_DECL => tokens.first(),
        K::LIFECYCLE_BLOCK | K::CAPABILITY_DECL | K::MESSAGE_DECL | K::STEP_DECL => tokens.get(1),
        _ => None,
    };
    let key = named
        .map(|t| t.text().to_string())
        .unwrap_or_else(|| normalized_key(node));
    Some(format!("{kind}:{key}"))
}
