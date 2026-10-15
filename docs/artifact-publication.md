# Journaled artifact publication

`@forgegraph/runtime/artifact-publication` publishes a prepared commit to one
branch with an explicit expected head. `null` means the branch must be absent;
omitting the precondition is invalid. It does not create commits, merge branches,
or provide a transaction spanning Git and metadata storage.

## Compose trusted capabilities

```ts
import { ArtifactPublisher } from '@forgegraph/runtime/artifact-publication';
import { SqlArtifactPublicationJournal } from '@forgegraph/runtime/artifact-publication-sql';
import { gitArtifactPublicationProvider } from '@forgegraph/runtime/artifact-publication-git';

// Provision the journal schema once, using your D1-compatible SqlExecutor.
const journal = new SqlArtifactPublicationJournal(sqlExecutor);
await journal.initialize();
const publisher = new ArtifactPublisher([{
  tenant: workspaceId, artifact: 'project-source', generation: 'migration-1',
  repositoryId: configuredRepositoryId,
  provider: gitArtifactPublicationProvider({
    directory: preparedBareRepository,
    remote: configuredRepositoryRemote,
    identity: trustedReadProviderForThatSameRemote,
    token: getRepositoryScopedToken,
  }),
}], journal, request => applicationAuthorization.canPublishArtifact(request));

const request = {
  key: operationId,
  ref: 'refs/heads/main',
  expected: previousCommitOid, // or null for expected-absent
  revision: preparedRevisionPin,
};
const receipt = await publisher.publish(request, authorizedContext);
if (receipt.outcome === 'pending') {
  const reconciled = await publisher.recover(request, authorizedContext);
  // Handle each outcome explicitly. Do not turn pending into success.
}
```

The Git adapter is Node-only and requires Git on PATH plus a dedicated trusted
bare repository containing the prepared objects. Configuration, identity provider,
local repository/config, remote and credentials are trusted composition-root
inputs, never caller values. The read capability and remote must refer to the
same stable repository. Use repository-scoped tokens so deletion/recreation
cannot redirect an in-flight authenticated push to a replacement repository.
The Artifacts Workers binding remains read-only. The portable writer below uses
the documented Git HTTPS receive-pack service for mutation.

Publication validates the pinned commit/tree locally before claiming dispatch.
The prepared pin and application policy determine what may be published. Expected
head alone allows history rewrites: enforce ancestry rules in application policy
if required. Authorization receives ref, expected head, pin, actor and purpose.
It is reevaluated for replay and recovery, and provider identity is rechecked.

## Receipts and recovery

Keys are unique within `(tenant, artifact)` across generations. The recorded
intent includes key, ref, expected head, full pin, actor and purpose. Reusing a
key with different intent fails with `IdempotencyMismatch`. Request IDs may vary.

| Outcome | Meaning |
| --- | --- |
| `pending` | Intent is durable; dispatch may be in progress, absent, or completed without a durable acknowledgement. |
| `accepted` | Provider confirmed the conditional write and the journal persisted that result. |
| `rejected` | Provider definitively rejected the expected-head condition. |
| `observed` | Recovery saw the desired head; this does **not** attribute the write to this request or certify its precondition. |

The journal atomically claims a key before any provider mutation. Only the claim
owner may dispatch, once. Replays return the receipt without another write.
Terminal receipts are immutable. There is no timeout takeover, automatic retry,
or deletion/expiry of claims: a process dying after claim but before dispatch
leaves a pending intent. A failed receipt write after provider success also leaves
pending state. Storage errors are redacted and prevent unjournaled dispatch.

Recovery only reads the provider head. Matching the desired OID may persist
`observed`; any other head leaves the intent pending, even if it equals the old
head. Another writer could have moved the branch away and back. A terminal
receipt remains historical evidence if the branch later moves. Neither current
head equality nor missing equality proves which operation ran.

Operators must establish that a prior dispatch is no longer in flight and read a
fresh head before considering a new operation key. This API deliberately offers
no force-retry or automated resolution for ambiguous outcomes. Retain the journal
for the lifetime of its keys and back it up alongside application metadata.

## Git and storage boundaries

The Git transport sends exactly one explicit refspec and `--force-with-lease`
with the exact expected OID. Only a successful update report is accepted; only
an explicit stale-info rejection is rejected. Timeouts, protocol failures and
Git's `up to date` result stay uncertain. In particular, Git can skip the lease
check for an already-matching target; it must not become an accepted receipt.
Credentials travel through the child environment, not command arguments or
persistent configuration. Raw subprocess output never appears in public errors.

The SQL journal uses a unique primary key, insert-on-conflict and conditional
terminal updates through `SqlExecutor`. `initialize()` is an idempotent provisioning
hook; the matching D1 migration is in `examples/acme/migrations/d1/`. The new journal
is tested against real SQLite, including closing/reopening a file-backed database.
The [2026-10-01 live qualification](../conformance/artifacts/publication-live-2026-10-01.json)
also exercises this journal against deployed D1 through a qualification REST
executor. This qualifies the SQL statements and durable cloud behavior used by
the Node publisher, not the Workers D1 binding composition or Turso.

