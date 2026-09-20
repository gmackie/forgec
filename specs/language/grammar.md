# Grammar (edition 2026)

EBNF. `NL` is a newline or `;`. `{ x }` repetition, `[ x ]` optional,
`( a | b )` alternation. Terminals are quoted or UPPERCASE token names from
`lexical.md`. Trivia is implicit. Items inside a `{ }` block are separated by
`NL`; trailing `NL` is allowed everywhere.

```ebnf
File          = { NL } { Declaration { NL } } ;

Declaration   = [ DocComment ] [ "export" ] ( EnumDecl | TypeDecl | ShapeDecl
              | ResourceDecl | FunctionDecl | ChannelDecl | SourceDecl
              | SubscriptionDecl | ImportDecl | ModuleDecl ) ;

ModuleDecl    = "module" QualifiedName ;
ImportDecl    = "import" QualifiedName [ "as" IDENT ] ;
QualifiedName = IDENT { "." IDENT } ;

(* ---------- types ---------- *)
EnumDecl      = "enum" IDENT "{" { NL } { EnumMember NL } "}" ;
EnumMember    = [ DocComment ] IDENT [ "=" STRING ] ;

TypeDecl      = "type" IDENT "=" TypeExpr ;
ShapeDecl     = "shape" IDENT "{" { NL } { FieldDecl NL } "}" ;

TypeExpr      = TypeRef [ "?" ] { Refinement } ;
TypeRef       = QualifiedName [ "<" TypeArgs ">" ] ;
TypeArgs      = TypeArg { "," TypeArg } ;
TypeArg       = IDENT | INT | STRING ;                 (* money<USD>, decimal<2> *)

Refinement    = Normalizer | LengthConstraint | CompareConstraint | PatternConstraint ;
Normalizer    = "trim" | "uppercase" | "lowercase" ;
LengthConstraint = "length" ( Range | CompareOp INT ) ;
CompareConstraint = CompareOp Literal ;
PatternConstraint = "pattern" STRING ;
Range         = INT ".." INT ;
CompareOp     = "<" | "<=" | ">" | ">=" | "==" | "!=" ;

(* ---------- fields ---------- *)
FieldDecl     = [ DocComment ] IDENT ( ":" TypeExpr [ "=" Expr ] | ":=" Expr ) { Decorator } ;

Decorator     = "@" IDENT [ "(" [ DecoratorArgs ] ")" ] ;
DecoratorArgs = DecoratorArg { "," DecoratorArg } ;
DecoratorArg  = [ IDENT ":" ] ( Literal | IDENT | ListLiteral | "POST" | "GET" | "PUT" | "PATCH" | "DELETE" ) ;
ListLiteral   = "[" [ ( Literal | IDENT ) { "," ( Literal | IDENT ) } ] "]" ;

(* ---------- resource ---------- *)
ResourceDecl  = "resource" IDENT { Decorator } "{" { NL } { ResourceItem NL } "}" ;
ResourceItem  = FieldDecl | UniqueDecl | FindDecl | ListDecl | RulesBlock | LifecycleBlock ;

UniqueDecl    = "unique" IDENT { "," IDENT } [ "within" IDENT { "," IDENT } ] ;
FindDecl      = "find" "by" FieldList ;
ListDecl      = "list" "by" FieldList [ NL "order" "by" OrderList ] ;
FieldList     = IDENT { "," IDENT } ;
OrderList     = OrderKey { "," OrderKey } ;
OrderKey      = IDENT [ "asc" | "desc" ] ;

RulesBlock    = "rules" "{" { NL } { Expr NL } "}" ;

LifecycleBlock = "lifecycle" IDENT "{" { NL } { LifecycleItem NL } "}" ;
LifecycleItem = "initial" IDENT
              | "terminal" IDENT
              | TransitionDecl ;
TransitionDecl = IDENT ":" StateSet "->" IDENT [ NL InputBlock ] ;
StateSet      = IDENT { "|" IDENT } ;
InputBlock    = "input" "{" { NL } { FieldDecl NL } "}" ;

(* ---------- function ---------- *)
FunctionDecl  = "function" IDENT { Decorator } "{" { NL } { FunctionItem NL } "}" ;
FunctionItem  = "input" TypeRef
              | "output" TypeRef
              | "uses" "{" { NL } { UseDecl NL } "}"
              | "sends" "{" { NL } { SendDecl NL } "}"
              | "errors" "{" { NL } { IDENT NL } "}"
              | SloBlock ;
UseDecl       = QualifiedName [ Capability ] ;
Capability    = "read" | "write" | "create" | "delete" ;
SendDecl      = IDENT "to" QualifiedName ;
SloBlock      = "slo" "{" { NL } { SloItem NL } "}" ;
SloItem       = "availability" PERCENT "over" DURATION
              | "latency" PERCENT "<=" DURATION "over" DURATION ;

(* ---------- channel / source / subscription ---------- *)
ChannelDecl   = "channel" IDENT [ "from" QualifiedName ] "{" { NL } { ChannelItem NL } "}" ;
ChannelItem   = "distribution" ( "broadcast" | "work" )
              | "delivery" "at-least-once"
              | "send-only" | "recv-only"
              | "message" IDENT "{" { NL } { FieldDecl NL } "}" ;

SubscriptionDecl = "on" QualifiedName "->" QualifiedName ;

SourceDecl    = "source" IDENT "{" { NL } { SourceItem NL } "}" ;
SourceItem    = "cron" STRING
              | "timezone" STRING
              | "->" QualifiedName ;

(* ---------- expressions (Pratt) ---------- *)
Expr          = OrExpr ;
OrExpr        = AndExpr { "||" AndExpr } ;
AndExpr       = CmpExpr { "&&" CmpExpr } ;
CmpExpr       = AddExpr [ CompareOp AddExpr ] ;
AddExpr       = MulExpr { ( "+" | "-" ) MulExpr } ;
MulExpr       = Unary { ( "*" | "/" ) Unary } ;
Unary         = [ "-" | "!" ] Primary ;
Primary       = Literal | QualifiedName [ "(" [ Expr { "," Expr } ] ")" ] | "(" Expr ")" ;
Literal       = INT | DECIMAL | STRING | "true" | "false" | "null" ;

DocComment    = { "///" text NL } ;
```

