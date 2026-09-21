//! PAR-174: adversarial fuzz of the capability algebra. Random capability
//! DAGs (inclusions, allows, sticky denies) are generated as Forge source,
//! compiled, and the effective surfaces are compared with an independent
//! reference computation (set semantics over the inclusion graph). Every
//! DAG is also compiled with its declarations and inclusion lists permuted:
//! no composition order or traversal path may widen the effective authority,
//! and denies remain sticky through every re-inclusion path.
use forge_semantic::ir::EffectiveCapabilities;
use forge_semantic::{compile, Package};
use std::collections::{BTreeMap, BTreeSet};

/// Small deterministic PRNG (xorshift) so failures reproduce from the seed.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn chance(&mut self, pct: u64) -> bool {
        self.next() % 100 < pct
    }
}

const FIELDS: &[&str] = &["id", "name", "email", "notes", "tier"];
const VERBS: &[&str] = &["read", "update", "filter", "order", "create"];

#[derive(Clone, Debug)]
struct Cap {
    name: String,
    includes: Vec<String>,
    allow: BTreeSet<(String, String)>,
    deny: BTreeSet<(String, String)>,
}

fn random_dag(rng: &mut Rng, n: usize) -> Vec<Cap> {
    let mut caps = Vec::new();
    for i in 0..n {
        let name = format!("C{i}");
        // include only earlier capabilities: acyclic by construction
        let mut includes = Vec::new();
        for j in 0..i {
            if rng.chance(45) {
                includes.push(format!("C{j}"));
            }
        }
        let mut allow = BTreeSet::new();
        let mut deny = BTreeSet::new();
        for _ in 0..rng.below(5) {
            allow.insert((VERBS[rng.below(VERBS.len())].to_string(), FIELDS[rng.below(FIELDS.len())].to_string()));
        }
        for _ in 0..rng.below(3) {
            if rng.chance(50) {
                deny.insert((VERBS[rng.below(VERBS.len())].to_string(), FIELDS[rng.below(FIELDS.len())].to_string()));
            }
        }
        caps.push(Cap { name, includes, allow, deny });
    }
    caps
}

/// Reference algebra: allowClosure − denyClosure over the transitive inclusion graph, order-free by construction.
fn reference(caps: &[Cap], root: &str) -> (BTreeSet<(String, String)>, BTreeSet<(String, String)>) {
    let by: BTreeMap<&str, &Cap> = caps.iter().map(|c| (c.name.as_str(), c)).collect();
    let mut seen = BTreeSet::new();
    let mut stack = vec![root.to_string()];
    let mut allow = BTreeSet::new();
    let mut deny = BTreeSet::new();
    while let Some(n) = stack.pop() {
        if !seen.insert(n.clone()) {
            continue;
        }
        let c = by[n.as_str()];
        allow.extend(c.allow.iter().cloned());
        deny.extend(c.deny.iter().cloned());
        stack.extend(c.includes.iter().cloned());
    }
    (allow.difference(&deny).cloned().collect(), deny)
}

fn render(caps: &[Cap], order: &[usize], include_perm: bool, rng: &mut Rng) -> String {
    let mut s = String::from("purpose P\nexport resource Contact\n  @purposeScoped\n{\n  id : id\n  name : text\n  email : text\n  notes : text?\n  tier : text\n\n");
    for &i in order {
        let c = &caps[i];
        s.push_str(&format!("  capability {} {{\n", c.name));
        let mut inc = c.includes.clone();
        if include_perm {
            for k in (1..inc.len()).rev() {
                let j = rng.below(k + 1);
                inc.swap(k, j);
            }
        }
        for x in &inc {
            s.push_str(&format!("    includes {x}\n"));
        }
        let mut by_verb: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for (v, f) in &c.allow {
            by_verb.entry(v.as_str()).or_default().push(f.as_str());
        }
        for (v, fs) in by_verb {
            s.push_str(&format!("    {v} {{ {} }}\n", fs.join(" ")));
        }
        let mut dby: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for (v, f) in &c.deny {
            dby.entry(v.as_str()).or_default().push(f.as_str());
        }
        for (v, fs) in dby {
            s.push_str(&format!("    deny {v} {{ {} }}\n", fs.join(" ")));
        }
        s.push_str("  }\n\n");
    }
    let root = &caps[caps.len() - 1].name;
    s.push_str(&format!("  for P {{ use {root} }}\n}}\n"));
    s
}

