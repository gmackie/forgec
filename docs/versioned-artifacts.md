# Versioned artifact reads

`@forgegraph/runtime/versioned-artifacts` provides an experimental read-only
contract for exact file reads and bounded commit ancestry. Its first provider,
`@forgegraph/runtime/cloudflare-artifacts`, uses the Cloudflare Artifacts Workers
binding. This is an initial runtime slice, not the completed compiler primitive
or a Bob production migration.

## Bind trusted repositories

```ts
import { VersionedArtifactReader } from '@forgegraph/runtime/versioned-artifacts';
import { cloudflareArtifactsReader } from '@forgegraph/runtime/cloudflare-artifacts';

const reader = new VersionedArtifactReader([{
  tenant: workspaceId,
  artifact: 'project-source',
  generation: 'migration-1',
  repositoryId: configuredProviderRepoId,
  provider: cloudflareArtifactsReader(env.ARTIFACTS, configuredRepoName),
}], async request => applicationAuthorization.canReadArtifact(request));

const pin = await reader.resolve('project-source', 'main', authorizedContext);
const file = await reader.readFile(pin, 'src/index.ts', authorizedContext,
  { maxBytes: 1024 * 1024 });
const history = await reader.history(pin, authorizedContext, { maxCommits: 128 });
```

Configuration and context come from a trusted composition root, never client
URLs, repository names or actors. The required authorization callback receives
action, tenant, actor, artifact, generation and optional purpose. It runs on every
operation, including old-pin reads; callback failures deny access. Connect it to
current application/Forge policy. It is not automatically connected to an Engine's
Gatekeeper, and this reader is not an HTTP authentication layer. No maintenance
bypass exists.

The binding key is `(tenant, artifact)`. The provider repository ID and local
binding generation prevent deleted/recreated names from silently reusing existing
pins. Advancing a generation invalidates old pins through this reader; retaining
historical access requires an explicit binding policy. Pins are references, not
bearer capabilities or signatures.

## Exact reads and full ancestry

A pin includes tenant, logical artifact, generation, provider repository ID, object
format, commit OID and tree OID. Discovery happens once. Later reads use only the
commit OID, rechecking the commit/tree match. Caller mutation across authorization
cannot change request identity. The generic contract accepts SHA-1 and SHA-256
object formats; the Cloudflare adapter declares the documented SHA-1 format.

Cloudflare `log()` is used only for selector resolution with `limit: 1`. History
uses `readCommit()` and follows **all** parents in deterministic depth-first parent
order, deduplicating shared ancestors. Missing ancestry, cycles, malformed metadata
and budget exhaustion fail explicitly; no truncated result appears complete.
There is no pagination yet: larger histories need a future continuation contract.

Bounds: 1,024 commits per history call, 32 parents per commit, 32 MiB per file;
callers can lower commit/file budgets. Paths and selectors are limited to 1,024
UTF-16 code units. Paths must be relative, without empty/dot components,
backslashes or control characters. Limits describe this reader, not every future
Forge artifact profile.

File size is checked before consuming the Blob and again against returned bytes.
Providers may already have fetched content while constructing the Blob; this is
not a streaming network quota. Hosts own request deadlines and cancellation.
No filesystem materialization, symlink, LFS or submodule semantics are promised.
MIME types are provider metadata: consumers apply their own rendering policy.

## Lifetimes and errors

Every Cloudflare call opens a disposable repository capability, loads fresh
`info()`, and checks its stable ID. Handles are disposed on success or failure,
including metadata lookup failure. The adapter exposes no token issuance or
repository mutation.

Raw provider messages and response bodies are redacted. Missing repositories map
to `NotFound`; importing/forking/creating maps to `ProjectionNotReady`; other
provider failures map to `DependencyUnavailable`. Authorization uses
`NotPermitted`, binding changes `VersionConflict`, invalid input/metadata
`ValidationFailed`, and limits `BudgetExceeded`. Cleanup failure is also a provider
failure and may replace an earlier error.

Providers remain trusted for correct bytes and commit metadata. OID/tree checks
are not cryptographic Git-object verification or a signed publication receipt.
Authorization is artifact-wide, not path ACLs or reachable-from-branch filtering.

## Evidence and remaining gates

Unit tests cover moving refs, merge ancestry, missing/cyclic histories, limits,
tenant/current authorization, purpose, binding replacement, mutable input,
malformed discovery, redaction and RPC disposal. A real bare Git fixture tests
pinned binary bytes and both parents of a merge through the binding contract.
These local contract tests are complemented by the disposable live qualification
below.

Provider shapes were checked against the Workers binding documentation and current
Workers type declarations on 2026-10-01:

- https://developers.cloudflare.com/artifacts/api/workers-binding/
- https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/
- https://developers.cloudflare.com/artifacts/platform/limits/

The [2026-10-01 live evidence](../conformance/artifacts/live-2026-10-01.json)
records 17 passing checks using the actual Workers binding and Git smart HTTP.
These include exact binary reads, all-parent merge history, authorization and
budgets, concurrent expected-head pushes (one winner), stale-head rejection,
read-token restrictions and revocation, fork identity/isolation, mirror export
with Git fsck, and deletion/recreation fencing. Cleanup left no test repositories
or Workers. See [reproduction instructions](../conformance/artifacts/README.md).

The run encountered four HTTP 404 responses containing platform error 1042 before
a file read succeeded. These are preserved in evidence, with bounded read-only
probe retries; the underlying cause is unresolved. This is functional evidence
from one beta account/run, not an availability or general concurrency guarantee.

Runtime publication with expected-head preconditions, durable receipts, fork/merge
APIs, import verification, compiler syntax and Bob wiring remain. `reader.capabilities` explicitly marks publish/merge/fork false.
These read tests make no D1/Turso metadata or write-concurrency claim. Existing
sealed ArtifactRevision and Specification APIs are unchanged.
