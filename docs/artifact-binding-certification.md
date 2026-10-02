# Native Artifacts management qualification

Cloudflare documents two separate control paths:

- [REST authentication](https://developers.cloudflare.com/artifacts/guides/authentication/)
  requires account Artifacts Read/Edit permissions.
- [The Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/)
  supports create, inspect and delete using the deployed binding.

The existing ForgeGraph credential is active and can manage Workers/D1 but its
REST Artifacts calls return 401. The separate `artifact-binding-certification`
workflow tests the supported binding path with that existing credential.
It does not declare REST authentication fixed or replace full reader/journal
certification.

The manual workflow deploys one generated `forge-binding-*` Worker bound to the
qualification namespace. A random secret authenticates requests. The only
repository identity comes from deployment configuration; callers cannot choose
another name. Creation and reads expire after 30 minutes; authenticated cleanup
remains available for that fixed name. The harness records owned intent before
provisioning, creates once without automatic retries, compares repository IDs,
and verifies an expected-absent Git push using the binding-issued token.

Cleanup deletes the repository first, then the Worker. If repository cleanup
cannot be established, it retains the Worker and reports both resource intents
as unresolved. Evidence includes names and status codes, never tokens. Private
state includes the endpoint secret and must remain private; do not upload it as
a workflow artifact. If a runner is lost, the resource name in evidence enables
an operator to reconcile through the separately authorized Wrangler/REST path.
This recovery dependency is not automatic host-loss certification.

`ARTIFACT_BINDING_CERTIFICATION_ENABLED=true` activates the weekly binding job
only after a successful manual run. `ARTIFACT_LIVE_CERTIFICATION_ENABLED` remains
a separate gate for the full REST-based reader/journal workflow.

Local checks:

```sh
node --test scripts/test/artifact-management-worker.test.mjs
python3 -m unittest discover -s scripts -p 'test_*.py'
node scripts/check-workflows.mjs
```

Forgejo run 48 passed with the existing credential on 2026-10-02. This proves
the bounded binding-management and Git flow only. The REST token still lacks
working Artifacts authorization.

Retained evidence: `docs/evidence/artifacts-binding-live-2026-10-02.json`.
One initial GET readiness probe received platform 1042 and was retried by the
existing bounded read-only policy. Repository creation and Git writes were not
retried. The intermittent 1042 cause remains unresolved.
