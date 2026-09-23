use forgegraph_semantic::{concept::ConceptIR, concept_realization::*};
use serde_json::json;
fn concept() -> ConceptIR {
    ConceptIR::load_closed(
        &serde_json::from_str(include_str!(
            "../../../examples/concept/interactions/support.json"
        ))
        .unwrap(),
    )
    .unwrap()
}
fn snapshot() -> EngagementSnapshot {
    serde_json::from_value(json!({"engagements":[
        {"id":"case","interaction":"@interaction/support/_/Engagement","startedAt":0,"endedAt":100,"parent":null},
        {"id":"call","interaction":"@interaction/support/_/Engagement","startedAt":10,"endedAt":50,"parent":"case"}],
        "events":[{"id":"message-1","declaration":"@interaction/support/_/MessageReceived","engagement":"call"}],
        "processes":[{"id":"respond-1","declaration":"@interaction/support/_/Respond","engagement":"call"},
        {"id":"respond-1","declaration":"@interaction/support/_/Respond","engagement":"case"}]})).unwrap()
}
#[test]
fn recorded_engagements_validate_without_promoting_declarations_to_proof() {
    let c = concept();
    assert!(c.check_engagement_snapshot(&snapshot()).is_empty());
    let mut cases = vec![];
    let mut s = snapshot();
    s.engagements[0].parent = Some("call".into());
    cases.push(s);
    let mut s = snapshot();
    s.engagements[1].ended_at = Some(0);
    cases.push(s);
    let mut s = snapshot();
    s.engagements[1].parent = Some("missing".into());
    cases.push(s);
    let mut s = snapshot();
    s.engagements[1].id = "case".into();
    cases.push(s);
    let mut s = snapshot();
    s.engagements[1].interaction = "missing".into();
    cases.push(s);
    let mut s = snapshot();
    s.events[0].engagement = "missing".into();
    cases.push(s);
    let mut s = snapshot();
    s.events[0].declaration = "@interaction/support/_/Respond".into();
    cases.push(s);
    let mut s = snapshot();
    s.processes[0].declaration = "@interaction/support/_/MessageReceived".into();
    cases.push(s);
    let mut s = snapshot();
    s.events.push(s.events[0].clone());
    cases.push(s);
    for s in cases {
        assert!(
            !c.check_engagement_snapshot(&s).is_empty(),
            "accepted malformed snapshot"
        );
    }
}

#[test]
fn required_parent_and_end_bindings_are_enforced() {
    let mut c = concept();
    let entity = c
        .entities
        .get_mut("@interaction/support/_/Conversation")
        .unwrap();
    entity.fields.get_mut("parent").unwrap().ty.optional = false;
    entity.fields.get_mut("endedAt").unwrap().ty.optional = false;
    let mut records = snapshot();
    records.engagements[0].ended_at = None;
    let errors = c.check_engagement_snapshot(&records);
    assert!(
        errors
            .iter()
            .any(|e| e.message == "required parent engagement is missing")
    );
    assert!(
        errors
            .iter()
            .any(|e| e.message == "required engagement end is missing")
    );
}
