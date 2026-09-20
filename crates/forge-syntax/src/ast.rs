//! Typed views over the untyped rowan tree. Accessors return `Option` so a
//! partially parsed file can still be inspected.

use crate::syntax_kind::{SyntaxKind as K, SyntaxNode, SyntaxToken};
use rowan::TextRange;

pub trait AstNode: Sized {
    fn cast(node: SyntaxNode) -> Option<Self>;
    fn syntax(&self) -> &SyntaxNode;
    fn range(&self) -> TextRange {
        self.syntax().text_range()
    }
}

macro_rules! node {
    ($name:ident, $kind:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash)]
        pub struct $name(SyntaxNode);
        impl AstNode for $name {
            fn cast(node: SyntaxNode) -> Option<Self> {
                (node.kind() == K::$kind).then_some(Self(node))
            }
            fn syntax(&self) -> &SyntaxNode {
                &self.0
            }
        }
    };
}

fn child<N: AstNode>(node: &SyntaxNode) -> Option<N> {
    node.children().find_map(N::cast)
}
fn children<N: AstNode + 'static>(node: &SyntaxNode) -> impl Iterator<Item = N> + use<'_, N> {
    node.children().filter_map(N::cast)
}
fn tokens(node: &SyntaxNode) -> impl Iterator<Item = SyntaxToken> + '_ {
    node.children_with_tokens().filter_map(|e| e.into_token())
}
fn idents(node: &SyntaxNode) -> impl Iterator<Item = SyntaxToken> + '_ {
    tokens(node).filter(|t| t.kind() == K::IDENT)
}
fn string_token(node: &SyntaxNode) -> Option<String> {
    tokens(node).find(|t| t.kind() == K::STRING).map(|t| unquote(t.text()))
}
pub fn unquote(s: &str) -> String {
    let inner = &s[1..s.len() - 1];
    let mut out = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(o) => out.push(o),
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Doc comment lines directly inside a node (the parser places them there).
pub fn doc_of(node: &SyntaxNode) -> Option<String> {
    let lines: Vec<String> = tokens(node)
        .take_while(|t| matches!(t.kind(), K::DOC_COMMENT | K::WHITESPACE | K::NEWLINE))
        .filter(|t| t.kind() == K::DOC_COMMENT)
        .map(|t| t.text().trim_start_matches("///").trim().to_string())
        .collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

node!(Root, ROOT);
impl Root {
    pub fn declarations(&self) -> impl Iterator<Item = Declaration> + '_ {
        self.0.children().filter_map(Declaration::cast)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Declaration {
    Module(ModuleDecl),
    Import(ImportDecl),
    Enum(EnumDecl),
    Type(TypeDecl),
    Shape(ShapeDecl),
    Resource(ResourceDecl),
    Function(FunctionDecl),
    Channel(ChannelDecl),
    Source(SourceDecl),
    Subscription(SubscriptionDecl),
}
impl Declaration {
    pub fn cast(node: SyntaxNode) -> Option<Self> {
        Some(match node.kind() {
            K::MODULE_DECL => Self::Module(ModuleDecl(node)),
            K::IMPORT_DECL => Self::Import(ImportDecl(node)),
            K::ENUM_DECL => Self::Enum(EnumDecl(node)),
            K::TYPE_DECL => Self::Type(TypeDecl(node)),
            K::SHAPE_DECL => Self::Shape(ShapeDecl(node)),
            K::RESOURCE_DECL => Self::Resource(ResourceDecl(node)),
            K::FUNCTION_DECL => Self::Function(FunctionDecl(node)),
            K::CHANNEL_DECL => Self::Channel(ChannelDecl(node)),
            K::SOURCE_DECL => Self::Source(SourceDecl(node)),
            K::SUBSCRIPTION_DECL => Self::Subscription(SubscriptionDecl(node)),
            _ => return None,
        })
    }
    pub fn syntax(&self) -> &SyntaxNode {
        match self {
            Self::Module(n) => &n.0,
            Self::Import(n) => &n.0,
            Self::Enum(n) => &n.0,
            Self::Type(n) => &n.0,
            Self::Shape(n) => &n.0,
            Self::Resource(n) => &n.0,
            Self::Function(n) => &n.0,
            Self::Channel(n) => &n.0,
            Self::Source(n) => &n.0,
            Self::Subscription(n) => &n.0,
        }
    }
    pub fn is_exported(&self) -> bool {
        idents(self.syntax()).next().is_some_and(|t| t.text() == "export")
    }
    /// The declared name (None for import/module/subscription).
    pub fn name(&self) -> Option<SyntaxToken> {
        match self {
            Self::Module(_) | Self::Import(_) | Self::Subscription(_) => None,
            _ => idents(self.syntax()).find(|t| !matches!(t.text(), "export" | "enum" | "type" | "shape" | "resource" | "function" | "channel" | "source")),
        }
    }
    pub fn doc(&self) -> Option<String> {
        doc_of(self.syntax())
    }
}

node!(ModuleDecl, MODULE_DECL);
impl ModuleDecl {
    pub fn path(&self) -> Option<QualifiedName> {
        child(&self.0)
    }
}
node!(ImportDecl, IMPORT_DECL);
impl ImportDecl {
    pub fn path(&self) -> Option<QualifiedName> {
        child(&self.0)
    }
    pub fn alias(&self) -> Option<SyntaxToken> {
        let mut it = idents(&self.0).skip_while(|t| t.text() != "as");
        it.next()?;
        it.next()
    }
}

node!(QualifiedName, QUALIFIED_NAME);
impl QualifiedName {
    pub fn segments(&self) -> Vec<String> {
        idents(&self.0).map(|t| t.text().to_string()).collect()
    }
    pub fn text(&self) -> String {
        self.segments().join(".")
    }
}

node!(EnumDecl, ENUM_DECL);
impl EnumDecl {
    pub fn name(&self) -> Option<SyntaxToken> {
        idents(&self.0).find(|t| !matches!(t.text(), "export" | "enum"))
    }
    pub fn members(&self) -> impl Iterator<Item = EnumMember> + '_ {
        children(&self.0)
    }
}
node!(EnumMember, ENUM_MEMBER);
impl EnumMember {
    pub fn name(&self) -> Option<SyntaxToken> {
        idents(&self.0).next()
    }
    pub fn value(&self) -> Option<String> {
        string_token(&self.0)
    }
    pub fn doc(&self) -> Option<String> {
        doc_of(&self.0)
    }
}

node!(TypeDecl, TYPE_DECL);
impl TypeDecl {
    pub fn name(&self) -> Option<SyntaxToken> {
        idents(&self.0).find(|t| !matches!(t.text(), "export" | "type"))
    }
    pub fn type_expr(&self) -> Option<TypeExpr> {
        child(&self.0)
    }
}

node!(ShapeDecl, SHAPE_DECL);
impl ShapeDecl {
    pub fn name(&self) -> Option<SyntaxToken> {
        idents(&self.0).find(|t| !matches!(t.text(), "export" | "shape"))
    }
    pub fn fields(&self) -> impl Iterator<Item = FieldDecl> + '_ {
        children(&self.0)
    }
}

node!(TypeExpr, TYPE_EXPR);
impl TypeExpr {
    pub fn type_ref(&self) -> Option<TypeRef> {
        child(&self.0)
    }
    pub fn is_optional(&self) -> bool {
        tokens(&self.0).any(|t| t.kind() == K::QUESTION)
    }
    pub fn refinements(&self) -> impl Iterator<Item = Refinement> + '_ {
        children(&self.0)
    }
}
node!(TypeRef, TYPE_REF);
impl TypeRef {
    pub fn name(&self) -> Option<QualifiedName> {
        child(&self.0)
    }
    pub fn args(&self) -> Vec<String> {
        child::<TypeArgs>(&self.0).map(|a| a.values()).unwrap_or_default()
    }
}
node!(TypeArgs, TYPE_ARGS);
impl TypeArgs {
    pub fn values(&self) -> Vec<String> {
        children::<TypeArg>(&self.0).filter_map(|a| tokens(&a.0).find(|t| !t.kind().is_trivia()).map(|t| t.text().to_string())).collect()
    }
}
node!(TypeArg, TYPE_ARG);
node!(Refinement, REFINEMENT);
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefinementKind {
    Normalizer(String),
    LengthRange { min: u64, max: u64 },
    LengthCompare { op: String, bound: u64 },
    Compare { op: String, literal: String },
    Pattern(String),
}
impl Refinement {
    pub fn kind(&self) -> Option<RefinementKind> {
        let toks: Vec<SyntaxToken> = tokens(&self.0).filter(|t| !t.kind().is_trivia()).collect();
        let first = toks.first()?;
        Some(match (first.kind(), first.text()) {
            (K::IDENT, "trim" | "uppercase" | "lowercase") => RefinementKind::Normalizer(first.text().to_string()),
            (K::IDENT, "length") => {
                if let Some(range) = child::<RangeNode>(&self.0) {
                    let (min, max) = range.bounds()?;
                    RefinementKind::LengthRange { min, max }
                } else {
                    RefinementKind::LengthCompare { op: toks.get(1)?.text().to_string(), bound: toks.get(2)?.text().parse().ok()? }
                }
            }
            (K::IDENT, "pattern") => RefinementKind::Pattern(string_token(&self.0)?),
            (K::LT | K::LT_EQ | K::GT | K::GT_EQ | K::EQ_EQ | K::BANG_EQ, op) => {
                let lit = child::<LiteralExpr>(&self.0)?;
                RefinementKind::Compare { op: op.to_string(), literal: lit.text() }
            }
            _ => return None,
        })
    }
}
node!(RangeNode, RANGE);
impl RangeNode {
    pub fn bounds(&self) -> Option<(u64, u64)> {
        let mut ints = tokens(&self.0).filter(|t| t.kind() == K::INT);
        Some((ints.next()?.text().parse().ok()?, ints.next()?.text().parse().ok()?))
    }
}

