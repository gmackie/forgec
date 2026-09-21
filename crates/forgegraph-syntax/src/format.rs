//! Canonical formatter. Works on the lossless tree token stream with
//! parent-kind awareness, so comments and unparseable regions survive
//! verbatim and the output is a fixed point.

use crate::Parse;
use crate::syntax_kind::{SyntaxKind as K, SyntaxNode};
use rowan::NodeOrToken;

const INDENT: &str = "  ";

struct Tok {
    kind: K,
    text: String,
    parent: K,
    /// Set on the first token of a node that starts a continuation line.
    starts_continuation: bool,
    /// Set on `{` of a declaration whose header carries decorators.
    brace_after_header_decorators: bool,
    /// Set on `@` of a decorator that belongs to a declaration header.
    header_decorator: bool,
    /// Braces kept on one line (`read { a b }`, `for P { use C }`).
    inline_brace: bool,
}

fn header_kind(k: K) -> bool {
    matches!(
        k,
        K::RESOURCE_DECL
            | K::BLOB_DECL
            | K::CACHE_DECL
            | K::VIEW_DECL
            | K::PROJECTION_DECL
            | K::FUNCTION_DECL
            | K::CHANNEL_DECL
            | K::SOURCE_DECL
            | K::WORKFLOW_DECL
    )
}

/// A `for Purpose { use X }` block stays inline when it holds exactly one `use` and no comments.
fn single_line_block(node: &SyntaxNode) -> bool {
    let uses = node
        .children()
        .filter(|c| c.kind() == K::USE_PURPOSE)
        .count();
    let comments = node
        .descendants_with_tokens()
        .filter(|e| matches!(e.kind(), K::COMMENT | K::DOC_COMMENT))
        .count();
    uses == 1 && comments == 0
}

fn collect(node: &SyntaxNode, out: &mut Vec<Tok>) {
    let has_header_decorators =
        header_kind(node.kind()) && node.children().any(|c| c.kind() == K::DECORATOR);
    for el in node.children_with_tokens() {
        match el {
            NodeOrToken::Token(t) => out.push(Tok {
                kind: t.kind(),
                text: t.text().to_string(),
                parent: node.kind(),
                starts_continuation: false,
                brace_after_header_decorators: t.kind() == K::L_BRACE && has_header_decorators,
                header_decorator: false,
                inline_brace: matches!(t.kind(), K::L_BRACE | K::R_BRACE)
                    && (node.kind() == K::NAME_SET
                        || (node.kind() == K::PURPOSE_BINDING && single_line_block(node))),
            }),
            NodeOrToken::Node(n) => {
                let start = out.len();
                collect(&n, out);
                if let Some(first) = out.get_mut(start) {
                    match n.kind() {
                        K::ORDER_LIST => first.starts_continuation = true,
                        K::INPUT_BLOCK => first.starts_continuation = true,
                        K::CATCH_CLAUSE | K::CORRELATE_CLAUSE | K::TIMEOUT_CLAUSE => {
                            first.starts_continuation = true
                        }
                        K::DECORATOR if header_kind(node.kind()) => first.header_decorator = true,
                        _ => {}
                    }
                }
                // `order by`: the ORDER_LIST node starts at the first ORDER_KEY; the `order` `by`
                // tokens precede it as direct children of LIST_DECL. Mark `order` instead.
                if n.kind() == K::ORDER_LIST {
                    if let Some(first) = out.get_mut(start) {
                        first.starts_continuation = false;
                    }
                    if let Some(i) = (0..start).rev().find(|&i| {
                        out[i].kind == K::IDENT
                            && out[i].text == "order"
                            && out[i].parent == K::LIST_DECL
                    }) {
                        out[i].starts_continuation = true;
                    }
                }
            }
        }
    }
}

fn tight_before(t: &Tok, prev: &Tok) -> bool {
    match t.kind {
        K::COMMA | K::R_PAREN | K::R_BRACKET | K::QUESTION | K::DOT | K::DOT_DOT => true,
        K::COLON => matches!(
            t.parent,
            K::TRANSITION_DECL | K::DECORATOR_ARG | K::NAMED_ARG
        ),
        K::L_PAREN => matches!(t.parent, K::DECORATOR_ARGS | K::ARG_LIST),
        K::LT if t.parent == K::TYPE_ARGS => true,
        K::GT if t.parent == K::TYPE_ARGS => true,
        K::IDENT | K::INT | K::STRING if t.parent == K::TYPE_ARG => true,
        _ => {
            matches!(
                prev.kind,
                K::L_PAREN | K::L_BRACKET | K::AT | K::DOT | K::DOT_DOT | K::BANG
            ) || (prev.kind == K::MINUS && prev.parent == K::UNARY_EXPR)
                || (prev.kind == K::LT && prev.parent == K::TYPE_ARGS)
                || (prev.kind == K::COMMA && prev.parent == K::TYPE_ARGS)
                || (prev.parent == K::TYPE_ARG && t.kind == K::COMMA)
        }
    }
}