## Notes binding the grammar to semantics

- `Customer` used as a `TypeExpr` denotes a **reference**; `Customer.Record`
  the record shape; `Customer.Id` the identity type (§5.1 of the plan).
- `:=` declares a derived field; it may not carry a default or `@immutable`.
- `unique code within customer` is the composite-uniqueness form; `@unique`
  on a field is sugar for a single-field `unique`.
- `find by a, b` generates a zero-or-one lookup and must be covered by a
  declared unique claim; `list by` generates a bounded page query with the
  declared ordering (+ id tie-breaker).
- `lifecycle status { ... }` names the synthesized field and enum
  `<Resource>.Status`. States are inferred from transitions; `initial` is
  required in v1.
- Decorator arguments are positional or named; the elaborator validates them
  per decorator (`@crud(path)`, `@http(METHOD, path)`,
  `@effectiveDated(uniqueBy: [site])`).
- Newline sensitivity: `list by site, status` followed by an indented
  `order by createdAt desc` on the next line is one `ListDecl` because
  `order` cannot start a `ResourceItem`. This is the only place the parser
  looks past a newline.

## Error recovery

The parser is recovery-oriented: on an unexpected token it records a
diagnostic, skips to the next `NL` at the current block depth (or the matching
`}`), and continues. A file with syntax errors still yields a full lossless
tree so `forge fmt` can preserve unknown regions verbatim and the LSP can
offer symbols from the parts that parsed.