node!(FieldDecl, FIELD_DECL);
impl FieldDecl {
    pub fn name(&self) -> Option<SyntaxToken> {
        idents(&self.0).next()
    }
    pub fn type_expr(&self) -> Option<TypeExpr> {
        child(&self.0)
    }
    pub fn default(&self) -> Option<Expr> {
        child::<DefaultValue>(&self.0).and_then(|d| d.expr())
    }
    pub fn derived(&self) -> Option<Expr> {
        child::<DerivedValue>(&self.0).and_then(|d| d.expr())
    }
    pub fn decorators(&self) -> impl Iterator<Item = Decorator> + '_ {
        children(&self.0)
    }
    pub fn doc(&self) -> Option<String> {
        doc_of(&self.0)
    }
}
node!(DefaultValue, DEFAULT_VALUE);
impl DefaultValue {
    pub fn expr(&self) -> Option<Expr> {
        self.0.children().find_map(Expr::cast)
    }
}
node!(DerivedValue, DERIVED_VALUE);
impl DerivedValue {
    pub fn expr(&self) -> Option<Expr> {
        self.0.children().find_map(Expr::cast)
    }
}

node!(Decorator, DECORATOR);
impl Decorator {
    pub fn name(&self) -> Option<SyntaxToken> {
        idents(&self.0).next()
    }
    pub fn args(&self) -> Vec<DecoratorArg> {
        child::<DecoratorArgs>(&self.0).map(|a| children(&a.0).collect()).unwrap_or_default()
    }
}
node!(DecoratorArgs, DECORATOR_ARGS);
node!(DecoratorArg, DECORATOR_ARG);
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArgValue {
    Literal(String),
    Name(Vec<String>),
    List(Vec<ArgValue>),
}
impl DecoratorArg {
    pub fn label(&self) -> Option<String> {
        let toks: Vec<SyntaxToken> = tokens(&self.0).filter(|t| !t.kind().is_trivia()).collect();
        (toks.len() >= 2 && toks[0].kind() == K::IDENT && toks[1].kind() == K::COLON).then(|| toks[0].text().to_string())
    }
    pub fn value(&self) -> Option<ArgValue> {
        Self::value_of(&self.0)
    }
    fn value_of(node: &SyntaxNode) -> Option<ArgValue> {
        for c in node.children() {
            match c.kind() {
                K::LITERAL_EXPR => return Some(ArgValue::Literal(LiteralExpr(c).text())),
                K::QUALIFIED_NAME => return Some(ArgValue::Name(QualifiedName(c).segments())),
                K::LIST_LITERAL => {
                    let items = c
                        .children()
                        .filter_map(|e| match e.kind() {
                            K::LITERAL_EXPR => Some(ArgValue::Literal(LiteralExpr(e).text())),
                            K::QUALIFIED_NAME => Some(ArgValue::Name(QualifiedName(e).segments())),
                            _ => None,
                        })
                        .collect();
                    return Some(ArgValue::List(items));
                }
                _ => {}
            }
        }
        None
    }
}

