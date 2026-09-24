use forgegraph_semantic::concept::{ConceptIR, project};
use forgegraph_semantic::{Package, compile, load_package};
use serde_json::{Value, json};
use std::path::PathBuf;
fn model() -> Value {
    let mut c: Value = serde_json::from_str(include_str!(
        "../../../examples/concept/interactions/support.json"
    ))
    .unwrap();
    let p = "@interaction/support/_/";
    let mut agent = c["entities"][format!("{p}Customer")].clone();
    agent["name"] = json!("SoftwareAgent");
    c["entities"][format!("{p}SoftwareAgent")] = agent;
    c["semantics"]["subjects"][format!("{p}AgentIdentity")] =
        json!({"carrier":format!("{p}SoftwareAgent"),"profiles":["software-agent"]});
    c["principals"][format!("{p}ServicePrincipal")] =
        json!({"name":"ServicePrincipal","attributes":{}});
    let entity_ref = |name: &str| json!({"base":{"kind":"entity","id":format!("{p}{name}"),"representation":"reference"},"optional":false,"constraints":[],"normalizers":[],"dataClass":null,"purpose":null});
    let field = |ty: Value| json!({"ty":ty,"immutable":true,"default":null,"derived":null});
    let mut principal = entity_ref("ServicePrincipal");
    principal["base"] = json!({"kind":"principal","id":format!("{p}ServicePrincipal")});
    c["facts"][format!("{p}Representation")] = json!({"name":"Representation","fields":{"principal":field(principal),"actor":field(entity_ref("SoftwareAgent")),"scope":field(entity_ref("Conversation"))}});
    c["semantics"]["relationships"][format!("{p}Represents")] = json!({"carrier":format!("{p}Representation"),"endpoints":{"principal":{"target":format!("{p}ServicePrincipal"),"field":"principal"},"actor":{"target":format!("{p}SoftwareAgent"),"field":"actor"},"scope":{"target":format!("{p}Conversation"),"field":"scope"}},"evidence":[]});
    c["semantics"]["representations"][format!("{p}ScopedRepresentation")] = json!({"relationship":format!("{p}Represents"),"principalRole":"principal","subjectRole":"actor","scopeRoles":["scope"]});
    for name in ["Delegation", "Attestation"] {
        c["facts"][format!("{p}{name}")] = json!({"name":name,"fields":{"issuer":field(entity_ref("SoftwareAgent")),"subject":field(entity_ref("Customer"))}});
        c["semantics"]["relationships"][format!("{p}{name}Roles")] = json!({"carrier":format!("{p}{name}"),"endpoints":{"issuer":{"target":format!("{p}SoftwareAgent"),"field":"issuer"},"subject":{"target":format!("{p}Customer"),"field":"subject"}},"evidence":[]});
    }
    c
}
#[test]
fn subjects_are_typed_scoped_and_distinct_from_principals() {
    let raw = model();
    let c = ConceptIR::load_closed(&raw).unwrap();
    assert_eq!(
        c.graph().nodes["@interaction/support/_/ParticipantIdentity"],
        "subject"
    );
    for (field, value) in [
        ("subjectRole", json!("principal")),
        ("scopeRoles", json!(["actor"])),
        ("principalRole", json!("missing")),
    ] {
        let mut changed = raw.clone();
        changed["semantics"]["representations"]["@interaction/support/_/ScopedRepresentation"]
            [field] = value;
        assert!(
            ConceptIR::load(&changed)
                .unwrap_err()
                .contains("E-L0-SUBJECT")
        );
    }
    let mut changed = raw.clone();
    changed["semantics"]["subjects"]["@interaction/support/_/ParticipantIdentity"]["carrier"] =
        json!("@interaction/support/_/ServicePrincipal");
    assert!(
        ConceptIR::load(&changed)
            .unwrap_err()
            .contains("E-L0-SUBJECT")
    );
    let mut agent = raw;
    agent["semantics"]["subjects"]["@interaction/support/_/ParticipantIdentity"]["profiles"] =
        json!(["software-agent"]);
    assert!(ConceptIR::load_closed(&agent).is_ok());
}
#[test]
fn compiled_foundation_participation_accepts_subject_and_interaction_facets() {
    let root =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/foundation/participation");
    let identifiers = compile(&load_package(&root.join("../identifiers")).unwrap(), &[])
        .ir
        .unwrap();
    let party = compile(
        &load_package(&root.join("../party")).unwrap(),
        &[&identifiers],
    )
    .ir
    .unwrap();
    let foundation = compile(&load_package(&root).unwrap(), &[&party, &identifiers])
        .ir
        .unwrap();
    let mut consumer=Package::inline("@test/subjects",vec![("src/main.forge".into(),"import participation\nimport party\nresource SoftwareAgent { id : id\n identity : party.Party }\nresource Person { id : id\n identity : party.Party }\nresource Engagement { id : id\n participants : participation.ParticipationSet\n startedAt : datetime\n endedAt : datetime? }\nresource Membership { id : id\n participation : participation.Participation\n participant : party.Party\n context : Engagement }\n".into())]);
    consumer.edition = "2027".into();
    consumer.profile = foundation.package.profile.clone();
    consumer.targets = foundation.package.targets.clone();
    consumer
        .dependencies
        .push(("participation".into(), foundation.package.name.clone()));
    consumer
        .dependencies
        .push(("party".into(), party.package.name.clone()));
    let compiled = compile(&consumer, &[&foundation, &party, &identifiers]);
    assert!(compiled.ir.is_some(), "{}", compiled.render());
    let assembled = forgegraph_semantic::assembly::assemble(
        compiled.ir.as_ref().unwrap(),
        &[foundation, party, identifiers],
    )
    .unwrap();
    let c = project(&assembled).concept;
    let mut raw = serde_json::to_value(c).unwrap();
    let participant = raw["entities"]
        .as_object()
        .unwrap()
        .keys()
        .find(|k| k.ends_with("/Party"))
        .unwrap()
        .clone();
    let context = raw["entities"]
        .as_object()
        .unwrap()
        .keys()
        .find(|k| k.ends_with("/Engagement"))
        .unwrap()
        .clone();
    let participation = raw["entities"]
        .as_object()
        .unwrap()
        .keys()
        .find(|k| k.ends_with("/Membership"))
        .unwrap()
        .clone();
    raw["semantics"]["subjects"] =
        json!({"ActorIdentity":{"carrier":participant,"profiles":["actor"]}});
    raw["semantics"]["relationships"] = json!({"Participants":{"carrier":participation,"endpoints":{"actor":{"target":participant,"field":"participant"},"context":{"target":context,"field":"context"}},"evidence":[]}});
    raw["semantics"]["temporal"][&context] =
        json!({"occurrence":null,"valid":{"from":"startedAt","to":"endedAt"},"knowledge":null});
    raw["semantics"]["interactions"] = json!({"Engagement":{"carrier":context,"participation":["Participants"],"events":{},"processes":{},"parent":null,"purpose":null}});
    ConceptIR::load_closed(&raw).unwrap();
}
