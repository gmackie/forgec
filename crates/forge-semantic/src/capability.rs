//! Capability algebra (plan §8.3, FORGE-042/043). For a resource-local
//! fragment C: allowClosure(C) = local allows ∪ included allowClosures;
//! denyClosure(C) = local denies ∪ included denyClosures; surface(C) =
//! allowClosure − denyClosure. The deny closure is kept after flattening so
//! no other inclusion reintroduces a prohibited atom; the result is
//! independent of declaration order. A purpose has a surface only through an
//! explicit `for Purpose { use C }` binding: taxonomy `extends` grants nothing.
use crate::ir::*;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

pub const VERBS: &[&str] = &["read", "create", "update", "filter", "order", "actions"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Atom {
    pub verb: String,
    pub name: String,
    /// Inclusion path from the bound capability down to the fragment that declared the atom.
    pub origin: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Surface {
    pub resource: String,
    pub purpose: String,
    pub capabilities: Vec<String>,
    pub allow_atoms: Vec<Atom>,
    pub deny: Vec<Atom>,
    /// SHA-256 over the canonical (verb, name) allow set: two surfaces with equal digests are interchangeable.
    pub digest: String,
}

impl Surface {
    pub fn allow(&self, verb: &str) -> Vec<String> {
        self.allow_atoms.iter().filter(|a| a.verb == verb).map(|a| a.name.clone()).collect()
    }
    pub fn permits(&self, verb: &str, name: &str) -> bool {
        self.allow_atoms.iter().any(|a| a.verb == verb && a.name == name)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveCapabilities {
    pub version: String,
    pub surfaces: Vec<Surface>,
}

struct Closure {
    allow: BTreeMap<(String, String), Vec<String>>,
    deny: BTreeMap<(String, String), Vec<String>>,
}

fn closure(r: &Resource, name: &str, path: &mut Vec<String>, memo: &mut BTreeMap<String, Closure>) -> Closure {
    if let Some(c) = memo.get(name) {
        return Closure { allow: c.allow.clone(), deny: c.deny.clone() };
    }
    let Some(cap) = r.capabilities.iter().find(|c| c.name == name) else { return Closure { allow: BTreeMap::new(), deny: BTreeMap::new() } };
    path.push(name.to_string());
    let mut allow: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
    let mut deny: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
    for a in &cap.atoms {
        for n in &a.names {
            let target = if a.deny { &mut deny } else { &mut allow };
            target.entry((a.verb.clone(), n.clone())).or_insert_with(|| path.clone());
        }
    }
    let mut includes = cap.includes.clone();
    includes.sort();
    for inc in includes {
        if path.contains(&inc) {
            continue; // cycles are diagnosed by the compiler; never recurse into them
        }
        let sub = closure(r, &inc, path, memo);
        for (k, origin) in sub.allow {
            allow.entry(k).or_insert(origin);
        }
        for (k, origin) in sub.deny {
            deny.entry(k).or_insert(origin);
        }
    }
    path.pop();
    memo.insert(name.to_string(), Closure { allow: allow.clone(), deny: deny.clone() });
    Closure { allow, deny }
}

impl EffectiveCapabilities {
    pub fn of(ir: &DomainIR) -> EffectiveCapabilities {
        let mut surfaces = Vec::new();
        for m in &ir.modules {
            for r in &m.resources {
                // One surface per bound purpose; several `use` lines for one purpose union their closures.
                let mut by_purpose: BTreeMap<String, Vec<String>> = BTreeMap::new();
                for b in &r.purpose_bindings {
                    by_purpose.entry(b.purpose.clone()).or_default().push(b.capability.clone());
                }
                for (purpose, caps) in by_purpose {
                    let mut memo = BTreeMap::new();
                    let mut allow: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
                    let mut deny: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
                    let mut sorted = caps.clone();
                    sorted.sort();
                    for c in &sorted {
                        let cl = closure(r, c, &mut Vec::new(), &mut memo);
                        for (k, o) in cl.allow {
                            allow.entry(k).or_insert(o);
                        }
                        for (k, o) in cl.deny {
                            deny.entry(k).or_insert(o);
                        }
                    }
                    let allow_atoms: Vec<Atom> = allow.iter().filter(|(k, _)| !deny.contains_key(*k)).map(|((v, n), o)| Atom { verb: v.clone(), name: n.clone(), origin: o.clone() }).collect();
                    let deny_atoms: Vec<Atom> = deny.iter().map(|((v, n), o)| Atom { verb: v.clone(), name: n.clone(), origin: o.clone() }).collect();
                    let canonical: BTreeSet<String> = allow_atoms.iter().map(|a| format!("{}:{}", a.verb, a.name)).collect();
                    let digest = hash_hex(&format!("forge:surface:{}:{}:{}", r.id, purpose, canonical.into_iter().collect::<Vec<_>>().join(",")));
                    surfaces.push(Surface { resource: r.id.clone(), purpose, capabilities: sorted, allow_atoms, deny: deny_atoms, digest });
                }
            }
        }
        EffectiveCapabilities { version: "capabilities/1".into(), surfaces }
    }
    pub fn surface(&self, resource: &str, purpose: &str) -> Option<&Surface> {
        self.surfaces.iter().find(|s| s.resource == resource && s.purpose == purpose)
    }
}

/// Inclusion cycles (E-GOV-009): a fragment reachable from itself.
pub fn inclusion_cycles(r: &Resource) -> Vec<String> {
    let mut out = Vec::new();
    for c in &r.capabilities {
        let mut stack = vec![c.name.clone()];
        let mut seen = BTreeSet::new();
        while let Some(n) = stack.pop() {
            if let Some(cap) = r.capabilities.iter().find(|x| x.name == n) {
                for inc in &cap.includes {
                    if inc == &c.name {
                        out.push(c.name.clone());
                        stack.clear();
                        break;
                    }
                    if seen.insert(inc.clone()) {
                        stack.push(inc.clone());
                    }
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}
