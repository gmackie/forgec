# Manufacturing: telemetry, quality and maintenance

Hand-authored ConceptIR v2 corpus fixture for #69. Read [domain.md](domain.md) for business rules and [questions.md](questions.md) for explicit gaps. `concept-ir.json` is the authoritative L0 artifact; no `concept.forge` is supplied because explicit L0 source grammar is not available.

`views/` contains generated canonical graph projections. Each durable Entity and Fact has exactly one producer. `realizations/` contains two architectural sketches, not runtime proofs. Their `signature.forge` files are executable **partial** projections used to test transport substitution and fail-closed realization checks. They do not implement the full authored contract. Mutation JSON files are consumed by the Rust corpus test, not illustrative prose.

Run `cargo test -p forgegraph-semantic --test concept_corpus` from the repository root. See [the corpus guide](../README.md) for coverage and snapshot refresh instructions.