node!(ResourceDecl, RESOURCE_DECL);
impl ResourceDecl {
    pub fn name(&self) -> Option<SyntaxToken> {
        idents(&self.0).find(|t| !matches!(t.text(), "export" | "resource"))
    }
    pub fn decorators(&self) -> impl Iterator<Item = Decorator> + '_ {
        children(&self.0)
    }
    pub fn fields(&self) -> impl Iterator<Item = FieldDecl> + '_ {
        children(&self.0)
    }
    pub fn uniques(&self) -> impl Iterator<Item = UniqueDecl> + '_ {
        children(&self.0)
    }
    pub fn finds(&self) -> impl Iterator<Item = FindDecl> + '_ {
        children(&self.0)
    }
    pub fn lists(&self) -> impl Iterator<Item = ListDecl> + '_ {
        children(&self.0)
    }
    pub fn rules(&self) -> Option<RulesBlock> {
        child(&self.0)
    }
    pub fn lifecycle(&self) -> Option<LifecycleBlock> {
        child(&self.0)
    }
}
node!(UniqueDecl, UNIQUE_DECL);
impl UniqueDecl {
    pub fn fields(&self) -> Vec<String> {
        children::<FieldList>(&self.0).next().map(|f| f.names()).unwrap_or_default()
    }
    pub fn within(&self) -> Vec<String> {
        children::<FieldList>(&self.0).nth(1).map(|f| f.names()).unwrap_or_default()
    }
}
node!(FieldList, FIELD_LIST);
impl FieldList {
    pub fn names(&self) -> Vec<String> {
        idents(&self.0).map(|t| t.text().to_string()).collect()
    }
    pub fn name_tokens(&self) -> Vec<SyntaxToken> {
        idents(&self.0).collect()
    }
}
node!(FindDecl, FIND_DECL);
impl FindDecl {
    pub fn fields(&self) -> Option<FieldList> {
        child(&self.0)
    }
}
node!(ListDecl, LIST_DECL);
impl ListDecl {
    pub fn fields(&self) -> Option<FieldList> {
        child(&self.0)
    }
    pub fn order(&self) -> Vec<(String, String)> {
        child::<OrderList>(&self.0)
            .map(|o| {
                children::<OrderKey>(&o.0)
                    .filter_map(|k| {
                        let mut it = idents(&k.0);
                        let f = it.next()?.text().to_string();
                        let dir = it.next().map(|d| d.text().to_string()).unwrap_or_else(|| "asc".into());
                        Some((f, dir))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}
node!(OrderList, ORDER_LIST);
node!(OrderKey, ORDER_KEY);
node!(RulesBlock, RULES_BLOCK);
impl RulesBlock {
    pub fn rules(&self) -> impl Iterator<Item = Rule> + '_ {
        children(&self.0)
    }
}
node!(Rule, RULE);
impl Rule {
    pub fn expr(&self) -> Option<Expr> {
        self.0.children().find_map(Expr::cast)
    }
}

node!(LifecycleBlock, LIFECYCLE_BLOCK);
impl LifecycleBlock {
    pub fn field_name(&self) -> Option<SyntaxToken> {
        idents(&self.0).nth(1)
    }
    pub fn initials(&self) -> impl Iterator<Item = InitialDecl> + '_ {
        children(&self.0)
    }
    pub fn terminals(&self) -> impl Iterator<Item = TerminalDecl> + '_ {
        children(&self.0)
    }
    pub fn transitions(&self) -> impl Iterator<Item = TransitionDecl> + '_ {
        children(&self.0)
    }
}
node!(InitialDecl, INITIAL_DECL);
impl InitialDecl {
    pub fn state(&self) -> Option<SyntaxToken> {
        idents(&self.0).nth(1)
    }
}
node!(TerminalDecl, TERMINAL_DECL);
impl TerminalDecl {
    pub fn state(&self) -> Option<SyntaxToken> {
        idents(&self.0).nth(1)
    }
}
node!(TransitionDecl, TRANSITION_DECL);
impl TransitionDecl {
    pub fn action(&self) -> Option<SyntaxToken> {
        idents(&self.0).next()
    }
    pub fn sources(&self) -> Vec<SyntaxToken> {
        child::<StateSet>(&self.0).map(|s| idents(&s.0).collect()).unwrap_or_default()
    }
    pub fn target(&self) -> Option<SyntaxToken> {
        let mut after_arrow = false;
        for t in tokens(&self.0) {
            if t.kind() == K::ARROW {
                after_arrow = true;
            } else if after_arrow && t.kind() == K::IDENT {
                return Some(t);
            }
        }
        None
    }
    pub fn input(&self) -> Option<InputBlock> {
        child(&self.0)
    }
    pub fn doc(&self) -> Option<String> {
        doc_of(&self.0)
    }
}
node!(StateSet, STATE_SET);
node!(InputBlock, INPUT_BLOCK);
impl InputBlock {
    pub fn fields(&self) -> impl Iterator<Item = FieldDecl> + '_ {
        children(&self.0)
    }
}

