# Forge post-M8 upgrade package

**20 September 2026.** A detailed implementation roadmap continuing the 17 September dual-target plan after M8. This is a planning deliverable, not an implemented framework or cloud deployment.

## Start here

Read `IMPLEMENTATION_PLAN.md`. Its 25 sections describe the revised architecture, normative security/composition rules, provider strategy, registry and callee-owned grants, data classification, purpose-scoped Effect services, interfaces, migrations, subject rights and milestone gates.

`specs/milestones.json` contains M9–M21. `specs/backlog.json` contains 65 new dependency-linked work items, FORGE-027–091. `specs/extension-conformance.json` contains 104 additional Given/When/Expected scenario specifications, PAR-076–179.

The original 26 work items and 75 tests remain preserved in `specs/baseline-*`; combined there are **179 scenario specifications**, not 179 passing tests. M9 must establish actual M8 implementation evidence before the next framework release can claim the baseline is complete.

`specs/traceability.json` maps post-M8 requirements back to earlier functionality. `specs/sources.json` records primary research sources. `examples/` includes preserved original examples and new draft purpose/classification/binding/grant fixtures.

## Validation included in this package

Run from this directory with Python 3.11 or later:

```sh
python tools/validate_package.py
python tools/check_capability_algebra.py
```

The validator checks JSON/TOML parsing, scenario/ticket IDs, dependency DAGs, cross references, Markdown fences, and an illustrative capability schema when `jsonschema` is installed. The second script checks a finite Python model of set composition and runtime attenuation. `ARTIFACT_CHECKS.json` records the actual checks performed.

These are **artifact and reference-model smoke checks**. They do not prove a Forge compiler, execute cloud deployments, typecheck Effect code, run OPA, validate legal compliance or execute the planned conformance scenarios.

## Important boundaries

The nine application constructs remain unchanged. Purposes, classifications, capability fragments and approved grants are cross-cutting contract metadata, not a new storage/compute platform. A purpose hierarchy does not implicitly grant authority. Gatekeeper checks operations and records, not just Layer construction. Exact provider/driver/runtime combinations require certification.

All Forge syntax/API/package names in new examples are proposals. Do not edit generated artifacts in an eventual implementation; keep migrations and reviewed grants under explicit source ownership. No credentials or real personal data are included here.
