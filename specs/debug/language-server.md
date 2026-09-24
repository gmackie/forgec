# Semantic language server

Run `forgec lsp` using standard LSP over stdio. The server uses Forge's Rowan parser and semantic compiler; source-map anchors also identify editor symbols.

Implemented requests:

- `textDocument/documentSymbol`: source declarations and named children in the document, returned as SymbolInformation.
- `workspace/symbol`: query symbols in initialized package roots and packages owning open files, plus their loaded path dependencies.
- `textDocument/definition`: resolve compiler-recorded references across files and path dependencies.
- `textDocument/references`: references in the owning package and its dependencies, with optional declarations. Dependent packages are not searched in reverse.
- `textDocument/hover`: semantic anchor, declaration header and available derivation/facet provenance.
- `textDocument/completion`: resources, functions and lifecycle transitions inside `uses`, filtered to the current module and imported exported declarations. Workflow expressions expose typed input and completed-step bindings, including member completion during parse recovery. Workflow calls, wait messages, declared failure outcomes and function catch errors have context-specific suggestions. Choice/parallel branches do not see sibling bindings. Map calls expose their typed item binding only inside that call. Type positions offer scalar, collection, shape, alias, enum, resource and channel-message names, filtered by module/import visibility; qualified names are replaced as a whole.
- Existing diagnostics and canonical formatting remain available.

Package analysis overlays unsaved documents and recursively compiles path dependencies. A visited set bounds dependency traversal. Parsed documents and package compilations are cached by content and declared dependency hashes. Changed packages receive full semantic elaboration; declaration-level invalidation remains tracked by #23. Incremental document synchronization uses UTF-16 ranges and also accepts full-buffer changes. `forge/analysisStats` reports cache counters and direct package dependencies.

The reference index records resolved types, aliases, functions, channel messages, transitions, facet applications, effective facet-field expressions, and workflow input/step-binding and map-item uses. Each map item has a distinct source anchor even when separate maps reuse the same name. Workflow binding anchors also appear in source maps. It is not a complete index of all expression locals or governance references. Recovery preserves declaration symbols when semantic compilation fails.

Remaining #21 work includes completion in other contexts beyond types/uses/workflows, richer type details in hover, complete reference coverage, and source HTTP exposure support once the language accepts that construct. Rename, semantic tokens, quick fixes and runtime overlays are follow-up features. Workspace discovery currently uses package roots supplied by initialization/open documents; it does not recursively discover every package in a monorepo.
