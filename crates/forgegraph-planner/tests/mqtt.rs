use forgegraph_semantic::{Package, compile};
#[test]
fn mqtt_plan_preserves_profile_and_explicit_connector_execution() {
    let pkg = Package::inline(
        "@test/mqtt",
        vec![(
            "src/main.forge".into(),
            "channel Events\n@mqtt(\"forge/events\")\n{ message Changed { value : text } }\n"
                .into(),
        )],
    );
    let result = compile(&pkg, &[]);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let plan = forgegraph_planner::plan(&result.ir.unwrap()).unwrap();
    let mqtt = plan.messaging.channels[0].mqtt.as_ref().unwrap();
    assert_eq!(mqtt.prefix, "forge/events");
    assert_eq!(mqtt.qos, 1);
    assert!(!mqtt.retain);
    assert_eq!(mqtt.max_payload_bytes, 65536);
    assert_eq!(mqtt.execution, "external-broker-connector");
}