fn surface_of(src: &str) -> Option<(BTreeSet<(String, String)>, BTreeSet<(String, String)>, String)> {
    let mut pkg = Package::inline("@fuzz/cap", vec![("src/a.forge".to_string(), src.to_string())]);
    pkg.edition = "2027".into();
    let out = compile(&pkg, &[]);
    if out.diagnostics.iter().any(|d| d.severity == forge_semantic::Severity::Error) {
        return None;
    }
    let ir = out.ir?;
    let eff = EffectiveCapabilities::of(&ir);
    let s = eff.surface("@fuzz/cap/_/Contact", "@fuzz/cap/_/P")?;
    Some((s.allow_atoms.iter().map(|a| (a.verb.clone(), a.name.clone())).collect(), s.deny.iter().map(|a| (a.verb.clone(), a.name.clone())).collect(), s.digest.clone()))
}

#[test]
fn random_capability_dags_match_the_reference_algebra_under_every_permutation() {
    let mut rng = Rng(0x9E3779B97F4A7C15);
    let mut checked = 0;
    for case in 0..150 {
        let n = 2 + rng.below(6);
        let caps = random_dag(&mut rng, n);
        let (ref_allow, ref_deny) = reference(&caps, &caps[n - 1].name);
        let order: Vec<usize> = (0..n).collect();
        let src = render(&caps, &order, false, &mut rng);
        let Some((allow, deny, digest)) = surface_of(&src) else {
            panic!("case {case}: generated source did not compile:\n{src}");
        };
        assert_eq!(allow, ref_allow, "case {case}: effective allow set differs from the reference algebra\n{src}");
        assert!(ref_deny.is_subset(&deny), "case {case}: a deny was lost during flattening\n{src}");
        // permutations of declaration order and inclusion lists: identical surface, identical digest
        for _ in 0..3 {
            let mut perm = order.clone();
            for k in (1..perm.len()).rev() {
                let j = rng.below(k + 1);
                perm.swap(k, j);
            }
            let src2 = render(&caps, &perm, true, &mut rng);
            let (allow2, _, digest2) = surface_of(&src2).unwrap_or_else(|| panic!("case {case}: permuted source did not compile:\n{src2}"));
            assert_eq!(allow2, allow, "case {case}: declaration/inclusion order changed the surface\n{src2}");
            assert_eq!(digest2, digest, "case {case}: digest not order-independent");
            checked += 1;
        }
        // adversarial widening attempt: a wrapper that re-includes everything and re-allows every denied atom
        let mut wrapper = caps.clone();
        let mut w = Cap { name: format!("W{n}"), includes: caps.iter().map(|c| c.name.clone()).collect(), allow: BTreeSet::new(), deny: BTreeSet::new() };
        for d in &ref_deny {
            w.allow.insert(d.clone());
        }
        wrapper.push(w);
        let src3 = render(&wrapper, &(0..=n).collect::<Vec<_>>(), false, &mut rng);
        let (allow3, _, _) = surface_of(&src3).unwrap_or_else(|| panic!("case {case}: wrapper source did not compile:\n{src3}"));
        for d in &ref_deny {
            assert!(!allow3.contains(d), "case {case}: re-allowing a denied atom through a wrapper widened authority: {d:?}\n{src3}");
        }
        let (ref3, _) = reference(&wrapper, &wrapper[n].name);
        assert_eq!(allow3, ref3, "case {case}: wrapper surface differs from the reference");
    }
    assert!(checked >= 400);
}
