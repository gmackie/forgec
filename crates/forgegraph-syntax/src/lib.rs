//! Forge language front end: lexer, parser, lossless syntax tree, AST.

pub mod ast;
pub mod format;
pub mod lexer;
pub mod parser;
pub mod syntax_kind;

pub use ast::AstNode;
pub use format::format;
pub use parser::SyntaxError;
pub use syntax_kind::{SyntaxKind, SyntaxNode, SyntaxToken};

use rowan::GreenNode;

/// Result of parsing one file: a lossless tree plus recovered errors.
#[derive(Debug, Clone)]
pub struct Parse {
    green: GreenNode,
    errors: Vec<SyntaxError>,
}

impl Parse {
    pub fn syntax(&self) -> SyntaxNode {
        SyntaxNode::new_root(self.green.clone())
    }
    pub fn errors(&self) -> &[SyntaxError] {
        &self.errors
    }
    pub fn root(&self) -> ast::Root {
        ast::Root::cast(self.syntax()).expect("root")
    }
    /// Human-readable tree for snapshot tests. Whitespace tokens are elided.
    pub fn debug_tree(&self) -> String {
        fn go(node: &SyntaxNode, depth: usize, out: &mut String) {
            use std::fmt::Write;
            let _ = writeln!(
                out,
                "{}{:?}@{:?}",
                "  ".repeat(depth),
                node.kind(),
                node.text_range()
            );
            for child in node.children_with_tokens() {
                match child {
                    rowan::NodeOrToken::Node(n) => go(&n, depth + 1, out),
                    rowan::NodeOrToken::Token(t) => {
                        if t.kind() == SyntaxKind::WHITESPACE {
                            continue;
                        }
                        let text = if t.kind() == SyntaxKind::NEWLINE {
                            "\\n".to_string()
                        } else {
                            t.text().to_string()
                        };
                        let _ = writeln!(
                            out,
                            "{}{:?}@{:?} {:?}",
                            "  ".repeat(depth + 1),
                            t.kind(),
                            t.text_range(),
                            text
                        );
                    }
                }
            }
        }
        let mut out = String::new();
        go(&self.syntax(), 0, &mut out);
        out
    }
}

pub fn parse(src: &str) -> Parse {
    let (green, errors) = parser::parse_to_green(src);
    Parse { green, errors }
}
