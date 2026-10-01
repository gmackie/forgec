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
The Workers read binding remains read-only; this is not a Workers-native writer.

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
