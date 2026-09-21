//! Token layer. Every byte of the source is covered by exactly one token
//! (trivia included) so the syntax tree can be lossless.

use logos::Logos;
use std::ops::Range;

#[derive(Logos, Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u16)]
pub enum TokenKind {
    #[regex(r"[ \t\r]+")]
    Whitespace,
    #[token("\n")]
    Newline,
    #[regex(r"///[^\n]*", allow_greedy = true)]
    DocComment,
    #[regex(r"//[^\n]*", allow_greedy = true)]
    Comment,

    /// Identifiers may contain single hyphens between alphanumerics so the
    /// hyphenated keywords (`send-only`, `at-least-once`) are one token.
    /// Consequence: binary minus needs surrounding whitespace.
    #[regex(r"[A-Za-z_][A-Za-z0-9_]*(-[A-Za-z][A-Za-z0-9_]*)*")]
    Ident,
    #[regex(r"[0-9]+(\.[0-9]+)?%")]
    Percent,
    #[regex(r"[0-9]+(ms|s|m|h|d)")]
    Duration,
    #[regex(r"[0-9]+\.[0-9]+")]
    Decimal,
    #[regex(r"[0-9]+")]
    Int,
    #[regex(r#""([^"\\\n]|\\.)*""#)]
    String,

    #[token("{")]
    LBrace,
    #[token("}")]
    RBrace,
    #[token("(")]
    LParen,
    #[token(")")]
    RParen,
    #[token("[")]
    LBracket,
    #[token("]")]
    RBracket,
    #[token("<")]
    Lt,
    #[token(">")]
    Gt,
    #[token("<=")]
    LtEq,
    #[token(">=")]
    GtEq,
    #[token("==")]
    EqEq,
    #[token("!=")]
    BangEq,
    #[token("&&")]
    AmpAmp,
    #[token("||")]
    PipePipe,
    #[token(",")]
    Comma,
    #[token(":")]
    Colon,
    #[token(":=")]
    ColonEq,
    #[token(";")]
    Semicolon,
    #[token(".")]
    Dot,
    #[token("..")]
    DotDot,
    #[token("=")]
    Eq,
    #[token("@")]
    At,
    #[token("->")]
    Arrow,
    #[token("|")]
    Pipe,
    #[token("+")]
    Plus,
    #[token("-")]
    Minus,
    #[token("*")]
    Star,
    #[token("/")]
    Slash,
    #[token("!")]
    Bang,
    #[token("?")]
    Question,

    /// Any byte sequence the lexer cannot classify. Never stops lexing.
    Error,
    /// Virtual end-of-file token (never produced by `tokenize`).
    Eof,
}

impl TokenKind {
    pub fn is_trivia(self) -> bool {
        matches!(
            self,
            TokenKind::Whitespace | TokenKind::Comment | TokenKind::DocComment
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub kind: TokenKind,
    pub range: Range<usize>,
}

pub fn tokenize(src: &str) -> Vec<Token> {
    let mut out = Vec::new();
    for (res, range) in TokenKind::lexer(src).spanned() {
        let kind = res.unwrap_or(TokenKind::Error);
        // Coalesce adjacent error bytes into one token.
        if kind == TokenKind::Error
            && let Some(last) = out.last_mut()
        {
            let last: &mut Token = last;
            if last.kind == TokenKind::Error && last.range.end == range.start {
                last.range.end = range.end;
                continue;
            }
        }
        out.push(Token { kind, range });
    }
    out
}
