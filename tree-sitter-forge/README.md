# Tree-sitter Forge

Editor-local syntax for `.forge` files. The Rowan parser and Forge semantic
compiler remain authoritative for syntax validity, diagnostics, name resolution,
and type checking. This grammar supplies highlighting, folding, indentation,
structural selection, and tags without starting the language server.

The package includes generated C (Tree-sitter ABI 15), a Rust language binding,
and queries for highlights, folds, indents, locals, and tags. Nothing has been
published to an editor registry or package registry automatically.

## Supported surface

The current editions' resources, blobs, fields/refinements, enums, shapes, aliases,
functions/uses, channels/subscriptions, sources/schedules, workflows, views,
projections, caches, purposes, classifications, and capability blocks are covered.
References in queries are syntactic only; local captures do not resolve packages.

Facets (#19), collections (#17), work queues (#8), and actors (#16) are pending
compiler features. They are not advertised as supported language syntax here.
A proposed facet is included in the recovery corpus, so a following resource
remains navigable without implying the compiler accepts the facet. Source
fixtures use the canonical `source ... { -> Function }` form; proposed resource
exposure syntax must land in the compiler before entering the valid corpus.

The editor parser deliberately tolerates whitespace/newline placement more
broadly than Rowan. An error-free Tree-sitter tree is not proof of a valid Forge
program. Run `forgec check` or use `forgec lsp` for authoritative diagnostics.

## Development and drift checks

From the repository root:

```sh
cargo install tree-sitter-cli --version 0.25.10 --locked
(cd tree-sitter-forge && tree-sitter generate)
cargo test -p tree-sitter-forge --locked
```

Check in `src/parser.c`, `src/grammar.json`, and `src/node-types.json` after grammar
changes. CI regenerates these using the pinned CLI and fails on differences.
The Rust tests parse every valid shared fixture and all existing example sources
with both Rowan and Tree-sitter, reject ERROR/MISSING nodes for valid sources,
compile all query files, check captures, exercise malformed-source recovery,
and compare an incrementally edited tree with a clean parse.

Language feature changes must add shared fixtures under
`specs/language/fixtures/{valid,invalid,recovery}` and update this grammar and
queries in the same change. This prevents a second independent semantic spec.

## Neovim (local installation)

With a Neovim build supporting Tree-sitter ABI 15 and a C compiler, build and
install the parser in a directory on `runtimepath`:

```sh
cc -shared -fPIC -I tree-sitter-forge/src tree-sitter-forge/src/parser.c -o forge.so
mkdir -p ~/.config/nvim/parser ~/.config/nvim/queries/forge
cp forge.so ~/.config/nvim/parser/forge.so
cp tree-sitter-forge/queries/*.scm ~/.config/nvim/queries/forge/
```

On macOS use `cc -dynamiclib -fPIC` in place of `cc -shared -fPIC`. Then configure:

```lua
vim.filetype.add({ extension = { forge = 'forge' } })
vim.api.nvim_create_autocmd('FileType', {
  pattern = 'forge',
  callback = function() vim.treesitter.start() end,
})
```

Use `vim.treesitter.foldexpr()` if your Neovim configuration enables expression
folding. Query capture conventions differ by editor; these indent captures use
the Neovim/nvim-treesitter convention.

## Helix (local checkout)

Add to `languages.toml`, substituting the absolute path to this grammar:

```toml
[[language]]
name = "forge"
scope = "source.forge"
file-types = ["forge"]
comment-token = "//"
indent = { tab-width = 2, unit = "  " }

[[grammar]]
name = "forge"
source = { path = "/absolute/path/to/forge/tree-sitter-forge" }
```

Build with `hx --grammar build`. Copy `highlights.scm` and `locals.scm` into
`~/.config/helix/runtime/queries/forge/`. For Helix indentation, adapt the
captures in `indents.scm` from `@indent.begin`/`@indent.end` to
`@indent`/`@outdent`. Keep `forgec lsp` configured separately for diagnostics.

## Zed (extension authoring)

Use a development extension with a `grammars.forge` entry referencing this
repository, a pinned commit, and `path = "tree-sitter-forge"`. Add
`languages/forge/config.toml` with `name = "Forge"`, `grammar = "forge"`, and
`path_suffixes = ["forge"]`; copy `highlights.scm` to that directory. Adapt
indent/outline queries to Zed's captures (its outline format differs from
Tree-sitter tags). Install the extension through Zed's development-extension
workflow. Publishing an extension is a separate step.

These are integration recipes, not a claim that each editor has been exercised
in this checkout. The parser, query compilation/captures, and Rust binding are
covered by the repository tests.
