use forge_syntax::lexer::{TokenKind as T, tokenize};

fn kinds(src: &str) -> Vec<(T, &str)> {
    tokenize(src)
        .into_iter()
        .map(|t| (t.kind, &src[t.range.clone()]))
        .collect()
}

#[test]
fn lexes_a_field_declaration_with_refinements() {
    let src = "code : CustomerCode @unique @immutable";
    assert_eq!(
        kinds(src),
        vec![
            (T::Ident, "code"),
            (T::Whitespace, " "),
            (T::Colon, ":"),
            (T::Whitespace, " "),
            (T::Ident, "CustomerCode"),
            (T::Whitespace, " "),
            (T::At, "@"),
            (T::Ident, "unique"),
            (T::Whitespace, " "),
            (T::At, "@"),
            (T::Ident, "immutable"),
        ]
    );
}

#[test]
fn distinguishes_walrus_colon_and_ranges() {
    let src = "total := a..b";
    let k: Vec<T> = tokenize(src)
        .into_iter()
        .map(|t| t.kind)
        .filter(|k| *k != T::Whitespace)
        .collect();
    assert_eq!(k, vec![T::Ident, T::ColonEq, T::Ident, T::DotDot, T::Ident]);
}

#[test]
fn lexes_numbers_percent_and_durations_distinctly() {
    let src = "3..32 99.9% 500ms 28d 1s 1.5";
    let k: Vec<(T, &str)> = kinds(src)
        .into_iter()
        .filter(|(k, _)| *k != T::Whitespace)
        .collect();
    assert_eq!(
        k,
        vec![
            (T::Int, "3"),
            (T::DotDot, ".."),
            (T::Int, "32"),
            (T::Percent, "99.9%"),
            (T::Duration, "500ms"),
            (T::Duration, "28d"),
            (T::Duration, "1s"),
            (T::Decimal, "1.5"),
        ]
    );
}

#[test]
fn lexes_strings_comments_and_doc_comments() {
    let src = "/// doc\n// plain\n@crud(\"/v1/x\")";
    let k: Vec<(T, &str)> = kinds(src)
        .into_iter()
        .filter(|(k, _)| *k != T::Whitespace)
        .collect();
    assert_eq!(
        k,
        vec![
            (T::DocComment, "/// doc"),
            (T::Newline, "\n"),
            (T::Comment, "// plain"),
            (T::Newline, "\n"),
            (T::At, "@"),
            (T::Ident, "crud"),
            (T::LParen, "("),
            (T::String, "\"/v1/x\""),
            (T::RParen, ")"),
        ]
    );
}

#[test]
fn lexes_arrows_pipes_and_comparison_operators() {
    let src = "Draft | Submitted -> Cancelled >= <= == != && ||";
    let k: Vec<T> = tokenize(src)
        .into_iter()
        .map(|t| t.kind)
        .filter(|k| *k != T::Whitespace)
        .collect();
    assert_eq!(
        k,
        vec![
            T::Ident,
            T::Pipe,
            T::Ident,
            T::Arrow,
            T::Ident,
            T::GtEq,
            T::LtEq,
            T::EqEq,
            T::BangEq,
            T::AmpAmp,
            T::PipePipe
        ]
    );
}

#[test]
fn unknown_characters_become_error_tokens_without_stopping() {
    let src = "a $ b";
    let k: Vec<T> = tokenize(src)
        .into_iter()
        .map(|t| t.kind)
        .filter(|k| *k != T::Whitespace)
        .collect();
    assert_eq!(k, vec![T::Ident, T::Error, T::Ident]);
}

#[test]
fn hyphenated_keywords_lex_as_single_identifiers() {
    let k: Vec<(T, &str)> = kinds("send-only recv-only at-least-once a - b")
        .into_iter()
        .filter(|(k, _)| *k != T::Whitespace)
        .collect();
    assert_eq!(
        k,
        vec![
            (T::Ident, "send-only"),
            (T::Ident, "recv-only"),
            (T::Ident, "at-least-once"),
            (T::Ident, "a"),
            (T::Minus, "-"),
            (T::Ident, "b")
        ]
    );
}
