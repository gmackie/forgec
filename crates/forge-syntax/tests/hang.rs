use forge_syntax::{format, parse};
#[test]
fn unknown_declaration_with_nested_blocks_does_not_hang() {
    let src = "unknownkw X {\n  a : text\n  content {\n    maxBytes 1\n  }\n}\n";
    let parsed = parse(src);
    assert!(!parsed.errors().is_empty());
    assert_eq!(parsed.syntax().text().to_string(), src);
    let _ = format(&parsed);
}