pub fn format(parse: &Parse) -> String {
    let root = parse.syntax();
    let mut toks = Vec::new();
    collect(&root, &mut toks);

    let mut out = String::new();
    let mut line: Vec<String> = Vec::new(); // pieces already spaced
    let mut line_indent = 0usize;
    let mut depth_stack: Vec<usize> = Vec::new();
    let mut indent = 0usize; // indent level for the next fresh line
    let mut pending_blank = false;
    let mut prev: Option<&Tok> = None;
    let mut continuation_indent: Option<usize> = None;
    let mut lines_emitted = 0usize;
    let mut last_kind = K::NEWLINE; // previous non-whitespace token kind
    let mut suppress_blank = true; // no blank line at file start or right after `{`
    let mut error_space = false; // whitespace seen inside an ERROR region
    let mut inline_depth = 0usize; // > 0 while inside `{ ... }` kept on one line

    fn flush(
        out: &mut String,
        line: &mut Vec<String>,
        line_indent: usize,
        pending_blank: &mut bool,
        lines_emitted: &mut usize,
    ) {
        if line.is_empty() {
            return;
        }
        if *pending_blank && *lines_emitted > 0 {
            out.push('\n');
        }
        *pending_blank = false;
        out.push_str(&INDENT.repeat(line_indent));
        out.push_str(&line.join(""));
        out.push('\n');
        line.clear();
        *lines_emitted += 1;
    }

    for t in &toks {
        match t.kind {
            K::WHITESPACE => {
                if t.parent == K::ERROR {
                    error_space = true;
                }
                continue;
            }
            K::NEWLINE => {
                if inline_depth > 0 {
                    continue;
                }
                if line.is_empty() {
                    if last_kind == K::NEWLINE && !suppress_blank {
                        pending_blank = true;
                    }
                } else {
                    flush(
                        &mut out,
                        &mut line,
                        line_indent,
                        &mut pending_blank,
                        &mut lines_emitted,
                    );
                    if continuation_indent.is_some()
                        && depth_stack.last().copied() != continuation_indent
                    {
                        continuation_indent = None;
                    }
                }
                last_kind = K::NEWLINE;
                error_space = false;
                continue;
            }
            K::COMMENT | K::DOC_COMMENT => {
                if line.is_empty() {
                    line_indent = continuation_indent.map(|c| c + 1).unwrap_or(indent);
                    line.push(t.text.clone());
                } else {
                    line.push(" ".into());
                    line.push(t.text.clone());
                }
                flush(
                    &mut out,
                    &mut line,
                    line_indent,
                    &mut pending_blank,
                    &mut lines_emitted,
                );
                prev = Some(t);
                last_kind = t.kind;
                suppress_blank = false;
                continue;
            }
            K::R_BRACE if t.inline_brace => {
                inline_depth = inline_depth.saturating_sub(1);
                line.push(" }".into());
                prev = Some(t);
                last_kind = t.kind;
                continue;
            }
            K::R_BRACE => {
                flush(
                    &mut out,
                    &mut line,
                    line_indent,
                    &mut pending_blank,
                    &mut lines_emitted,
                );
                pending_blank = false;
                indent = depth_stack.pop().unwrap_or(0);
                continuation_indent = None;
                line_indent = indent;
                line.push("}".into());
                flush(
                    &mut out,
                    &mut line,
                    line_indent,
                    &mut pending_blank,
                    &mut lines_emitted,
                );
                prev = Some(t);
                last_kind = t.kind;
                suppress_blank = false;
                continue;
            }
            _ => {}
        }
        suppress_blank = false;

        // Header decorators and the brace that follows them get their own lines.
        if t.header_decorator || t.brace_after_header_decorators {
            flush(
                &mut out,
                &mut line,
                line_indent,
                &mut pending_blank,
                &mut lines_emitted,
            );
            pending_blank = false;
        }
        if t.starts_continuation && !line.is_empty() {
            flush(
                &mut out,
                &mut line,
                line_indent,
                &mut pending_blank,
                &mut lines_emitted,
            );
            pending_blank = false;
        }
        if line.is_empty() {
            line_indent = if t.header_decorator {
                indent + 1
            } else if t.brace_after_header_decorators {
                indent
            } else if t.starts_continuation {
                let c = indent + 1;
                continuation_indent = Some(c);
                c
            } else if let Some(c) = continuation_indent {
                c
            } else {
                indent
            };
        } else if t.parent == K::ERROR {
            // Unparseable regions are reproduced with their original spacing.
            if error_space {
                line.push(" ".into());
            }
        } else if let Some(p) = prev
            && !tight_before(t, p)
        {
            line.push(" ".into());
        }
        error_space = false;
        line.push(t.text.clone());
        last_kind = t.kind;
        if t.kind == K::L_BRACE && t.inline_brace {
            inline_depth += 1;
        } else if t.kind == K::L_BRACE {
            // A block opened on a continuation line (`input {`) nests from that line's indent.
            let base = if t.parent == K::INPUT_BLOCK {
                line_indent
            } else {
                indent
            };
            depth_stack.push(base);
            indent = base + 1;
            continuation_indent = None;
            flush(
                &mut out,
                &mut line,
                line_indent,
                &mut pending_blank,
                &mut lines_emitted,
            );
            pending_blank = false;
            suppress_blank = true;
        }
        prev = Some(t);
    }
    flush(
        &mut out,
        &mut line,
        line_indent,
        &mut pending_blank,
        &mut lines_emitted,
    );
    out
}