node!(FunctionDecl, FUNCTION_DECL);
impl FunctionDecl {
    pub fn name(&self) -> Option<SyntaxToken> {
        idents(&self.0).find(|t| !matches!(t.text(), "export" | "function"))
    }
    pub fn decorators(&self) -> impl Iterator<Item = Decorator> + '_ {
        children(&self.0)
    }
    pub fn input(&self) -> Option<QualifiedName> {
        child::<FunctionInput>(&self.0).and_then(|i| child::<TypeRef>(&i.0)).and_then(|t| t.name())
    }
    pub fn output(&self) -> Option<QualifiedName> {
        child::<FunctionOutput>(&self.0).and_then(|i| child::<TypeRef>(&i.0)).and_then(|t| t.name())
    }
    pub fn uses(&self) -> Vec<UseDecl> {
        child::<UsesBlock>(&self.0).map(|b| children(&b.0).collect()).unwrap_or_default()
    }
    pub fn sends(&self) -> Vec<SendDecl> {
        child::<SendsBlock>(&self.0).map(|b| children(&b.0).collect()).unwrap_or_default()
    }
    pub fn errors(&self) -> Vec<SyntaxToken> {
        child::<ErrorsBlock>(&self.0).map(|b| children::<ErrorDecl>(&b.0).filter_map(|e| idents(&e.0).next()).collect()).unwrap_or_default()
    }
    pub fn slo(&self) -> Vec<SloItem> {
        child::<SloBlock>(&self.0).map(|b| children(&b.0).collect()).unwrap_or_default()
    }
}
node!(FunctionInput, FUNCTION_INPUT);
node!(FunctionOutput, FUNCTION_OUTPUT);
node!(UsesBlock, USES_BLOCK);
node!(UseDecl, USE_DECL);
impl UseDecl {
    pub fn target(&self) -> Option<QualifiedName> {
        child(&self.0)
    }
    pub fn capability(&self) -> Option<String> {
        tokens(&self.0).filter(|t| t.kind() == K::IDENT).last().filter(|t| matches!(t.text(), "read" | "write" | "create" | "delete")).map(|t| t.text().to_string())
    }
}
node!(SendsBlock, SENDS_BLOCK);
node!(SendDecl, SEND_DECL);
impl SendDecl {
    pub fn message(&self) -> Option<SyntaxToken> {
        idents(&self.0).next()
    }
    pub fn channel(&self) -> Option<QualifiedName> {
        child(&self.0)
    }
}
node!(ErrorsBlock, ERRORS_BLOCK);
node!(ErrorDecl, ERROR_DECL);
node!(SloBlock, SLO_BLOCK);
node!(SloItem, SLO_ITEM);
impl SloItem {
    /// ("availability", pct, None, window) or ("latency", pct, Some(bound), window)
    pub fn parts(&self) -> Option<(String, String, Option<String>, String)> {
        let toks: Vec<SyntaxToken> = tokens(&self.0).filter(|t| !t.kind().is_trivia()).collect();
        let kind = toks.first()?.text().to_string();
        let pct = toks.iter().find(|t| t.kind() == K::PERCENT)?.text().to_string();
        let durs: Vec<String> = toks.iter().filter(|t| t.kind() == K::DURATION).map(|t| t.text().to_string()).collect();
        Some(if kind == "latency" { (kind, pct, durs.first().cloned(), durs.get(1)?.clone()) } else { (kind, pct, None, durs.first()?.clone()) })
    }
}

