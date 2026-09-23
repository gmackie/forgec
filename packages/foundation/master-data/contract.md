# master-data contract

Issue #62; implementation acceptance remains planned.

## Ownership

Resolution case, typed source/canonical links, survivorship decisions and reversible merge history.

## Composition

Required dependencies: identifiers, lineage, evaluation, decision, reconciliation.

Party/domain canonical entities and Integration adapters are consumers/bridges. Resolution-specific handle, never a universal EntityRef.

## Independent acceptance

Customer/supplier/asset; namespace collisions; wrong target type; competing merges; unmerge restores mappings without erasing history; stale replay and authority isolation.

- F62-01: source mapping model
- F62-02: match/evaluation case
- F62-03: canonical-link fact
- F62-04: survivorship decisions
- F62-05: merge/unmerge semantics
- F62-06: fixtures for customer, supplier and asset resolution

Compile typed consumer fixtures, execute generated-bundle behaviors and adversarial cases, and bind evidence to accepted dependency revisions. Provider certification is separate from local tests.
