use super::*;
use std::{
    fs,
    path::{Path, PathBuf},
};
fn files(path: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in fs::read_dir(path).unwrap() {
        let p = entry.unwrap().path();
        if p.is_dir() {
            if p.file_name().unwrap() != "generated" {
                out.extend(files(&p));
            }
        } else if p.extension().is_some_and(|x| x == "forge") {
            out.push(p);
        }
    }
    out.sort();
    out
}
fn parser() -> tree_sitter::Parser {
    let mut p = tree_sitter::Parser::new();
    p.set_language(&LANGUAGE.into()).unwrap();
    p
}
#[test]
fn shared_valid_corpus_and_examples_have_no_syntax_drift() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut corpus = files(&root.join("specs/language/fixtures/valid"));
    corpus.extend(files(&root.join("examples")));
    let mut parser = parser();
    let mut checked = 0;
    for path in corpus {
        let text = fs::read_to_string(&path).unwrap();
        let canonical = forgegraph_syntax::parse(&text);
        assert!(
            canonical.errors().is_empty(),
            "canonical syntax errors in {}: {:?}",
            path.display(),
            canonical.errors()
        );
        let tree = parser.parse(&text, None).unwrap();
        assert!(
            !tree.root_node().has_error(),
            "Tree-sitter drift in {}: {}",
            path.display(),
            tree.root_node().to_sexp()
        );
        checked += 1;
    }
    assert!(checked > 20);
}
#[test]
fn queries_compile() {
    for query in [HIGHLIGHTS, FOLDS, INDENTS, LOCALS, TAGS] {
        tree_sitter::Query::new(&LANGUAGE.into(), query).unwrap();
    }
}
#[test]
fn malformed_files_preserve_a_following_declaration() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut parser = parser();
    for folder in ["invalid", "recovery"] {
        for path in files(&root.join("specs/language/fixtures").join(folder)) {
            let text = fs::read_to_string(path).unwrap();
            assert!(!forgegraph_syntax::parse(&text).errors().is_empty());
            let tree = parser.parse(&text, None).unwrap();
            assert!(tree.root_node().has_error());
            let mut cursor = tree.root_node().walk();
            assert!(tree.root_node().named_children(&mut cursor).any(|node| {
                node.kind() == "resource_declaration"
                    && node
                        .child_by_field_name("name")
                        .is_some_and(|name| name.utf8_text(text.as_bytes()).unwrap() == "Intact")
            }));
        }
    }
}

#[test]
fn edits_reuse_trees_without_changing_the_result() {
    let before = "resource Item {\n title : text\n}\n";
    let after = "resource Item {\n title : text?\n}\n";
    let at = before.find("text").unwrap() + 4;
    let mut parser = parser();
    let mut tree = parser.parse(before, None).unwrap();
    tree.edit(&tree_sitter::InputEdit {
        start_byte: at,
        old_end_byte: at,
        new_end_byte: at + 1,
        start_position: tree_sitter::Point::new(1, 13),
        old_end_position: tree_sitter::Point::new(1, 13),
        new_end_position: tree_sitter::Point::new(1, 14),
    });
    let incremental = parser.parse(after, Some(&tree)).unwrap();
    let clean = parser.parse(after, None).unwrap();
    assert!(!incremental.root_node().has_error());
    assert_eq!(
        incremental.root_node().to_sexp(),
        clean.root_node().to_sexp()
    );
}

#[test]
fn query_captures_identify_fields_types_decorators_and_tags() {
    use tree_sitter::StreamingIterator;
    let text = "/// Item\nresource Item @tenant {\n title : text\n}\n";
    let tree = parser().parse(text, None).unwrap();
    for (source, expected) in [
        (
            HIGHLIGHTS,
            vec![
                ("attribute", "tenant"),
                ("type", "text"),
                ("variable.member", "title"),
                ("comment.documentation", "/// Item"),
            ],
        ),
        (TAGS, vec![("name", "Item"), ("name", "title")]),
    ] {
        let query = tree_sitter::Query::new(&LANGUAGE.into(), source).unwrap();
        let mut cursor = tree_sitter::QueryCursor::new();
        let mut captures = cursor.captures(&query, tree.root_node(), text.as_bytes());
        let mut got = Vec::new();
        while let Some((m, i)) = captures.next() {
            let capture = m.captures[*i];
            got.push((
                query.capture_names()[capture.index as usize],
                capture.node.utf8_text(text.as_bytes()).unwrap(),
            ));
        }
        for pair in expected {
            assert!(got.contains(&pair), "missing capture {pair:?}: {got:?}");
        }
    }
}

#[test]
fn runtime_construct_queries_cover_actors_queues_and_map_bindings() {
    use tree_sitter::StreamingIterator;
    let text = include_str!("../../../specs/language/fixtures/valid/runtime-constructs.forge");
    let tree = parser().parse(text, None).unwrap();
    assert!(!tree.root_node().has_error());
    for (source, expected) in [
        (
            HIGHLIGHTS,
            vec![
                ("type", "EvaluationWork"),
                ("type", "EvaluationSession"),
                ("variable", "results"),
                ("variable.parameter", "value"),
                ("keyword", "concurrency"),
                ("keyword", "workQueue"),
                ("keyword", "actor"),
            ],
        ),
        (
            TAGS,
            vec![
                ("name", "EvaluationWork"),
                ("name", "EvaluationSession"),
                ("name", "results"),
            ],
        ),
        (
            LOCALS,
            vec![
                ("local.definition", "value"),
                ("local.definition", "results"),
            ],
        ),
    ] {
        let query = tree_sitter::Query::new(&LANGUAGE.into(), source).unwrap();
        let mut cursor = tree_sitter::QueryCursor::new();
        let mut captures = cursor.captures(&query, tree.root_node(), text.as_bytes());
        let mut got = Vec::new();
        while let Some((m, i)) = captures.next() {
            let c = m.captures[*i];
            got.push((
                query.capture_names()[c.index as usize],
                c.node.utf8_text(text.as_bytes()).unwrap(),
            ));
        }
        for capture in expected {
            assert!(got.contains(&capture), "missing {capture:?}: {got:?}");
        }
    }
    let query = tree_sitter::Query::new(&LANGUAGE.into(), FOLDS).unwrap();
    let mut cursor = tree_sitter::QueryCursor::new();
    let mut captures = cursor.captures(&query, tree.root_node(), text.as_bytes());
    let mut folded = Vec::new();
    while let Some((m, i)) = captures.next() {
        folded.push(m.captures[*i].node.kind());
    }
    for kind in ["actor_declaration", "work_queue_declaration", "step_map"] {
        assert!(folded.contains(&kind));
    }
}