node!(ChannelDecl, CHANNEL_DECL);
impl ChannelDecl {
    pub fn name(&self) -> Option<SyntaxToken> {
        idents(&self.0).find(|t| !matches!(t.text(), "export" | "channel"))
    }
    pub fn from(&self) -> Option<QualifiedName> {
        child::<ChannelFrom>(&self.0).and_then(|f| child(&f.0))
    }
    pub fn distribution(&self) -> Option<String> {
        child::<DistributionDecl>(&self.0).and_then(|d| idents(&d.0).nth(1)).map(|t| t.text().to_string())
    }
    pub fn delivery(&self) -> Option<String> {
        child::<DeliveryDecl>(&self.0).and_then(|d| idents(&d.0).nth(1)).map(|t| t.text().to_string())
    }
    pub fn direction(&self) -> Option<String> {
        child::<DirectionDecl>(&self.0).and_then(|d| idents(&d.0).next()).map(|t| t.text().to_string())
    }
    pub fn messages(&self) -> impl Iterator<Item = MessageDecl> + '_ {
        children(&self.0)
    }
}
node!(ChannelFrom, CHANNEL_FROM);
node!(DistributionDecl, DISTRIBUTION_DECL);
node!(DeliveryDecl, DELIVERY_DECL);
node!(DirectionDecl, DIRECTION_DECL);
node!(MessageDecl, MESSAGE_DECL);
impl MessageDecl {
    pub fn name(&self) -> Option<SyntaxToken> {
        idents(&self.0).nth(1)
    }
    pub fn fields(&self) -> impl Iterator<Item = FieldDecl> + '_ {
        children(&self.0)
    }
    pub fn doc(&self) -> Option<String> {
        doc_of(&self.0)
    }
}

