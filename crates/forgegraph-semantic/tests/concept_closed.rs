use forgegraph_semantic::concept::*;
use serde_json::{Value, json};

fn model() -> Value {
    json!({"version":"concept-ir/2","package":"closure","entities":{},"facts":{},
        "externals":{"io":{"name":"IO","data":{"value":ty()},"accepts":{"value":ty()},"events":["tick"]}},
        "principals":{},"policies":{},"purposes":{},"dataClasses":{},"shapes":{},"enums":{},
        "processes":{"run":{"name":"Run","purpose":null,"principal":null,"authorizations":[],
            "activations":{},"inputs":{},"outputs":{},"behavior":null}}})
}
fn ty() -> Value {
    json!({"base":{"kind":"scalar","name":"String","args":[]},"optional":false,
        "constraints":[],"normalizers":[],"dataClass":null,"purpose":null})
}
fn rejected(raw: Value, subject: &str, message: &str) {
    let partial = ConceptIR::load(&raw).expect("partial loading must remain supported");
    let errors = partial.validate_closed();
    assert!(
        errors
            .iter()
            .any(|e| e.subject == subject && e.message.contains(message)),
        "{errors:?}"
    );
    assert!(ConceptIR::load_closed(&raw).is_err());
}
#[test]
fn activation_closure_is_opt_in_and_graph_nodes_are_not_declarations() {
    assert!(ConceptIR::load_closed(&model()).is_ok());
    for (activation, message) in [
        (json!({"kind":"fact","fact":"missing"}), "activation fact"),
        (
            json!({"kind":"change","entity":"missing"}),
            "activation entity",
        ),
        (
            json!({"kind":"externalEvent","external":"io","event":"missing"}),
            "external event",
        ),
    ] {
        let mut raw = model();
        raw["processes"]["run"]["activations"]["start"] = activation;
        if message == "activation fact" {
            assert_eq!(
                ConceptIR::load(&raw).unwrap().graph().nodes["missing"],
                "reference"
            );
        }
        rejected(raw, "start", message);
    }
}
#[test]
fn recursively_closes_payload_types_and_facets() {
    for family in ["principal", "entity", "fact", "shape", "enum"] {
        let mut element = ty();
        element["base"] = json!({"kind":family,"id":"missing"});
        if family == "entity" {
            element["base"]["representation"] = json!("reference");
        }
        let mut nested = ty();
        nested["base"] = json!({"kind":"collection","collection":"list","element":element});
        let mut raw = model();
        raw["processes"]["run"]["activations"]["request"] =
            json!({"kind":"request","payload":nested});
        rejected(raw, "request", family);
    }
    for (facet, message) in [("purpose", "purpose"), ("dataClass", "data class")] {
        let mut payload = ty();
        payload[facet] = json!("missing");
        let mut raw = model();
        raw["processes"]["run"]["activations"]["request"] =
            json!({"kind":"request","payload":payload});
        rejected(raw, "request", message);
    }
}
#[test]
fn external_ports_require_full_type_equality() {
    let mut raw = model();
    raw["processes"]["run"]["inputs"]["read"] = json!({"ty":ty(),"origin":{"kind":"external","external":"io"},
        "selection":{"cardinality":"one","forBinding":null,"predicate":null,"during":null,"asOf":null},"authorization":null});
    raw["processes"]["run"]["outputs"]["write"] =
        json!({"ty":ty(),"disposition":{"kind":"export","external":"io"}});
    assert!(ConceptIR::load_closed(&raw).is_ok());
    for (direction, port, message) in [
        ("inputs", "read", "external input type"),
        ("outputs", "write", "external output type"),
    ] {
        let mut changed = raw.clone();
        changed["processes"]["run"][direction][port]["ty"]["optional"] = json!(true);
        rejected(changed, port, message);
    }
}
#[test]
fn closes_behavior_and_principal_attribute_types() {
    let mut raw = model();
    raw["processes"]["run"]["behavior"] =
        json!({"workflow":{"waits":{"wait":"missing"}},"stateMachine":null,"stateful":null});
    rejected(raw, "wait", "workflow fact");
    let mut raw = model();
    let mut unknown = ty();
    unknown["base"] = json!({"kind":"shape","id":"missing"});
    raw["principals"]["actor"] = json!({"name":"Actor","attributes":{"profile":unknown}});
    rejected(raw, "profile", "shape");
}
