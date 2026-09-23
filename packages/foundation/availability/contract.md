# Availability contract

Issue #55. Weekly availability, exceptions/overrides, zone semantics, bounded query
and worker/machine/facility fixtures pass generated memory/SQLite tests. F55-05,
Allocation/Scheduling integration, remains planned.

The public contract is documented in [README.md](README.md). Specification is the
only dependency. Typed consumer resources own attachments; lower layers never
reference app-owned subjects. The optional origin is an immutable SpecificationPin.

Revision interpretation is sealed by count, digest and timezone database version.
Raw CRUD can stage an invalid seal, but no effective-window query may interpret it
as valid. Queries authorize every revision and rule read through Engine, fail closed
on missing or unreadable rules, and do not fall back to a newer revision.

Acceptance evidence: `packages/runtime/test/foundation-availability.test.ts`, against
actual generated bundles, using both memory and SQLite. Provider certification and
cross-system scheduling/allocation correctness are separate gates.