Regression tests cover durable replay, concurrent duplicate claims, stale heads,
expected-absent creation, input snapshotting, authorization and generation fencing,
pre-dispatch storage failure, lost acknowledgements, failed terminal persistence,
and read-only recovery. A real bare-Git test checks conditional push behavior,
including Git's no-op lease edge case. The end-to-end live qualification runs the actual Node publisher and Git
transport against Cloudflare Artifacts with live D1 receipts. All 11 checks passed,
including fresh-process replay, concurrent duplicate claims, competing writers,
stale-head rejection, Git no-op handling, and recovery from injected failures
after actual provider writes. The injected failures test recovery boundaries;
they are not observed Cloudflare outages. Cleanup reported no remaining
disposable resources. Reproduce it using the
[qualification instructions](../conformance/artifacts/README.md#journaled-publication).


## Workers HTTPS transport

`@forgegraph/runtime/artifact-publication-workers` exports
`workerGitArtifactPublicationProvider`. Compose it with a request-local
`WorkerGitPackStore`, `WorkerArtifactWorkspace`, the read provider for that same
repository, and `SqlArtifactPublicationJournal(rawD1Executor(env.DB))`:

```ts
const provider = workerGitArtifactPublicationProvider({
  remote: configuredRepositoryRemote,
  identity: trustedReadProviderForThatSameRemote,
  prepared: requestLocalPackStore,
  token: getShortLivedRepositoryScopedWriteToken,
});
```

Use this provider in the `ArtifactPublisher` binding above. The application must
authorize preparation and publication, fix tenant/artifact/generation/repository
identity in trusted configuration, and obtain the exact remote from Artifacts.
Neither the URL nor the identity capability may come from a caller. HTTPS alone
does not establish that they describe the same repository. Credentials travel
only in Bearer headers; redirects are refused and responses are bounded to 1 MiB.
The provider supports SHA-1 repositories and protocol-v1 receive-pack with
`report-status`. It sends one guarded command and one version-2 pack, validating
the pack header, checksum and size before POST. The server compares the old OID
atomically, including an all-zero create. A matching advertisement is only an
optimization; it cannot replace the server guard.

Only explicit `unpack ok` plus an `ok` for the exact requested branch confirms
acceptance. A matching `ng` records rejection. Missing/malformed reports, network
failures, HTTP errors and unsupported capabilities throw; the publisher retains
the durable pending intent. Recovery reads the exact full branch name through authenticated Git ref discovery,
never another write. Repository identity is still checked through the trusted
Artifacts read capability. The binding history selector accepts short branch
names but does not resolve full refs consistently; recovery must not reinterpret
a full branch name as an ambiguous short selector. There is no lease takeover, outbox dispatcher, expiry or
automatic resend. The pack is request-local; a restarted invocation can replay
or reconcile a durable intent without retaining that pack.

The portable adapter has no Node imports or subprocesses. Tests drive it against
real `git http-backend` for create/update, races between advertisement and POST,
unchanged unrelated refs, corrupt packs and lost acknowledgements with a real
SQL journal. The workerd probe exercises the same adapter with a protocol mock
and validates its pack through native Git; this is not live Artifacts evidence.

For disposable live qualification, run:

```sh
python scripts/qualify-artifact-publication.py \
  --account "$CF_ACCOUNT_ID" --credential-file /private/wrangler-config.toml \
  --state-dir /private/new-qualification-state \
  --evidence /private/workers-publication-evidence.json --workers-transport
```

This deploys a secret-authenticated, time-limited qualification Worker with native
Artifacts and D1 bindings. Preparation, Git HTTPS publication, durable replay and
read-only reconciliation happen inside separate Worker invocations. The runner
injects a lost acknowledgement and a claim-before-dispatch interruption, checks
stale preconditions and tenant/policy denial, then removes its owned Worker,
repository and database. Add `--workers-runner-host <existing-ssh-host>` to run
readiness and HTTP assertions from an existing runner when local ingress differs;
only the disposable HTTP client runs there, and credentials travel through stdin.
It never activates a production application. A failed
qualification is not certification; inspect its structured evidence and cleanup.

Earlier [live attempt evidence](evidence/workers-publication-attempt-2026-10-15.json)
is **incomplete**. A deployed Worker received an explicit accepted receive-pack
report, but full readback/replay/conflict/recovery assertions did not pass.
Subsequent calls encountered non-JSON ingress errors. All owned resources were
removed. FORG-19 remains open; this evidence does not certify the live composition.


The [2026-10-15 live qualification](evidence/workers-publication-live-2026-10-15.json)
passed all seven checks after exact-ref recovery was corrected: binary publication,
durable replay without another POST, stale preconditions, competing Worker
requests with exactly one accepted writer, lost acknowledgement reconciliation,
claim-before-dispatch interruption without takeover, and authorization/tenant
denial. Preparation, hashing, pack creation, Git HTTPS requests, authorization and
D1 receipts ran in the deployed Worker. An existing SSH host acted only as the
HTTP client. The Worker, Artifacts repository and D1 database were removed with
no cleanup errors. Evidence records bundle and source digests; this supersedes
the earlier incomplete attempt for this scope. No production activation, automatic
resend, general-purpose raw-object reader or Workers-native merge is qualified.


Two later orchestration repetitions encountered platform `1042` ingress failures:
[readiness](evidence/forg19-final-20261015.json) and
[first publication request](evidence/forg19-final2-20261015.json). They did not
complete the suite, did not retry a publication POST, and cleaned all owned
resources. The passing evidence's runtime, Worker and assertion hashes still
match the follow-up source; these repetitions do not establish ingress reliability.
