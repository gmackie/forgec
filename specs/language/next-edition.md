# Edition 2027 (governance edition) — frozen surface

FORGE-028. Edition `2027` extends edition `2026` without changing any 2026
declaration's meaning, wire identity or physical name. A `2026` package keeps
compiling unchanged; a `2027` package may add the declarations below. Decisions
D01–D22 of `docs/post-m8/IMPLEMENTATION_PLAN.md` are binding; the following
ratifies the draft syntax in `docs/post-m8` (marked "proposal" there).

## Ratified decisions

| # | decision |
| --- | --- |
| E1 | `forge.toml` `[package] edition = "2027"` opts in. Governance declarations under edition 2026 are diagnosed (`E-ED-001`), never silently ignored. |
| E2 | Source vs binding: `.forge` declares contracts; realizations (transports, providers, credentials) live in `deploy/` and never change identity. |
| E3 | Nominal references stay: `Customer` is an identity, `Customer.Record` the record; `Customer.Record<Purpose>` is the purpose-scoped record (edition 2027). |
| E4 | Enums stay explicit; lifecycle states stay inferred from the graph with a required `initial`. |
| E5 | Identity: package + module + symbol; file moves and `@label` changes never alter ids, routes, physical names, or field lineage ids. Renames are reviewed `rename` metadata (E5 rename syntax is deferred to M17). |
| E6 | `import pkg [as alias]` (qualified references) is the only import form; brace import lists and standalone `export Name` lines from the draft are **not** adopted (a declaration is exported with the `export` prefix, as in 2026). |
| E7 | `purpose Name [extends Parent]` declares intent context. Extension describes taxonomy meaning only; it grants no field or action authority (D07). |
| E8 | `dataClass Name extends data.a.b` declares a classification facet; `@data(Class)` on a `type` or field attaches it. Classification describes data, not access (D11). Unclassified is not public (D12). |
| E9 | Inside a resource: `capability Name { includes Other; read {f…}; update {f…}; create {f…}; filter {f…}; order {f…}; actions {a…}; deny read {f…}; deny update {…}; deny actions {…} }`. Inclusion unions grants; denials are sticky through inclusion (D08). Read, create, update, query (filter/order), export and actions are distinct permissions. |
| E10 | `for Purpose { use Capability }` inside a resource binds a purpose to a resource-local surface. Only explicit `for` bindings create authority. |
| E11 | `@purposeScoped` on a resource means every interface exposes it through a purpose surface; `@subject(kind)` names the subject binding (`person`, `organization`, `device`). |
| E12 | `function { purpose X … }` declares the purpose a function runs under; its `uses` must fit the purpose surface (checked in M12). |
| E13 | Runtime restrictions intersect with the static ceiling (D09); the compiled `EffectiveCapabilityIR` is the ceiling. |
| E14 | Compilation stays offline and deterministic (D02). `[extensions]` in `forge.toml` pins adapter/taxonomy/importer manifests by name, version and digest; the compiler validates manifests and never executes extension code. |

## Grammar additions (EBNF, on top of `grammar.md`)

```ebnf
Declaration  += PurposeDecl | DataClassDecl ;
PurposeDecl   = "purpose" IDENT [ "extends" IDENT ] ;
DataClassDecl = "dataClass" IDENT "extends" QualifiedName ;

ResourceItem += CapabilityDecl | PurposeBinding ;
CapabilityDecl = "capability" IDENT "{" { NL } { CapabilityItem NL } "}" ;
CapabilityItem = "includes" IDENT
               | [ "deny" ] ( "read" | "update" | "create" | "filter" | "order" | "actions" ) "{" { QualifiedName } "}" ;
PurposeBinding = "for" QualifiedName "{" { NL } { "use" IDENT NL } "}" ;

FunctionItem += "purpose" QualifiedName ;
TypeArg      += QualifiedName ;                      (* Order.Record<OrderFulfillment> *)
Decorator names added: purposeScoped, subject(kind), data(Class), label (existing).
```

`grant` declarations (callee-owned approvals) are reviewed artifacts under
`grants/` (JSON, M16), not `.forge` syntax.

## Fixtures

- `examples/next/acme-next`, `examples/next/governance`, `examples/next/payments`
  (edition 2027) must parse without errors, be fixed points of `forge fmt`, and
  compile under edition 2027.
- `examples/acme`, `examples/payments` (edition 2026) are unchanged and keep
  their snapshots.
- A 2026 package using a 2027 declaration fails with `E-ED-001`.

## Draft forms not adopted

- Top-level `error Name { fields }`: errors stay declared in a function's
  `errors { }` block (2026); structured error payloads are deferred.
- Brace import lists and standalone `export Name` lines (see E6).
- `uses { dep for Purpose }`: adopted as `UseDecl = QualifiedName [ Capability ] [ "for" QualifiedName ]`
  (a declared dependency may name the purpose it is exercised under).
