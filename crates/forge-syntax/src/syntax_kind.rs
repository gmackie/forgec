//! One flat kind space for tokens and nodes, as rowan requires.

use crate::lexer::TokenKind;

#[allow(non_camel_case_types)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u16)]
pub enum SyntaxKind {
    // ---- tokens (mirror TokenKind) ----
    WHITESPACE, NEWLINE, DOC_COMMENT, COMMENT, IDENT, PERCENT, DURATION, DECIMAL, INT, STRING,
    L_BRACE, R_BRACE, L_PAREN, R_PAREN, L_BRACKET, R_BRACKET, LT, GT, LT_EQ, GT_EQ, EQ_EQ, BANG_EQ,
    AMP_AMP, PIPE_PIPE, COMMA, COLON, COLON_EQ, SEMICOLON, DOT, DOT_DOT, EQ, AT, ARROW, PIPE, PLUS,
    MINUS, STAR, SLASH, BANG, QUESTION, ERROR_TOKEN, EOF,

    // ---- nodes ----
    ROOT,
    ERROR,
    MODULE_DECL, IMPORT_DECL,
    ENUM_DECL, ENUM_MEMBER,
    TYPE_DECL, SHAPE_DECL,
    RESOURCE_DECL, FUNCTION_DECL, CHANNEL_DECL, SOURCE_DECL, SUBSCRIPTION_DECL,
    QUALIFIED_NAME,
    TYPE_EXPR, TYPE_REF, TYPE_ARGS, TYPE_ARG, REFINEMENT, RANGE,
    FIELD_DECL, DEFAULT_VALUE, DERIVED_VALUE,
    DECORATOR, DECORATOR_ARGS, DECORATOR_ARG, LIST_LITERAL,
    UNIQUE_DECL, FIND_DECL, LIST_DECL, FIELD_LIST, ORDER_LIST, ORDER_KEY,
    RULES_BLOCK, RULE,
    LIFECYCLE_BLOCK, INITIAL_DECL, TERMINAL_DECL, TRANSITION_DECL, STATE_SET, INPUT_BLOCK,
    FUNCTION_INPUT, FUNCTION_OUTPUT, USES_BLOCK, USE_DECL, SENDS_BLOCK, SEND_DECL, ERRORS_BLOCK, ERROR_DECL,
    SLO_BLOCK, SLO_ITEM,
    CHANNEL_FROM, DISTRIBUTION_DECL, DELIVERY_DECL, DIRECTION_DECL, MESSAGE_DECL,
    CRON_DECL, TIMEZONE_DECL, TARGET_DECL,
    BINARY_EXPR, UNARY_EXPR, CALL_EXPR, ARG_LIST, NAME_EXPR, LITERAL_EXPR, PAREN_EXPR,
    #[doc(hidden)]
    __LAST,
}

impl From<TokenKind> for SyntaxKind {
    fn from(t: TokenKind) -> Self {
        use SyntaxKind::*;
        use TokenKind as T;
        match t {
            T::Whitespace => WHITESPACE, T::Newline => NEWLINE, T::DocComment => DOC_COMMENT, T::Comment => COMMENT,
            T::Ident => IDENT, T::Percent => PERCENT, T::Duration => DURATION, T::Decimal => DECIMAL, T::Int => INT,
            T::String => STRING, T::LBrace => L_BRACE, T::RBrace => R_BRACE, T::LParen => L_PAREN, T::RParen => R_PAREN,
            T::LBracket => L_BRACKET, T::RBracket => R_BRACKET, T::Lt => LT, T::Gt => GT, T::LtEq => LT_EQ, T::GtEq => GT_EQ,
            T::EqEq => EQ_EQ, T::BangEq => BANG_EQ, T::AmpAmp => AMP_AMP, T::PipePipe => PIPE_PIPE, T::Comma => COMMA,
            T::Colon => COLON, T::ColonEq => COLON_EQ, T::Semicolon => SEMICOLON, T::Dot => DOT, T::DotDot => DOT_DOT,
            T::Eq => EQ, T::At => AT, T::Arrow => ARROW, T::Pipe => PIPE, T::Plus => PLUS, T::Minus => MINUS, T::Star => STAR,
            T::Slash => SLASH, T::Bang => BANG, T::Question => QUESTION, T::Error => ERROR_TOKEN, T::Eof => EOF,
        }
    }
}

impl SyntaxKind {
    pub fn is_trivia(self) -> bool {
        matches!(self, SyntaxKind::WHITESPACE | SyntaxKind::COMMENT | SyntaxKind::DOC_COMMENT)
    }
}

impl From<SyntaxKind> for rowan::SyntaxKind {
    fn from(k: SyntaxKind) -> Self {
        rowan::SyntaxKind(k as u16)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ForgeLanguage {}

impl rowan::Language for ForgeLanguage {
    type Kind = SyntaxKind;
    fn kind_from_raw(raw: rowan::SyntaxKind) -> SyntaxKind {
        assert!(raw.0 < SyntaxKind::__LAST as u16);
        // SAFETY: repr(u16) and bounds-checked above.
        unsafe { std::mem::transmute::<u16, SyntaxKind>(raw.0) }
    }
    fn kind_to_raw(kind: SyntaxKind) -> rowan::SyntaxKind {
        kind.into()
    }
}

pub type SyntaxNode = rowan::SyntaxNode<ForgeLanguage>;
pub type SyntaxToken = rowan::SyntaxToken<ForgeLanguage>;
pub type SyntaxElement = rowan::SyntaxElement<ForgeLanguage>;