node!(SourceDecl, SOURCE_DECL);
impl SourceDecl {
    pub fn name(&self) -> Option<SyntaxToken> {
        idents(&self.0).find(|t| !matches!(t.text(), "export" | "source"))
    }
    pub fn cron(&self) -> Option<String> {
        child::<CronDecl>(&self.0).and_then(|c| string_token(&c.0))
    }
    pub fn timezone(&self) -> Option<String> {
        child::<TimezoneDecl>(&self.0).and_then(|c| string_token(&c.0))
    }
    pub fn target(&self) -> Option<QualifiedName> {
        child::<TargetDecl>(&self.0).and_then(|t| child(&t.0))
    }
}
node!(CronDecl, CRON_DECL);
node!(TimezoneDecl, TIMEZONE_DECL);
node!(TargetDecl, TARGET_DECL);

node!(SubscriptionDecl, SUBSCRIPTION_DECL);
impl SubscriptionDecl {
    pub fn message(&self) -> Option<QualifiedName> {
        children::<QualifiedName>(&self.0).next()
    }
    pub fn handler(&self) -> Option<QualifiedName> {
        children::<QualifiedName>(&self.0).nth(1)
    }
}

// ------------------------------------------------------------------ exprs
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Expr {
    Binary(BinaryExpr),
    Unary(UnaryExpr),
    Call(CallExpr),
    Name(NameExpr),
    Literal(LiteralExpr),
    Paren(ParenExpr),
}
impl Expr {
    pub fn cast(node: SyntaxNode) -> Option<Self> {
        Some(match node.kind() {
            K::BINARY_EXPR => Self::Binary(BinaryExpr(node)),
            K::UNARY_EXPR => Self::Unary(UnaryExpr(node)),
            K::CALL_EXPR => Self::Call(CallExpr(node)),
            K::NAME_EXPR => Self::Name(NameExpr(node)),
            K::LITERAL_EXPR => Self::Literal(LiteralExpr(node)),
            K::PAREN_EXPR => Self::Paren(ParenExpr(node)),
            _ => return None,
        })
    }
    pub fn syntax(&self) -> &SyntaxNode {
        match self {
            Self::Binary(n) => &n.0,
            Self::Unary(n) => &n.0,
            Self::Call(n) => &n.0,
            Self::Name(n) => &n.0,
            Self::Literal(n) => &n.0,
            Self::Paren(n) => &n.0,
        }
    }
}
node!(BinaryExpr, BINARY_EXPR);
impl BinaryExpr {
    pub fn op(&self) -> Option<String> {
        tokens(&self.0).find(|t| !t.kind().is_trivia() && t.kind() != K::NEWLINE).map(|t| t.text().to_string())
    }
    pub fn lhs(&self) -> Option<Expr> {
        self.0.children().filter_map(Expr::cast).next()
    }
    pub fn rhs(&self) -> Option<Expr> {
        self.0.children().filter_map(Expr::cast).nth(1)
    }
}
node!(UnaryExpr, UNARY_EXPR);
impl UnaryExpr {
    pub fn op(&self) -> Option<String> {
        tokens(&self.0).find(|t| !t.kind().is_trivia()).map(|t| t.text().to_string())
    }
    pub fn operand(&self) -> Option<Expr> {
        self.0.children().find_map(Expr::cast)
    }
}
node!(CallExpr, CALL_EXPR);
impl CallExpr {
    pub fn callee(&self) -> Option<NameExpr> {
        child(&self.0)
    }
    pub fn args(&self) -> Vec<Expr> {
        child::<ArgList>(&self.0).map(|a| a.0.children().filter_map(Expr::cast).collect()).unwrap_or_default()
    }
}
node!(ArgList, ARG_LIST);
node!(NameExpr, NAME_EXPR);
impl NameExpr {
    pub fn name(&self) -> Option<QualifiedName> {
        child(&self.0)
    }
    pub fn segments(&self) -> Vec<String> {
        self.name().map(|n| n.segments()).unwrap_or_default()
    }
}
node!(LiteralExpr, LITERAL_EXPR);
impl LiteralExpr {
    pub fn text(&self) -> String {
        tokens(&self.0).find(|t| !t.kind().is_trivia()).map(|t| t.text().to_string()).unwrap_or_default()
    }
    pub fn token(&self) -> Option<SyntaxToken> {
        tokens(&self.0).find(|t| !t.kind().is_trivia())
    }
}
node!(ParenExpr, PAREN_EXPR);
impl ParenExpr {
    pub fn inner(&self) -> Option<Expr> {
        self.0.children().find_map(Expr::cast)
    }
}
