//! Hand-written, recovery-oriented recursive-descent parser with a Pratt
//! expression parser. Produces a lossless rowan tree: every source byte is
//! in the tree, including comments, whitespace and unparseable regions.

use crate::lexer::{tokenize, Token, TokenKind};
use crate::syntax_kind::SyntaxKind as K;
use rowan::{Checkpoint, GreenNode, GreenNodeBuilder};
use std::ops::Range;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyntaxError {
    pub range: Range<usize>,
    pub message: String,
}

pub struct Parser<'a> {
    src: &'a str,
    tokens: Vec<Token>,
    pos: usize,
    builder: GreenNodeBuilder<'static>,
    errors: Vec<SyntaxError>,
}

pub fn parse_to_green(src: &str) -> (GreenNode, Vec<SyntaxError>) {
    let mut p = Parser { src, tokens: tokenize(src), pos: 0, builder: GreenNodeBuilder::new(), errors: Vec::new() };
    p.file();
    (p.builder.finish(), p.errors)
}

const DECL_KEYWORDS: &[&str] = &["enum", "type", "shape", "resource", "function", "channel", "source", "on", "import", "module", "export"];

impl<'a> Parser<'a> {
    // ---------------------------------------------------------------- cursor
    fn raw_kind(&self, i: usize) -> TokenKind {
        self.tokens.get(i).map(|t| t.kind).unwrap_or(TokenKind::Eof)
    }
    fn raw_text(&self, i: usize) -> &'a str {
        self.tokens.get(i).map(|t| &self.src[t.range.clone()]).unwrap_or("")
    }
    /// Index of the next significant token. Whitespace and plain comments are
    /// skipped; a doc-comment run is skipped together with the line breaks
    /// that follow it, because docs always precede what they document.
    /// A newline that is not part of a doc run is significant (item terminator).
    fn sig(&self, mut i: usize) -> usize {
        loop {
            match self.raw_kind(i) {
                TokenKind::Whitespace | TokenKind::Comment => i += 1,
                TokenKind::DocComment => {
                    i += 1;
                    while matches!(self.raw_kind(i), TokenKind::Whitespace | TokenKind::Newline) {
                        i += 1;
                    }
                }
                _ => return i,
            }
        }
    }
    /// Index of the next token that is neither trivia nor a newline/semicolon.
    fn sig_after_lines(&self, mut i: usize) -> usize {
        loop {
            let k = self.raw_kind(i);
            if k.is_trivia() || k == TokenKind::Newline || k == TokenKind::Semicolon {
                i += 1;
            } else {
                return i;
            }
        }
    }
    fn current(&self) -> TokenKind {
        self.raw_kind(self.sig(self.pos))
    }
    fn current_text(&self) -> &'a str {
        self.raw_text(self.sig(self.pos))
    }
    fn nth(&self, n: usize) -> TokenKind {
        let mut i = self.sig(self.pos);
        for _ in 0..n {
            i = self.sig(i + 1);
        }
        self.raw_kind(i)
    }
    fn nth_text(&self, n: usize) -> &'a str {
        let mut i = self.sig(self.pos);
        for _ in 0..n {
            i = self.sig(i + 1);
        }
        self.raw_text(i)
    }
    fn at(&self, k: TokenKind) -> bool {
        self.current() == k
    }
    fn at_kw(&self, kw: &str) -> bool {
        self.current() == TokenKind::Ident && self.current_text() == kw
    }
    fn at_eof(&self) -> bool {
        self.current() == TokenKind::Eof
    }
    fn at_line_end(&self) -> bool {
        matches!(self.current(), TokenKind::Newline | TokenKind::Semicolon | TokenKind::Eof | TokenKind::RBrace)
    }
    fn current_range(&self) -> Range<usize> {
        let i = self.sig(self.pos);
        self.tokens.get(i).map(|t| t.range.clone()).unwrap_or(self.src.len()..self.src.len())
    }

    // --------------------------------------------------------------- building
    fn push_raw(&mut self) {
        let t = &self.tokens[self.pos];
        self.builder.token(K::from(t.kind).into(), &self.src[t.range.clone()]);
        self.pos += 1;
    }
    /// Push everything before the next significant token into the current node.
    fn skip_trivia(&mut self) {
        let target = self.sig(self.pos);
        while self.pos < target {
            self.push_raw();
        }
    }
    /// Consume the current significant token.
    fn bump(&mut self) {
        self.skip_trivia();
        if self.pos < self.tokens.len() {
            self.push_raw();
        }
    }
    fn bump_as(&mut self, kind: K) {
        self.skip_trivia();
        if self.pos < self.tokens.len() {
            let t = &self.tokens[self.pos];
            self.builder.token(kind.into(), &self.src[t.range.clone()]);
            self.pos += 1;
        }
    }
    fn start(&mut self, kind: K) {
        self.skip_trivia();
        self.builder.start_node(kind.into());
    }
    fn checkpoint(&mut self) -> Checkpoint {
        self.skip_trivia();
        self.builder.checkpoint()
    }
    fn start_at(&mut self, cp: Checkpoint, kind: K) {
        self.builder.start_node_at(cp, kind.into());
    }
    fn finish(&mut self) {
        self.builder.finish_node();
    }
    /// Start a declaration node so that a directly preceding run of doc
    /// comments is inside it.
    fn start_decl(&mut self, kind: K) {
        // Find the earliest doc comment such that only trivia/newlines separate it from the keyword.
        let sig = self.sig_after_lines(self.pos);
        let mut start = sig;
        let mut i = sig;
        while i > self.pos {
            i -= 1;
            match self.raw_kind(i) {
                TokenKind::DocComment => start = i,
                TokenKind::Whitespace | TokenKind::Newline => {}
                _ => break,
            }
        }
        while self.pos < start {
            self.push_raw();
        }
        self.builder.start_node(kind.into());
    }
    fn error(&mut self, message: impl Into<String>) {
        let range = self.current_range();
        self.errors.push(SyntaxError { range, message: message.into() });
    }
    fn expect(&mut self, k: TokenKind, what: &str) -> bool {
        if self.at(k) {
            self.bump();
            true
        } else {
            self.error(format!("expected {what}, found {}", self.describe()));
            false
        }
    }
    fn expect_kw(&mut self, kw: &str) -> bool {
        if self.at_kw(kw) {
            self.bump();
            true
        } else {
            self.error(format!("expected `{kw}`, found {}", self.describe()));
            false
        }
    }
    fn expect_ident(&mut self, what: &str) -> bool {
        if self.at(TokenKind::Ident) {
            self.bump();
            true
        } else {
            self.error(format!("expected {what}, found {}", self.describe()));
            false
        }
    }
    fn describe(&self) -> String {
        match self.current() {
            TokenKind::Eof => "end of file".into(),
            TokenKind::Newline => "end of line".into(),
            _ => format!("`{}`", self.current_text()),
        }
    }
    /// Newlines and `;` between items. Stops in front of a doc-comment run so
    /// `start_decl` can pull it into the declaration it documents.
    fn eat_lines(&mut self) {
        while self.pos < self.tokens.len() {
            match self.tokens[self.pos].kind {
                TokenKind::Whitespace | TokenKind::Comment | TokenKind::Newline | TokenKind::Semicolon => self.push_raw(),
                _ => return,
            }
        }
    }
    /// Wrap everything up to the end of the line (or the closing brace) in an ERROR node.
    fn recover_line(&mut self) {
        self.start(K::ERROR);
        while !self.at_line_end() {
            self.bump();
        }
        self.finish();
    }
    /// Require end of item: newline, `;`, `}` or EOF.
    fn end_item(&mut self) {
        if !self.at_line_end() {
            self.error(format!("expected end of line, found {}", self.describe()));
            self.recover_line();
        }
    }

    // ------------------------------------------------------------------ file
    fn file(&mut self) {
        self.builder.start_node(K::ROOT.into());
        loop {
            self.eat_lines();
            if self.at_eof() {
                break;
            }
            self.declaration();
        }
        self.skip_trivia();
        while self.pos < self.tokens.len() {
            self.push_raw();
        }
        self.finish();
    }

    fn declaration(&mut self) {
        let kw = if self.at_kw("export") { self.nth_text(1) } else { self.current_text() };
        let kind = match kw {
            "enum" => K::ENUM_DECL,
            "type" => K::TYPE_DECL,
            "shape" => K::SHAPE_DECL,
            "resource" => K::RESOURCE_DECL,
            "function" => K::FUNCTION_DECL,
            "channel" => K::CHANNEL_DECL,
            "source" => K::SOURCE_DECL,
            "on" => K::SUBSCRIPTION_DECL,
            "import" => K::IMPORT_DECL,
            "module" => K::MODULE_DECL,
            _ => {
                self.error(format!("expected a declaration, found {}", self.describe()));
                self.recover_line();
                return;
            }
        };
        self.start_decl(kind);
        if self.at_kw("export") {
            self.bump();
        }
        self.bump(); // keyword
        match kind {
            K::ENUM_DECL => self.enum_body(),
            K::TYPE_DECL => self.type_body(),
            K::SHAPE_DECL => self.shape_body(),
            K::RESOURCE_DECL => self.resource_body(),
            K::FUNCTION_DECL => self.function_body(),
            K::CHANNEL_DECL => self.channel_body(),
            K::SOURCE_DECL => self.source_body(),
            K::SUBSCRIPTION_DECL => self.subscription_body(),
            K::IMPORT_DECL => self.import_body(),
            K::MODULE_DECL => {
                self.qualified_name("module name");
                self.end_item();
            }
            _ => unreachable!(),
        }
        self.finish();
    }

    // ---------------------------------------------------------------- blocks
    /// `{` NL* ( item NL+ )* `}` with per-item recovery.
    fn block(&mut self, item: impl Fn(&mut Self)) {
        if !self.expect(TokenKind::LBrace, "`{`") {
            return;
        }
        loop {
            self.eat_lines();
            if self.at(TokenKind::RBrace) {
                self.bump();
                return;
            }
            if self.at_eof() {
                self.error("expected `}` before end of file");
                return;
            }
            // A declaration keyword inside a block means the block was never closed.
            if self.at(TokenKind::Ident) && DECL_KEYWORDS.contains(&self.current_text()) && self.nth(1) == TokenKind::Ident && !matches!(self.nth(1), TokenKind::Colon) && self.looks_like_decl() {
                self.error("expected `}` before next declaration");
                return;
            }
            let before = self.pos;
            item(self);
            if self.pos == before {
                self.error(format!("unexpected {}", self.describe()));
                self.recover_line();
            }
        }
    }
    fn looks_like_decl(&self) -> bool {
        // `resource X {` / `enum X {` / `type X =` … at block depth. Field names can collide with
        // keywords (`order : text`), so require the shape keyword IDENT and no `:` after.
        let second = self.nth(1);
        second == TokenKind::Ident && !matches!(self.nth(2), TokenKind::Colon | TokenKind::ColonEq)
    }

    // ------------------------------------------------------------------ enum
    fn enum_body(&mut self) {
        self.expect_ident("enum name");
        self.block(|p| {
            if p.at(TokenKind::Ident) {
                p.start_decl(K::ENUM_MEMBER);
                p.bump();
                if p.at(TokenKind::Eq) {
                    p.bump();
                    p.expect(TokenKind::String, "string wire value");
                }
                p.finish();
                p.end_item();
            }
        });
    }

    // ------------------------------------------------------------------ type
    fn type_body(&mut self) {
        self.expect_ident("type name");
        self.expect(TokenKind::Eq, "`=`");
        self.type_expr();
        self.end_item();
    }

    fn shape_body(&mut self) {
        self.expect_ident("shape name");
        self.block(|p| p.field_item());
    }

    fn field_item(&mut self) {
        if self.at(TokenKind::Ident) && matches!(self.nth(1), TokenKind::Colon | TokenKind::ColonEq) {
            self.field_decl();
            self.end_item();
        }
    }

    fn field_decl(&mut self) {
        self.start_decl(K::FIELD_DECL);
        self.bump(); // name
        if self.at(TokenKind::ColonEq) {
            self.bump();
            self.start(K::DERIVED_VALUE);
            self.expr();
            self.finish();
        } else {
            self.bump(); // ':'
            self.type_expr();
            if self.at(TokenKind::Eq) {
                self.bump();
                self.start(K::DEFAULT_VALUE);
                self.expr();
                self.finish();
            }
        }
        while self.at(TokenKind::At) {
            self.decorator();
        }
        self.finish();
    }

    // ------------------------------------------------------------- type expr
    fn type_expr(&mut self) {
        self.start(K::TYPE_EXPR);
        self.start(K::TYPE_REF);
        self.qualified_name("type name");
        if self.at(TokenKind::Lt) && self.type_args_ahead() {
            self.start(K::TYPE_ARGS);
            self.bump();
            loop {
                self.start(K::TYPE_ARG);
                match self.current() {
                    TokenKind::Ident | TokenKind::Int | TokenKind::String => self.bump(),
                    _ => self.error("expected type argument"),
                }
                self.finish();
                if self.at(TokenKind::Comma) {
                    self.bump();
                } else {
                    break;
                }
            }
            self.expect(TokenKind::Gt, "`>`");
            self.finish();
        }
        self.finish();
        if self.at(TokenKind::Question) {
            self.bump();
        }
        loop {
            match self.current() {
                TokenKind::Ident if matches!(self.current_text(), "trim" | "uppercase" | "lowercase") => {
                    self.start(K::REFINEMENT);
                    self.bump();
                    self.finish();
                }
                TokenKind::Ident if self.current_text() == "length" => {
                    self.start(K::REFINEMENT);
                    self.bump();
                    if self.at(TokenKind::Int) && self.nth(1) == TokenKind::DotDot {
                        self.start(K::RANGE);
                        self.bump();
                        self.bump();
                        self.expect(TokenKind::Int, "range end");
                        self.finish();
                    } else if self.is_compare_op() {
                        self.bump();
                        self.expect(TokenKind::Int, "length bound");
                    } else {
                        self.error("expected `min..max` or a comparison after `length`");
                    }
                    self.finish();
                }
                TokenKind::Ident if self.current_text() == "pattern" => {
                    self.start(K::REFINEMENT);
                    self.bump();
                    self.expect(TokenKind::String, "pattern string");
                    self.finish();
                }
                k if Self::is_compare_kind(k) => {
                    self.start(K::REFINEMENT);
                    self.bump();
                    self.literal_or_error();
                    self.finish();
                }
                _ => break,
            }
        }
        self.finish();
    }
    fn type_args_ahead(&self) -> bool {
        // `<` Ident|Int|String (`,` ...)* `>` on the same line.
        let mut i = self.sig(self.sig(self.pos) + 1);
        let mut expect_arg = true;
        loop {
            match (expect_arg, self.raw_kind(i)) {
                (true, TokenKind::Ident | TokenKind::Int | TokenKind::String) => expect_arg = false,
                (false, TokenKind::Comma) => expect_arg = true,
                (false, TokenKind::Gt) => return true,
                _ => return false,
            }
            i = self.sig(i + 1);
        }
    }
    fn is_compare_kind(k: TokenKind) -> bool {
        matches!(k, TokenKind::Lt | TokenKind::LtEq | TokenKind::Gt | TokenKind::GtEq | TokenKind::EqEq | TokenKind::BangEq)
    }
    fn is_compare_op(&self) -> bool {
        Self::is_compare_kind(self.current())
    }
    fn literal_or_error(&mut self) {
        match self.current() {
            TokenKind::Int | TokenKind::Decimal | TokenKind::String => {
                self.start(K::LITERAL_EXPR);
                self.bump();
                self.finish();
            }
            TokenKind::Ident if matches!(self.current_text(), "true" | "false" | "null") => {
                self.start(K::LITERAL_EXPR);
                self.bump();
                self.finish();
            }
            _ => self.error(format!("expected a literal, found {}", self.describe())),
        }
    }

    fn qualified_name(&mut self, what: &str) {
        self.start(K::QUALIFIED_NAME);
        if self.expect_ident(what) {
            while self.at(TokenKind::Dot) && self.nth(1) == TokenKind::Ident {
                self.bump();
                self.bump();
            }
        }
        self.finish();
    }

    // ------------------------------------------------------------- decorator
    fn decorator(&mut self) {
        self.start(K::DECORATOR);
        self.bump(); // @
        self.expect_ident("decorator name");
        if self.at(TokenKind::LParen) {
            self.start(K::DECORATOR_ARGS);
            self.bump();
            if !self.at(TokenKind::RParen) {
                loop {
                    self.decorator_arg();
                    if self.at(TokenKind::Comma) {
                        self.bump();
                    } else {
                        break;
                    }
                }
            }
            self.expect(TokenKind::RParen, "`)`");
            self.finish();
        }
        self.finish();
    }
    fn decorator_arg(&mut self) {
        self.start(K::DECORATOR_ARG);
        if self.at(TokenKind::Ident) && self.nth(1) == TokenKind::Colon {
            self.bump();
            self.bump();
        }
        match self.current() {
            TokenKind::Int | TokenKind::Decimal | TokenKind::String | TokenKind::Duration | TokenKind::Percent => {
                self.start(K::LITERAL_EXPR);
                self.bump();
                self.finish();
            }
            TokenKind::Ident => self.qualified_name("argument"),
            TokenKind::LBracket => {
                self.start(K::LIST_LITERAL);
                self.bump();
                while !self.at(TokenKind::RBracket) && !self.at_line_end() {
                    match self.current() {
                        TokenKind::Ident => self.qualified_name("list element"),
                        _ => self.literal_or_error(),
                    }
                    if self.at(TokenKind::Comma) {
                        self.bump();
                    } else {
                        break;
                    }
                }
                self.expect(TokenKind::RBracket, "`]`");
                self.finish();
            }
            _ => self.error(format!("expected decorator argument, found {}", self.describe())),
        }
        self.finish();
    }
    /// Decorators may follow the header on subsequent lines, before `{`.
    fn header_decorators(&mut self) {
        loop {
            let i = self.sig_after_lines(self.pos);
            if self.raw_kind(i) == TokenKind::At {
                self.eat_lines();
                self.decorator();
            } else {
                break;
            }
        }
        let i = self.sig_after_lines(self.pos);
        if self.raw_kind(i) == TokenKind::LBrace {
            self.eat_lines();
        }
    }

    // -------------------------------------------------------------- resource
    fn resource_body(&mut self) {
        self.expect_ident("resource name");
        self.header_decorators();
        self.block(|p| p.resource_item());
    }
    fn resource_item(&mut self) {
        let t = self.current_text();
        let n1 = self.nth(1);
        let n1t = self.nth_text(1);
        if self.at(TokenKind::Ident) && matches!(n1, TokenKind::Colon | TokenKind::ColonEq) {
            self.field_decl();
            self.end_item();
        } else if t == "unique" && n1 == TokenKind::Ident {
            self.start(K::UNIQUE_DECL);
            self.bump();
            self.field_list();
            if self.at_kw("within") {
                self.bump();
                self.field_list();
            }
            self.finish();
            self.end_item();
        } else if t == "find" && n1t == "by" {
            self.start(K::FIND_DECL);
            self.bump();
            self.bump();
            self.field_list();
            self.finish();
            self.end_item();
        } else if t == "list" && n1t == "by" {
            self.start(K::LIST_DECL);
            self.bump();
            self.bump();
            self.field_list();
            let i = self.sig_after_lines(self.pos);
            if self.raw_kind(i) == TokenKind::Ident && self.raw_text(i) == "order" && self.raw_text(self.sig(i + 1)) == "by" {
                self.eat_lines();
                self.bump();
                self.bump();
                self.start(K::ORDER_LIST);
                loop {
                    self.start(K::ORDER_KEY);
                    self.expect_ident("order field");
                    if self.at_kw("asc") || self.at_kw("desc") {
                        self.bump();
                    }
                    self.finish();
                    if self.at(TokenKind::Comma) {
                        self.bump();
                    } else {
                        break;
                    }
                }
                self.finish();
            }
            self.finish();
            self.end_item();
        } else if t == "rules" && n1 == TokenKind::LBrace {
            self.start(K::RULES_BLOCK);
            self.bump();
            self.block(|p| {
                if !p.at_line_end() {
                    p.start(K::RULE);
                    p.expr();
                    p.finish();
                    p.end_item();
                }
            });
            self.finish();
        } else if t == "lifecycle" && n1 == TokenKind::Ident {
            self.lifecycle_block();
        }
    }
    fn field_list(&mut self) {
        self.start(K::FIELD_LIST);
        loop {
            self.expect_ident("field name");
            if self.at(TokenKind::Comma) {
                self.bump();
            } else {
                break;
            }
        }
        self.finish();
    }
    fn lifecycle_block(&mut self) {
        self.start(K::LIFECYCLE_BLOCK);
        self.bump(); // lifecycle
        self.expect_ident("lifecycle field name");
        self.block(|p| {
            if p.at_kw("initial") && p.nth(1) == TokenKind::Ident {
                p.start(K::INITIAL_DECL);
                p.bump();
                p.bump();
                p.finish();
                p.end_item();
            } else if p.at_kw("terminal") && p.nth(1) == TokenKind::Ident {
                p.start(K::TERMINAL_DECL);
                p.bump();
                p.bump();
                p.finish();
                p.end_item();
            } else if p.at(TokenKind::Ident) && p.nth(1) == TokenKind::Colon {
                p.start_decl(K::TRANSITION_DECL);
                p.bump();
                p.bump();
                p.start(K::STATE_SET);
                loop {
                    p.expect_ident("state name");
                    if p.at(TokenKind::Pipe) {
                        p.bump();
                    } else {
                        break;
                    }
                }
                p.finish();
                p.expect(TokenKind::Arrow, "`->`");
                p.expect_ident("target state");
                let i = p.sig_after_lines(p.pos);
                if p.raw_kind(i) == TokenKind::Ident && p.raw_text(i) == "input" && p.raw_kind(p.sig(i + 1)) == TokenKind::LBrace {
                    p.eat_lines();
                    p.start(K::INPUT_BLOCK);
                    p.bump();
                    p.block(|q| q.field_item());
                    p.finish();
                }
                p.finish();
                p.end_item();
            }
        });
        self.finish();
    }

    // -------------------------------------------------------------- function
    fn function_body(&mut self) {
        self.expect_ident("function name");
        self.header_decorators();
        self.block(|p| {
            match p.current_text() {
                "input" if p.nth(1) == TokenKind::Ident => {
                    p.start(K::FUNCTION_INPUT);
                    p.bump();
                    p.start(K::TYPE_REF);
                    p.qualified_name("input type");
                    p.finish();
                    p.finish();
                    p.end_item();
                }
                "output" if p.nth(1) == TokenKind::Ident => {
                    p.start(K::FUNCTION_OUTPUT);
                    p.bump();
                    p.start(K::TYPE_REF);
                    p.qualified_name("output type");
                    p.finish();
                    p.finish();
                    p.end_item();
                }
                "uses" if p.nth(1) == TokenKind::LBrace => {
                    p.start(K::USES_BLOCK);
                    p.bump();
                    p.block(|q| {
                        if q.at(TokenKind::Ident) {
                            q.start(K::USE_DECL);
                            q.qualified_name("dependency");
                            if q.at(TokenKind::Ident) && matches!(q.current_text(), "read" | "write" | "create" | "delete") {
                                q.bump();
                            }
                            q.finish();
                            q.end_item();
                        }
                    });
                    p.finish();
                }
                "sends" if p.nth(1) == TokenKind::LBrace => {
                    p.start(K::SENDS_BLOCK);
                    p.bump();
                    p.block(|q| {
                        if q.at(TokenKind::Ident) {
                            q.start(K::SEND_DECL);
                            q.bump();
                            q.expect_kw("to");
                            q.qualified_name("channel");
                            q.finish();
                            q.end_item();
                        }
                    });
                    p.finish();
                }
                "errors" if p.nth(1) == TokenKind::LBrace => {
                    p.start(K::ERRORS_BLOCK);
                    p.bump();
                    p.block(|q| {
                        if q.at(TokenKind::Ident) {
                            q.start_decl(K::ERROR_DECL);
                            q.bump();
                            q.finish();
                            q.end_item();
                        }
                    });
                    p.finish();
                }
                "slo" if p.nth(1) == TokenKind::LBrace => {
                    p.start(K::SLO_BLOCK);
                    p.bump();
                    p.block(|q| {
                        if q.at_kw("availability") {
                            q.start(K::SLO_ITEM);
                            q.bump();
                            q.expect(TokenKind::Percent, "percentage");
                            q.expect_kw("over");
                            q.expect(TokenKind::Duration, "window duration");
                            q.finish();
                            q.end_item();
                        } else if q.at_kw("latency") {
                            q.start(K::SLO_ITEM);
                            q.bump();
                            q.expect(TokenKind::Percent, "percentage");
                            q.expect(TokenKind::LtEq, "`<=`");
                            q.expect(TokenKind::Duration, "latency bound");
                            q.expect_kw("over");
                            q.expect(TokenKind::Duration, "window duration");
                            q.finish();
                            q.end_item();
                        }
                    });
                    p.finish();
                }
                _ => {}
            }
        });
    }

    // --------------------------------------------------------------- channel
    fn channel_body(&mut self) {
        self.expect_ident("channel name");
        if self.at_kw("from") {
            self.start(K::CHANNEL_FROM);
            self.bump();
            self.qualified_name("upstream channel");
            self.finish();
        }
        self.header_decorators();
        self.block(|p| match p.current_text() {
            "distribution" => {
                p.start(K::DISTRIBUTION_DECL);
                p.bump();
                if p.at_kw("broadcast") || p.at_kw("work") {
                    p.bump();
                } else {
                    p.error("expected `broadcast` or `work`");
                }
                p.finish();
                p.end_item();
            }
            "delivery" => {
                p.start(K::DELIVERY_DECL);
                p.bump();
                p.expect_kw("at-least-once");
                p.finish();
                p.end_item();
            }
            "send-only" | "recv-only" => {
                p.start(K::DIRECTION_DECL);
                p.bump();
                p.finish();
                p.end_item();
            }
            "message" if p.nth(1) == TokenKind::Ident => {
                p.start_decl(K::MESSAGE_DECL);
                p.bump();
                p.bump();
                p.block(|q| q.field_item());
                p.finish();
            }
            _ => {}
        });
    }

    fn subscription_body(&mut self) {
        self.qualified_name("message");
        self.expect(TokenKind::Arrow, "`->`");
        self.qualified_name("handler");
        self.end_item();
    }

    fn source_body(&mut self) {
        self.expect_ident("source name");
        self.header_decorators();
        self.block(|p| {
            if p.at_kw("cron") {
                p.start(K::CRON_DECL);
                p.bump();
                p.expect(TokenKind::String, "cron expression");
                p.finish();
                p.end_item();
            } else if p.at_kw("timezone") {
                p.start(K::TIMEZONE_DECL);
                p.bump();
                p.expect(TokenKind::String, "timezone");
                p.finish();
                p.end_item();
            } else if p.at(TokenKind::Arrow) {
                p.start(K::TARGET_DECL);
                p.bump();
                p.qualified_name("target function");
                p.finish();
                p.end_item();
            }
        });
    }

    fn import_body(&mut self) {
        self.qualified_name("package or module");
        if self.at_kw("as") {
            self.bump();
            self.expect_ident("alias");
        }
        self.end_item();
    }

    // ------------------------------------------------------------ expressions
    fn expr(&mut self) {
        self.expr_bp(0);
    }
    fn binary_bp(k: TokenKind) -> Option<(u8, u8)> {
        Some(match k {
            TokenKind::PipePipe => (1, 2),
            TokenKind::AmpAmp => (3, 4),
            TokenKind::EqEq | TokenKind::BangEq | TokenKind::Lt | TokenKind::LtEq | TokenKind::Gt | TokenKind::GtEq => (5, 6),
            TokenKind::Plus | TokenKind::Minus => (7, 8),
            TokenKind::Star | TokenKind::Slash => (9, 10),
            _ => return None,
        })
    }
    fn expr_bp(&mut self, min_bp: u8) {
        let cp = self.checkpoint();
        self.primary();
        loop {
            let Some((l, r)) = Self::binary_bp(self.current()) else { break };
            if l < min_bp {
                break;
            }
            self.start_at(cp, K::BINARY_EXPR);
            self.bump();
            self.expr_bp(r);
            self.finish();
        }
    }
    fn primary(&mut self) {
        match self.current() {
            TokenKind::Minus | TokenKind::Bang => {
                self.start(K::UNARY_EXPR);
                self.bump();
                self.expr_bp(11);
                self.finish();
            }
            TokenKind::LParen => {
                self.start(K::PAREN_EXPR);
                self.bump();
                self.expr();
                self.expect(TokenKind::RParen, "`)`");
                self.finish();
            }
            TokenKind::Int | TokenKind::Decimal | TokenKind::String | TokenKind::Duration | TokenKind::Percent => {
                self.start(K::LITERAL_EXPR);
                self.bump();
                self.finish();
            }
            TokenKind::Ident if matches!(self.current_text(), "true" | "false" | "null") => {
                self.start(K::LITERAL_EXPR);
                self.bump();
                self.finish();
            }
            TokenKind::Ident => {
                let cp = self.checkpoint();
                self.start(K::NAME_EXPR);
                self.qualified_name("name");
                self.finish();
                if self.at(TokenKind::LParen) {
                    self.start_at(cp, K::CALL_EXPR);
                    self.start(K::ARG_LIST);
                    self.bump();
                    if !self.at(TokenKind::RParen) {
                        loop {
                            self.expr();
                            if self.at(TokenKind::Comma) {
                                self.bump();
                            } else {
                                break;
                            }
                        }
                    }
                    self.expect(TokenKind::RParen, "`)`");
                    self.finish();
                    self.finish();
                }
            }
            _ => {
                self.error(format!("expected an expression, found {}", self.describe()));
                if !self.at_line_end() {
                    self.bump_as(K::ERROR_TOKEN);
                }
            }
        }
    }
}
