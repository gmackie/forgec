//! Permanent registry identities, exact semantic revisions, and explicit L1 references.
use crate::concept::{ConceptIR, Violation};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Registry {
    pub entries: BTreeMap<String, Registration>,
    /// Local declaration anchor -> permanent identity. Source anchors are not registry IDs.
    pub bindings: BTreeMap<String, String>,
    pub imports: Vec<RevisionPin>,
}
impl Registry {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Registration {
    pub authority: String,
    pub stable_id: String,
    /// Exact, authority-issued definition revision; never a package release range.
    pub revision: String,
    pub digest: String,
    pub label: String,
    pub aliases: BTreeSet<String>,
    pub deprecated: bool,
    pub supersedes: BTreeSet<String>,
    pub external_mappings: BTreeSet<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevisionPin {
    pub identity: String,
    pub revision: String,
    pub digest: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistryRealization {
    pub pin: RevisionPin,
    pub declaration: String,
    pub artifact: String,
}
const FAMILIES: &[&str] = &[
    "entities",
    "facts",
    "externals",
    "principals",
    "policies",
    "processes",
    "purposes",
    "dataClasses",
    "shapes",
    "enums",
];
const SEMANTICS: &[&str] = &[
    "subjects",
    "representations",
    "interactions",
    "contracts",
    "relationships",
    "effects",
    "views",
    "selections",
    "externalConstraints",
    "traceability",
];

// Only reference-bearing slots are rewritten. Text literals, field names, port labels,
// enum members and user expressions retain their meaning even when they resemble IDs.
fn normalize(value: &Value, bindings: &BTreeMap<String, String>, slot: &str) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    let child =
                        if key == "literal" || (key == "value" && object.contains_key("type")) {
                            value.clone()
                        } else {
                            normalize(
                                value,
                                bindings,
                                if key == "processes" && object.contains_key("participation") {
                                    "interactionProcesses"
                                } else {
                                    key
                                },
                            )
                        };
                    let key = if matches!(
                        slot,
                        "temporal" | "requiredAttributes" | "events" | "interactionProcesses"
                    ) {
                        bindings.get(key).unwrap_or(key).clone()
                    } else {
                        key.clone()
                    };
                    let child = if matches!(slot, "causes" | "targets") {
                        normalize(value, bindings, "target")
                    } else {
                        child
                    };
                    (key, child)
                })
                .collect(),
        ),
        Value::Array(values) => {
            let mut values: Vec<_> = values
                .iter()
                .map(|v| normalize(v, bindings, slot))
                .collect();
            if matches!(
                slot,
                "events"
                    | "participation"
                    | "evidence"
                    | "selectors"
                    | "authorizations"
                    | "requirements"
                    | "prohibitions"
                    | "supersedes"
            ) {
                values.sort_by_key(Value::to_string);
            }
            Value::Array(values)
        }
        Value::String(id)
            if matches!(
                slot,
                "id" | "carrier"
                    | "events"
                    | "context"
                    | "process"
                    | "selectors"
                    | "authorizations"
                    | "target"
                    | "principal"
                    | "policy"
                    | "purpose"
                    | "dataClass"
                    | "fact"
                    | "entity"
                    | "external"
                    | "relationship"
                    | "participation"
                    | "evidence"
                    | "requiredBy"
                    | "source"
                    | "destination"
                    | "authority"
                    | "jurisdiction"
                    | "requirements"
                    | "prohibitions"
                    | "supersedes"
                    | "contract"
            ) =>
        {
            Value::String(bindings.get(id).unwrap_or(id).clone())
        }
        _ => value.clone(),
    }
}
impl ConceptIR {
    fn registry_declarations(&self) -> BTreeMap<String, (String, Value)> {
        let raw = serde_json::to_value(self).unwrap();
        let mut out = BTreeMap::new();
        for (prefix, families, root) in [
            ("", FAMILIES, &raw),
            ("semantics/", SEMANTICS, &raw["semantics"]),
        ] {
            for family in families {
                if let Some(items) = root[*family].as_object() {
                    for (id, definition) in items {
                        let mut definition = normalize(definition, &self.registry.bindings, "");
                        if *family != "shapes"
                            && *family != "enums"
                            && let Some(object) = definition.as_object_mut()
                        {
                            object.remove("name");
                        }
                        out.insert(id.clone(), (format!("{prefix}{family}"), definition));
                    }
                }
            }
        }
        out
    }
    /// Hash a definition with permanent reference identities and without presentation names.
    pub fn registry_definition_digest(&self, declaration: &str) -> Option<String> {
        let declarations = self.registry_declarations();
        let (family, definition) = declarations.get(declaration)?;
        Some(crate::ir::hash_hex(
            &json!({"family":family,"definition":definition}).to_string(),
        ))
    }
    pub fn validate_registry(&self) -> Vec<Violation> {
        let mut errors = vec![];
        let mut fail = |subject: &str, message: &str| {
            errors.push(Violation {
                code: "E-L0-REGISTRY".into(),
                subject: subject.into(),
                message: message.into(),
            })
        };
        let mut names = BTreeMap::new();
        let mut mappings = BTreeMap::new();
        for (identity, entry) in &self.registry.entries {
            if entry.authority.trim().is_empty()
                || entry.authority.contains('#')
                || entry.authority.chars().any(char::is_whitespace)
                || entry.stable_id.is_empty()
                || !entry
                    .stable_id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c))
                || *identity != format!("{}#{}", entry.authority, entry.stable_id)
            {
                fail(
                    identity,
                    "identity must be authority#stableId with unambiguous nonempty components",
                );
            }
            if entry.label.trim().is_empty()
                || entry.revision.trim().is_empty()
                || matches!(entry.revision.as_str(), "*" | "latest")
                || entry.revision.starts_with(['^', '~'])
                || entry.digest.len() != 64
                || !entry
                    .digest
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            {
                fail(
                    identity,
                    "registration requires a label, exact revision and lowercase SHA-256 digest",
                );
            }
            for name in std::iter::once(identity).chain(entry.aliases.iter()) {
                if name.trim().is_empty()
                    || names
                        .insert(name, identity)
                        .is_some_and(|old| old != identity)
                {
                    fail(identity, "identity or alias collision");
                }
            }
            for external in &entry.external_mappings {
                if external.trim().is_empty()
                    || mappings
                        .insert(external, identity)
                        .is_some_and(|old| old != identity)
                {
                    fail(identity, "external standard mapping collision");
                }
            }
            let mut queue: Vec<_> = entry.supersedes.iter().collect();
            let mut seen = BTreeSet::new();
            while let Some(previous) = queue.pop() {
                if previous == identity {
                    fail(identity, "cyclic supersession");
                    break;
                }
                if !seen.insert(previous) {
                    continue;
                }
                match self.registry.entries.get(previous) {
                    Some(previous) => queue.extend(previous.supersedes.iter()),
                    None => fail(identity, "supersession target must be registered"),
                }
            }
        }
        let declarations = self.registry_declarations();
        let raw = serde_json::to_value(self).unwrap();
        let mut anchors = BTreeSet::new();
        for (families, root) in [(FAMILIES, &raw), (SEMANTICS, &raw["semantics"])] {
            for family in families {
                if let Some(items) = root[*family].as_object() {
                    for anchor in items.keys() {
                        if !anchors.insert(anchor) && self.registry.bindings.contains_key(anchor) {
                            fail(
                                anchor,
                                "registry binding is ambiguous across declaration families",
                            );
                        }
                    }
                }
            }
        }
        for identity in self.registry.entries.keys() {
            if declarations.contains_key(identity)
                && self.registry.bindings.get(identity) != Some(identity)
            {
                fail(
                    identity,
                    "permanent identity collides with an unregistered local declaration",
                );
            }
        }
        for (anchor, identity) in &self.registry.bindings {
            if !declarations.contains_key(anchor) {
                fail(anchor, "binding must reference a declared concept");
            }
            match self.registry.entries.get(identity) {
                Some(entry)
                    if self.registry_definition_digest(anchor).as_ref() == Some(&entry.digest) => {}
                Some(_) => fail(
                    anchor,
                    "definition does not match the registered semantic digest",
                ),
                None => fail(
                    anchor,
                    "binding must use a registered permanent identity, not an alias",
                ),
            }
        }
        for pin in &self.registry.imports {
            if !self.registry_pin_matches(pin) {
                fail(
                    &pin.identity,
                    "registry import does not match the exact registered revision and digest",
                );
            }
        }
        errors
    }
    fn registry_pin_matches(&self, pin: &RevisionPin) -> bool {
        self.registry
            .entries
            .get(&pin.identity)
            .is_some_and(|entry| entry.revision == pin.revision && entry.digest == pin.digest)
    }
    /// Checks references only. It does not certify that an artifact implements a definition.
    pub fn check_registry_realizations(
        &self,
        references: &[RegistryRealization],
    ) -> Vec<Violation> {
        let mut errors = self.validate_registry();
        for reference in references {
            if reference.artifact.trim().is_empty()
                || !self.registry_pin_matches(&reference.pin)
                || self.registry.bindings.get(&reference.declaration)
                    != Some(&reference.pin.identity)
            {
                errors.push(Violation { code: "E-L0-REGISTRY".into(), subject: reference.declaration.clone(), message: "realization requires an artifact identity and an exact registered declaration pin".into() });
            }
        }
        errors
    }
    /// Permanent IDs align declarations across source moves. Registry metadata still diffs.
    pub(crate) fn registry_diff_value(&self) -> Value {
        let mut raw = normalize(
            &serde_json::to_value(self).unwrap(),
            &self.registry.bindings,
            "",
        );
        for (prefix, families) in [("", FAMILIES), ("semantics", SEMANTICS)] {
            let root = if prefix.is_empty() {
                &mut raw
            } else {
                &mut raw[prefix]
            };
            for family in families {
                if let Some(items) = root[*family].as_object_mut() {
                    let previous = std::mem::take(items);
                    for (anchor, mut definition) in previous {
                        if let Some(identity) = self.registry.bindings.get(&anchor) {
                            if *family != "shapes"
                                && *family != "enums"
                                && let Some(object) = definition.as_object_mut()
                            {
                                object.remove("name");
                            }
                            items.insert(identity.clone(), definition);
                        } else {
                            items.insert(anchor, definition);
                        }
                    }
                }
            }
        }
        if let Some(registry) = raw.get_mut("registry").and_then(Value::as_object_mut) {
            registry.remove("bindings");
        }
        raw
    }
}
