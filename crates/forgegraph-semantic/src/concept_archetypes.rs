//! Named semantic graph profiles. Bindings elaborate to ordinary L0 declarations;
//! no runtime inheritance or execution policy is introduced.
use crate::concept::{ConceptIR, Violation};
use crate::concept_semantics::{Contract, ContractOwner, Endpoint, Relationship};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Archetypes {
    pub definitions: BTreeMap<String, Archetype>,
    pub profiles: BTreeMap<String, Profile>,
}
impl Archetypes {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Archetype {
    pub roles: BTreeMap<String, Role>,
    /// Structural relationship name -> endpoint name -> role.
    pub relationships: BTreeMap<String, BTreeMap<String, String>>,
    /// Owners use role names; predicates use the bound owner's local field vocabulary.
    pub contracts: BTreeMap<String, Contract>,
    pub outputs: BTreeSet<String>,
    pub extensible: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Role {
    pub kind: RoleKind,
    pub required: bool,
    /// A lifecycle role must retain these states and permit no extra transitions.
    pub lifecycle: Option<LifecycleContract>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RoleKind {
    Entity,
    Fact,
    Process,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifecycleContract {
    pub initial: String,
    pub terminals: BTreeSet<String>,
    pub transitions: BTreeSet<(String, String)>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    /// Each archetype has its own role namespace, so composition never silently merges roles.
    pub bindings: BTreeMap<String, BTreeMap<String, String>>,
    pub label: String,
    pub aliases: BTreeSet<String>,
    /// Additional conjunctive contracts; base contracts cannot be overridden.
    pub constraints: BTreeMap<String, Contract>,
    /// Domain-owned declarations added at an explicit extension point.
    pub extensions: BTreeSet<String>,
    /// Application declaration source anchor, kept in the elaboration source map.
    pub source: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Origin {
    pub archetype: Option<String>,
    pub profile: String,
    pub declaration: String,
    pub source: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Elaboration {
    pub concept: ConceptIR,
    /// Multiple roles/profiles may bind the same declaration without losing provenance.
    pub sources: BTreeMap<String, Vec<Origin>>,
    pub outputs: BTreeMap<String, BTreeSet<String>>,
}
fn anchor(profile: &str, base: &str, name: &str) -> String {
    // JSON-pointer escaping makes this injective even for URL-shaped identities.
    let escape = |s: &str| s.replace('~', "~0").replace('/', "~1");
    format!(
        "@profile/{}/{}/{}",
        escape(profile),
        escape(base),
        escape(name)
    )
}
fn problem(errors: &mut Vec<Violation>, subject: &str, message: &str) {
    errors.push(Violation {
        code: "E-L0-ARCHETYPE".into(),
        subject: subject.into(),
        message: message.into(),
    });
}
fn owner(contract: &Contract) -> (&str, RoleKind) {
    match &contract.owner {
        ContractOwner::Entity { id } => (id, RoleKind::Entity),
        ContractOwner::Fact { id } => (id, RoleKind::Fact),
        ContractOwner::Process { id } => (id, RoleKind::Process),
    }
}
impl ConceptIR {
    fn role_exists(&self, target: &str, kind: &RoleKind) -> bool {
        match kind {
            RoleKind::Entity => self.entities.contains_key(target),
            RoleKind::Fact => self.facts.contains_key(target),
            RoleKind::Process => self.processes.contains_key(target),
        }
    }
    pub fn validate_archetypes(&self) -> Vec<Violation> {
        if self.archetypes.is_empty() {
            return vec![];
        }
        match self.expand_archetypes() {
            Ok(result) => result.concept.validate(),
            Err(errors) => errors,
        }
    }
    /// Elaborate atomically, reject collisions and validate the ordinary resulting graph.
    pub fn elaborate_archetypes(&self) -> Result<Elaboration, Vec<Violation>> {
        let result = self.expand_archetypes()?;
        let errors = result.concept.validate();
        if errors.is_empty() {
            Ok(result)
        } else {
            Err(errors)
        }
    }
    fn expand_archetypes(&self) -> Result<Elaboration, Vec<Violation>> {
        let mut errors = vec![];
        let mut result = Elaboration {
            concept: self.clone(),
            sources: BTreeMap::new(),
            outputs: BTreeMap::new(),
        };
        result.concept.archetypes = Archetypes::default();
        for (id, base) in &self.archetypes.definitions {
            for endpoints in base.relationships.values() {
                if endpoints.len() < 2 || endpoints.values().any(|r| !base.roles.contains_key(r)) {
                    problem(
                        &mut errors,
                        id,
                        "relationship requires at least two declared role endpoints",
                    );
                }
            }
            for contract in base.contracts.values() {
                let (r, kind) = owner(contract);
                if !base.roles.get(r).is_some_and(|role| role.kind == kind) {
                    problem(
                        &mut errors,
                        id,
                        "contract owner must name a role of the matching kind",
                    );
                }
            }
            if !base.outputs.iter().all(|r| base.roles.contains_key(r)) {
                problem(&mut errors, id, "output must name a declared role");
            }
            for role in base.roles.values() {
                if role.lifecycle.is_some() && role.kind != RoleKind::Entity {
                    problem(&mut errors, id, "lifecycle requires an entity role");
                }
            }
        }
        for (pid, profile) in &self.archetypes.profiles {
            if profile.bindings.is_empty() || profile.source.is_empty() {
                problem(
                    &mut errors,
                    pid,
                    "profile requires a base binding and source anchor",
                );
            }
            for (bid, bindings) in &profile.bindings {
                let Some(base) = self.archetypes.definitions.get(bid) else {
                    problem(&mut errors, pid, "unknown archetype");
                    continue;
                };
                if !base.extensible && !profile.extensions.is_empty() {
                    problem(
                        &mut errors,
                        pid,
                        "base archetype does not permit extensions",
                    );
                }
                for r in bindings.keys() {
                    if !base.roles.contains_key(r) {
                        problem(&mut errors, pid, "unknown role binding");
                    }
                }
                for (r, role) in &base.roles {
                    let Some(target) = bindings.get(r) else {
                        if role.required {
                            problem(&mut errors, pid, "missing required role binding");
                        }
                        continue;
                    };
                    if !self.role_exists(target, &role.kind) {
                        problem(
                            &mut errors,
                            pid,
                            "role binding has an unknown target or wrong declaration kind",
                        );
                    }
                    result
                        .sources
                        .entry(target.clone())
                        .or_default()
                        .push(Origin {
                            archetype: Some(bid.clone()),
                            profile: pid.clone(),
                            declaration: r.clone(),
                            source: profile.source.clone(),
                        });
                    if let Some(expected) = &role.lifecycle {
                        match self.entities.get(target).and_then(|e| e.lifecycle.as_ref()) {
                            Some(actual)
                                if actual.initial == expected.initial
                                    && actual.states.contains(&expected.initial)
                                    && expected
                                        .terminals
                                        .iter()
                                        .all(|t| actual.states.contains(t))
                                    && actual.transitions.iter().all(|t| {
                                        !t.from.iter().any(|f| actual.terminals.contains(f))
                                    })
                                    && expected
                                        .terminals
                                        .is_subset(&actual.terminals.iter().cloned().collect())
                                    && expected.transitions.iter().all(|(a, b)| {
                                        actual.states.contains(a) && actual.states.contains(b)
                                    })
                                    && actual.transitions.iter().all(|t| {
                                        t.from.iter().all(|f| {
                                            expected
                                                .transitions
                                                .contains(&(f.clone(), t.to.clone()))
                                        })
                                    }) => {}
                            _ => problem(
                                &mut errors,
                                pid,
                                "lifecycle binding weakens or omits the base contract",
                            ),
                        }
                    }
                }
                for (name, endpoints) in &base.relationships {
                    let mut bound = BTreeMap::new();
                    for (endpoint, role) in endpoints {
                        if let Some(target) = bindings.get(role) {
                            bound.insert(
                                endpoint.clone(),
                                Endpoint {
                                    target: target.clone(),
                                    field: None,
                                },
                            );
                        } else {
                            problem(
                                &mut errors,
                                pid,
                                "relationship requires its optional role to be bound",
                            );
                        }
                    }
                    let id = anchor(pid, bid, name);
                    if result
                        .concept
                        .semantics
                        .relationships
                        .insert(
                            id.clone(),
                            Relationship {
                                carrier: None,
                                endpoints: bound,
                                evidence: BTreeSet::new(),
                            },
                        )
                        .is_some()
                    {
                        problem(
                            &mut errors,
                            pid,
                            "elaborated relationship collides with an existing declaration",
                        );
                    }
                    result.sources.entry(id).or_default().push(Origin {
                        archetype: Some(bid.clone()),
                        profile: pid.clone(),
                        declaration: name.clone(),
                        source: profile.source.clone(),
                    });
                }
                for (name, contract) in &base.contracts {
                    let (role, _) = owner(contract);
                    let Some(target) = bindings.get(role) else {
                        problem(
                            &mut errors,
                            pid,
                            "contract requires its optional owner role to be bound",
                        );
                        continue;
                    };
                    let mut bound = contract.clone();
                    match &mut bound.owner {
                        ContractOwner::Entity { id }
                        | ContractOwner::Fact { id }
                        | ContractOwner::Process { id } => *id = target.clone(),
                    }
                    let id = anchor(pid, bid, name);
                    if result
                        .concept
                        .semantics
                        .contracts
                        .insert(id.clone(), bound)
                        .is_some()
                    {
                        problem(
                            &mut errors,
                            pid,
                            "elaborated contract collides with an existing declaration",
                        );
                    }
                    result.sources.entry(id).or_default().push(Origin {
                        archetype: Some(bid.clone()),
                        profile: pid.clone(),
                        declaration: name.clone(),
                        source: profile.source.clone(),
                    });
                }
                for r in &base.outputs {
                    if let Some(target) = bindings.get(r) {
                        result
                            .outputs
                            .entry(pid.clone())
                            .or_default()
                            .insert(target.clone());
                    } else {
                        problem(
                            &mut errors,
                            pid,
                            "output requires its optional role to be bound",
                        );
                    }
                }
            }
            for (name, contract) in &profile.constraints {
                let id = anchor(pid, "constraints", name);
                if result
                    .concept
                    .semantics
                    .contracts
                    .insert(id.clone(), contract.clone())
                    .is_some()
                {
                    problem(
                        &mut errors,
                        pid,
                        "additional constraint collides with an inherited contract",
                    );
                }
                result.sources.entry(id).or_default().push(Origin {
                    archetype: None,
                    profile: pid.clone(),
                    declaration: name.clone(),
                    source: profile.source.clone(),
                });
            }
            for target in &profile.extensions {
                if ![RoleKind::Entity, RoleKind::Fact, RoleKind::Process]
                    .iter()
                    .any(|kind| self.role_exists(target, kind))
                    && !self.policies.contains_key(target)
                    && !self.semantics.relationships.contains_key(target)
                    && !self.semantics.contracts.contains_key(target)
                {
                    problem(
                        &mut errors,
                        pid,
                        "extension must reference a domain declaration",
                    );
                }
                result
                    .sources
                    .entry(target.clone())
                    .or_default()
                    .push(Origin {
                        archetype: None,
                        profile: pid.clone(),
                        declaration: target.clone(),
                        source: profile.source.clone(),
                    });
            }
        }
        if errors.is_empty() {
            Ok(result)
        } else {
            Err(errors)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProfileChangeKind {
    DisplayRename,
    RoleRebinding,
    AddedExtension,
    StrengthenedConstraint,
    BrokenContract,
    LifecycleBinding,
    Composition,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileChange {
    pub subject: String,
    pub kind: ProfileChangeKind,
}
impl ConceptIR {
    /// Conservative classification: changing/removing a predicate is never presumed stronger.
    pub fn archetype_changes(&self, next: &Self) -> Vec<ProfileChange> {
        let mut changes = vec![];
        let mut add = |subject: &str, kind| {
            changes.push(ProfileChange {
                subject: subject.into(),
                kind,
            })
        };
        for (id, before) in &self.archetypes.definitions {
            let Some(after) = next.archetypes.definitions.get(id) else {
                add(id, ProfileChangeKind::BrokenContract);
                continue;
            };
            if before != after {
                let mut structural_before = before.clone();
                let mut structural_after = after.clone();
                structural_before.contracts.clear();
                structural_after.contracts.clear();
                if structural_before != structural_after
                    || before
                        .contracts
                        .iter()
                        .any(|(k, v)| after.contracts.get(k) != Some(v))
                {
                    add(id, ProfileChangeKind::BrokenContract);
                } else {
                    add(id, ProfileChangeKind::StrengthenedConstraint);
                }
            }
        }
        for (id, before) in &self.archetypes.profiles {
            let Some(after) = next.archetypes.profiles.get(id) else {
                add(id, ProfileChangeKind::BrokenContract);
                continue;
            };
            if before.label != after.label || before.aliases != after.aliases {
                add(id, ProfileChangeKind::DisplayRename);
            }
            if before.bindings != after.bindings {
                add(id, ProfileChangeKind::RoleRebinding);
            }
            if before
                .constraints
                .iter()
                .any(|(k, v)| after.constraints.get(k) != Some(v))
                || !before.extensions.is_subset(&after.extensions)
            {
                add(id, ProfileChangeKind::BrokenContract);
            }
            if after
                .constraints
                .keys()
                .any(|k| !before.constraints.contains_key(k))
            {
                add(id, ProfileChangeKind::StrengthenedConstraint);
            }
            if !after.extensions.is_subset(&before.extensions) {
                add(id, ProfileChangeKind::AddedExtension);
            }
            for bindings in before.bindings.values() {
                for target in bindings.values() {
                    if self.entities.get(target).and_then(|e| e.lifecycle.as_ref())
                        != next.entities.get(target).and_then(|e| e.lifecycle.as_ref())
                    {
                        add(id, ProfileChangeKind::LifecycleBinding);
                    }
                }
            }
        }
        for id in next.archetypes.profiles.keys() {
            if !self.archetypes.profiles.contains_key(id) {
                add(id, ProfileChangeKind::Composition);
            }
        }
        changes
    }
}
