# Semantic language server

Run `forgec lsp` using standard LSP over stdio. The server uses Forge's Rowan parser and semantic compiler; source-map anchors also identify editor symbols.

Implemented requests:

- `textDocument/documentSymbol`: source declarations and named children in the document, returned as SymbolInformation.
- `workspace/symbol`: query symbols in initialized package roots and packages owning open files, plus their loaded path dependencies.
- `textDocument/definition`: resolve compiler-recorded references across files and path dependencies.
- `textDocument/references`: references in the owning package and its dependencies, with optional declarations. Dependent packages are not searched in reverse.
- `textDocument/hover`: semantic anchor, declaration header and available derivation/facet provenance.
- `textDocument/completion`: resources, functions and lifecycle transitions inside `uses`, filtered to the current module and imported exported declarations. Other contexts currently return no suggestions.
- Existing diagnostics and canonical formatting remain available.

Package analysis overlays unsaved documents and recursively compiles path dependencies. A visited set bounds dependency traversal. Analysis is rebuilt per request; caching and fine-grained invalidation remain tracked by #23. Full document synchronization is retained.

The reference index records resolved types, aliases, functions, channel messages, transitions, facet applications and effective facet-field expressions. It is not a complete index of expression locals, workflow bindings or all governance references. Recovery preserves declaration symbols when semantic compilation fails.

Remaining #21 work includes reusable cached index ownership, workflow-aware and general completion, richer type details in hover, complete reference coverage, and source HTTP exposure support once the language accepts that construct. Rename, semantic tokens, quick fixes and runtime overlays are follow-up features. Workspace discovery currently uses package roots supplied by initialization/open documents; it does not recursively discover every package in a monorepo.
