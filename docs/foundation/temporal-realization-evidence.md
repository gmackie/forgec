# Temporal realization evidence

The bounded acceptance example for #75 uses Foundation resource relations and
settlement. Each package has one authored temporal contract, checked against its
compiled declaration closure, and one shared set of expected observations run
through distinct relational and DynamoDB storage adapters.

| Package | Checked package ConceptIR hash | Authored bindings |
| --- | --- | --- |
| resource-relations | `6aeac253b4846a7000c245605ec66315c72c4c5bf213924b2b049bb252e3bd18` | Relation validity interval, source occurrence, server-owned publication knowledge |
| settlement | `5973ca47f8af5b3891592779e84b332d45a24c96b2b3cf1198ccbab6673613d0` | Source/event occurrence, effective contribution time, server-owned publication knowledge |

These hashes come from `forgec inspect <package> --concept --semantics
<package>/fixtures/semantics.json` at implementation `be8e98f2`. They identify
the package plus dependency closure, not the additional domain declarations in
its executable consumer. `foundation_semantic_bridges.rs` checks the bindings
against generated bundles and rejects wrong timestamp/endpoint types. Adding
explicit knowledge bindings leaves the executable DomainIR unchanged.

The runtime evidence comes from the same named assertions on each provider:

- Resource relations: a handoff changes the current custodian while a query at
  the earlier knowledge timestamp still sees the original custodian. Future and
  backdated ends respect half-open validity and inclusive knowledge boundaries.
  Equal knowledge timestamps resolve through the published predecessor chain;
  staged successors remain inert. Recreating the Engine preserves the outcome.
- Settlement: partial contributions produce identical exact balances at the
  selected effective and knowledge times. Immutable reversals and later
  corrections preserve earlier knowledge views and effective-time prefixes.
  Over-settlement is rejected without changing the published balance.

The source-bound provider aggregate links each profile to the same rebuilt
consumer artifact hashes and exact assertion names across native PostgreSQL,
hosted D1 and hosted DynamoDB. SQL tables/indexes and DynamoDB partition/sort
access plans are different storage realizations. Both run the same authoritative
publication and temporal reconstruction logic; this is not a comparison of two
independently designed bitemporal algorithms.

The separate `business_realizations` Rust test checks actual SQL/Dynamo plans
and equal checked L0 identity across different target profiles. It flags absent
enforcement evidence. That planner test alone is not the runtime evidence.

See [provider certification](provider-certification.md) for the current completed
matrix and receipt paths. A stale or incomplete matrix does not establish these
observations on the current source. This finite example does not implement a
generic executor for arbitrary ConceptIR selectors, prove arbitrary mechanisms,
or certify production migration. Legacy unaxed `Selection.during`/`as_of` remain
partial projection metadata; new temporal declarations name an explicit axis.
