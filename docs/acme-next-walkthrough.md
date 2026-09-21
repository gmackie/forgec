# Acme-next walkthrough (FORGE-090)

The same `.forge` package and the same `impl/` business code, on every certified profile, with no
provider conditionals. Each step names the command or test that performs it; steps that cannot be
synthesized from the model are marked **external**.

## 1. Model and build

```
cargo run -p forge-cli -- check examples/next/acme-next        # edition 2027: purposes, capabilities, subjects
cargo run -p forge-cli -- build examples/next/acme-next --out /tmp/acme-next
cargo run -p forge-cli -- explain examples/next/acme-next --resource Contact   # effective surfaces per purpose
```

`examples/next/acme-next/src/customers.forge`: `Contact` is `@purposeScoped @subject(person)` with
`Identity ⊂ ContactRead ⊂ ContactMaintenance ⊂ SupportRecord`; `AgentSupport` denies `supportNotes`
stickily. `CustomerSupport` uses `SupportRecord`; `ParentCommunication` uses `ContactRead`.

## 2. CRUD under purposes

`packages/runtime/test/scope.test.ts`: the same `Contact.get` returns `supportNotes` under
`CustomerSupport` and not under `ParentCommunication`; `Contact.update` of `name` is `NotPermitted`
under both (no surface grants it); write-capable surfaces expose `version` for `If-Match`.
Differential across memory / sqlite-node: `conformance/test/differential.test.ts` (purpose parity).

## 3. HTTP, MCP, CLI and SDKs

```
FORGE_API_URL=http://127.0.0.1:8080 FORGE_API_DEV_TENANT=t FORGE_API_DEV_ACTOR=agent-7 \
  forge-api Contact.get --set id=con_… --purpose @acme/governance/_/CustomerSupport
```

- `GET /forge/discovery`, `GET /forge/openapi.json` (`packages/runtime/test/http.test.ts`)
- MCP at `/forge/mcp`: `tools/list` per identity and purpose; `tools/call` re-authorized
  (`packages/interfaces/test/mcp.test.ts`)
- Python and Go clients on one scenario (`packages/interfaces/test/sdk-conformance.test.ts`)

## 4. Cross-service grant (payments)

`SubmitOrder` uses `payments.AuthorizePayment`. `requestFrom()` turns the edge into a signed request;
the approval bot opens one PR in `acme/payments` under `grants/`; two independent reviewers approve on
the merged head; `publishGrant()` signs the grant; `GrantRegistry.admit()` then `activate()` for
`acme-prod/commerce` under an acknowledged snapshot. Until then `guardExternals` refuses the call.
Walkthrough: `packages/registry/test/grants.test.ts`, lifecycle in `docs/grant-lifecycle.md`.

## 5. Registry outage and revocation

`SnapshotHolder` keeps deciding from the last signed snapshot; after expiry the configured rule applies
(`deny` or `degrade-readonly`, never indefinite). `emergencyRevoke` denies queued old work immediately
and survives rollback (`snapshots.test.ts`, `rollback.test.ts`, `adversarial.test.ts` PAR-173).

## 6. Classified imports

`forge import-openapi vendor.json --package @vendor/billing --pin URL=FILE@SHA256 --allow-host …`
produces shapes/functions with `customer_id : text`; wiring `input.customer` (a `Customer` reference)
into it is E-WF-008. **External**: the vendor's own erasure adapter (`processors[]` in
`planDisposition`) must be registered by hand.

## 7. Erasure and recovery

`planDisposition(engine, { subject: Student, disposition: "erasure" })` on the education fixture
preserves the shared guardian and lawful holds; `RightsExecutor` scrubs personal fields in chunks with
per-chunk re-authorization and writes the suppression ledger; a later queued create is `Suppressed`;
a restore of an older backup replays current suppression (`packages/governance/test/rights.test.ts`).
Recovery claims come only from measured drills (`evidence.test.ts`). **External**: the legal
disposition itself; vendor confirmation references.

## 8. Rollout

`forge compat old new --report pr` → `forge migrate old new` → `DeploymentLedger` (fenced, resumable)
→ `sloGate` with minimum evidence → `driftReport` → `signEvidence` → `RELEASE_MANIFEST.json`.
Provider moves: `docs/provider-cutover.md`.

## What is not synthesized

- Temporal multi-node/cloud topologies (the single-node dev-server profile is certified: `packages/temporal`)
- Attested `isolated-callable` identity
- Vendor erasure adapters and legal determinations
