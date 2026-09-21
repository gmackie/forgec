# Upgrading an edition-2026 (M8) application (PAR-178)

`forge upgrade-edition <package>` prints proposals and writes nothing:

- one proposal per resource that is not `@purposeScoped`, listing its personal fields (from the data
  taxonomy) and a **minimal** capability (`read { id }`) with a purpose binding to declare;
- `grants: none` — cross-service edges stay requests until reviewed (`docs/grant-lifecycle.md`);
- `storage: none` — purpose scoping is enforced at read/write time; no schema change.

The package stays on edition 2026 until `forge.toml` says `edition = "2027"` and the proposals are applied
by hand. `forge compat` between the two builds shows only `governance / surface-added` findings (new
authority to review) and nothing in the storage or dependencies streams
(`crates/forge-cli/tests/cli.rs::edition_upgrade_is_explicit_and_non_destructive`).
