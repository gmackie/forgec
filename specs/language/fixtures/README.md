# Shared syntax fixtures

- `valid`: both the canonical Rowan parser and Tree-sitter must parse without
  syntax errors. These are syntax fixtures, not necessarily complete packages
  that pass semantic compilation.
- `invalid`: Rowan must diagnose the source; Tree-sitter must preserve useful
  surrounding structure.
- `recovery`: incomplete edits and proposed constructs that are not accepted by
  Rowan yet. Recovery must not imply language support.

`cargo test -p tree-sitter-forge` consumes these fixtures and all checked-in
example Forge sources. New language syntax needs a valid fixture plus grammar
and query updates. Diagnostics and semantic validity always belong to Forge's
canonical parser/compiler, never to Tree-sitter.
