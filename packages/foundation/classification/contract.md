# classification contract

Issue #54; implementation acceptance remains planned.

## Ownership

Business Taxonomy/Concept/revision, aliases, supersession, ClassificationSet and assignments. Separate from governance dataClass.

## Composition

Required dependencies: identifiers.

Subjects point to classification sidecars. Classification never imports its classified subjects.

## Independent acceptance

Knowledge/product/risk/job-family vocabularies; hierarchy/alias conflicts; historical assignment interpretation survives concept evolution.

- F54-01: taxonomy/concept hierarchy
- F54-02: concept lifecycle/supersession
- F54-03: classification assignment aggregate
- F54-04: aliases/external identifiers
- F54-05: sidecar integration
- F54-06: fixtures for knowledge, products, risk and job-family classification

Compile typed consumer fixtures, execute generated-bundle behaviors and adversarial cases, and bind evidence to accepted dependency revisions. Provider certification is separate from local tests.

## Executable implementation

See [README.md](README.md) for the implemented resource/operation profile, explicit limitations, generated consumer fixture and focused memory/SQLite verification commands. Acceptance remains planned pending integration evidence; live provider certification is not claimed.
