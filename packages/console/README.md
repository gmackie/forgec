# Forge visual editor and management console

A self-hosted **Cloudflare Kumo + React + Effect** application for managing Forge apps,
environment configuration, and a signed package registry backed by **OCI Distribution**.

- Register, rename, describe, archive and restore applications.
- Add, edit and remove environment endpoints, targets, non-secret config, secret references,
  and pinned OCI package digests. Changes use atomic revision checks.
- Publish signed compiled Forge bundles; browse/search versions, exports, fields, actions,
  effects, ownership and dependencies; download verified bundles by digest.
- Inspect Forge’s compiled data taxonomy, canonical classes and ancestry, classification
  evidence, subject bindings, declared purposes, and purpose-specific capability surfaces.
- Inspect instance configuration and the last 200 app/environment changes.

Configuration is an inventory of desired settings. Saving does **not** deploy infrastructure,
apply settings to running applications, or probe an endpoint. The UI marks deployments
unverified. This first version is a single-administrator console, not a multi-tenant service.

## Visual .forge editor

The **Editor** opens in a read view of the whole application. Resources use a compact schema with focused field dialogs, native classifications, purpose bindings and embedded capabilities. Functions compose input/output contracts, dependencies, events and connected sources. The data catalog uses compiler-derived classification evidence, handling requirements and personal-data status, including custom classes. Shapes, types, data classes, events and workflows are available under **More definitions**. Tabs group resources, functions,
sources, purposes and the data catalog across all
source files. Capabilities are configured inside each resource’s **Access & purpose** view. Search and
select declarations without navigating files. The document presents fields, classifications,
defaults, calculations and behavior as readable content; **Edit draft** enables Kumo controls.
Source is a secondary view, read-only until editing is enabled.

The Rust lossless parser and semantic compiler run as WebAssembly in a browser worker.
Visual edits patch UTF-16 source ranges and preserve unrelated text and comments. Source
and visual views share undo/redo history. Diagnostics identify actual Forge language errors.
The relationship graph shows references, purpose bindings and inheritance from the active file,
including links to declarations in other open files. The application browser groups declarations across all source files. Defaults and calculated expressions have labeled controls.
Classification describes data; purpose inheritance itself never grants access.

**File storage:** drafts are saved in this browser’s local storage, independently of the
server’s app inventory. Download `.forge` files to save source to disk; export/import a draft
JSON to transfer all open files. Opening files replaces the browser workspace and can be
undone. Local drafts do not write to a Git checkout or publish artifacts. Connected Git applications
commit only through the explicit review flow described below.
The first version supports 50 files / 500 KB, uses edition 2027 and the portable profile, and
checks the open files without resolving external package dependencies. Run `forgec check`
in the actual project for dependency-aware validation. Changing a declaration name edits
that source token; it does not automatically rename references in other locations.

### Git-backed applications

Configure GitHub projects on the instance with `GIT_PROJECTS_JSON` and a server-side
`GITHUB_TOKEN`. The token needs repository contents read/write permission. For example:

```json
[{"id":"desk","name":"Service desk","repository":"your-org/your-app","branch":"studio","root":"src"}]
```

The source root is relative to the repository; only regular `.forge` files under it can be
changed. `Connect Git` loads a snapshot of the configured branch. Browse, choose **Edit draft**,
then **Review changes** to inspect committed and draft source, enter a message, and create a
real Git commit. All file changes are committed together. GitHub's atomic `expectedHeadOid`
check rejects a commit if the branch has moved; the draft and its base revision remain saved
in the browser. Branch protection may require committing on a working branch instead of main.
Commit success returns to read view and clears the undo history at the new revision.

Credentials stay on the server. Both Docker and Cloudflare Workers use the same provider API;
no local Git executable or central Forge service is needed. The initial provider is GitHub.
Other independently hosted instances can omit Git entirely. This does not publish OCI artifacts
or deploy running apps. After a conflict, export your draft before loading a fresh repository
snapshot to reconcile it; automatic merging is not implemented.

### Service desk demo

New browser drafts start with [`examples/studio-desk`](../../examples/studio-desk), a seven-file
Forge package: organizations and contacts, tickets and replies, service plans, shared types,
native data classes and purposes, events, functions, a scheduled source and an escalation workflow.
The editor imports those exact sources; the example and the UI cannot drift apart.
Use **Load demo** to replace an existing draft after confirmation. Export first to retain a copy;
loading clears the undo history and any Git connection. Existing drafts are never silently migrated.

Try changing a plan's default allowance, inspecting its calculated balance, editing a ticket's
capability matrix, following a cross-file relationship, and switching to source to inspect the result.
This is a compilable application contract and editor fixture; it does not provision a running support service.
Run `cargo run -p forgegraph-cli -- check examples/studio-desk` from the repository root.

Build prerequisite: Rust 1.97+ with `rustup target add wasm32-unknown-unknown`.
`pnpm build` builds the compiler module automatically. The Dockerfile includes a Rust build
stage; deployed Node/Workers instances serve static WASM and need no Rust toolchain.
No source text is sent to the server or any external compiler service.

## Architecture and independence

The browser communicates only with its own origin. There is no analytics, remote font,
central login, automatic federation, or required upstream authority. Each instance supplies
its own authority string, administrator token, Ed25519 signing key and OCI connection.
`forge.gmac.io` is one deployment configuration, with no special status in the application.

The shared Effect API runs on Workers with D1, or Node 22 with SQLite. Both use the same
OCI adapter over HTTP. Docker Compose includes an independent Distribution registry;
Workers connects to a reachable OCI registry chosen by its operator.

**Artifacts and published metadata live in OCI, not D1/SQLite.** Each package is a standard
OCI image manifest with `artifactType: application/vnd.forgegraph.package.v1`, containing:

- Content-addressed Forge bundle, IR, contracts, OpenAPI and signed Forge manifest layers.
- An OCI config blob containing the authority-bound Ed25519 signature and Forge digest.
- Discoverable title/version/source-revision annotations. These annotations are informative;
  trusted names, versions, ownership and dependencies come from the verified Forge manifest.

The catalog is derived from verified artifacts on reads; it can be rebuilt without a database.
`forge-<sha256(name + newline + version)>` tags are discovery pointers. Environment pins use
the OCI manifest digest; Forge lockfile identity remains the separate signed Forge digest.
The console adapter is new; it does not change the existing registry library's on-disk format
or claim that existing `FileArtifactStore` directories are an OCI Distribution server.

D1/SQLite stores mutable apps/environments, recent configuration history, and operational
publication reservations. It does not duplicate registry artifacts or their metadata.

## Local development

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @forgegraph/registry... build
pnpm --filter @forgegraph/console build
cd packages/console
export INSTANCE_AUTHORITY=localhost
export INSTANCE_NAME='My Forge'
export ADMIN_TOKEN="$(openssl rand -hex 32)"
# Keep the token private; enter it in the browser's login form.
pnpm start
# http://localhost:8787
```

App management works without OCI. Configure the registry variables below to enable package
publication. For frontend hot reload, run `pnpm dev` in a second terminal; Vite proxies
`/api` to the Node server on port 8787. Build artifacts are not source files.

## Docker

From `packages/console`, prepare a private `.env` file (git-ignored):

```sh
umask 077
printf 'ADMIN_TOKEN=%s\n' "$(openssl rand -hex 32)" > .env
printf 'INSTANCE_AUTHORITY=registry.example.com\nINSTANCE_NAME=My Forge\n' >> .env
printf 'SIGNING_KEY_JWK=%s\n' "$(node scripts/keygen.mjs)" >> .env
printf 'PUBLIC_ORIGIN=https://registry.example.com\n' >> .env
docker compose up -d --build
```

Replace the domain and point a TLS reverse proxy to `127.0.0.1:8787`. For local HTTP testing,
set `PUBLIC_ORIGIN=http://localhost:8787`. The console port is loopback-only; OCI is exposed
only inside the Compose network. Set `PUBLIC_ORIGIN` to match the proxy's external scheme;
the original Host header must be preserved. HTTPS should terminate at the reverse proxy.

Compose persists `/data/console.sqlite` and the registry's `/var/lib/registry` in separate
named volumes. Container replacement/restart retains both. Registry v3 telemetry exporters
are explicitly disabled. Runtime images run as the unprivileged `node` user and expose a
`/healthz` healthcheck. This liveness check does not attest to upstream OCI availability.

To use an existing OCI registry, replace the Compose `OCI_URL`, `OCI_REPOSITORY` and
credential settings and omit the bundled registry service. TLS is required unless explicitly
opting into HTTP for a trusted private network.

## Cloudflare Workers

From the repo root, build the web assets; then configure `packages/console/wrangler.jsonc`:

```sh
pnpm --filter @forgegraph/console build
cd packages/console
export WRANGLER_SEND_METRICS=false
pnpm exec wrangler d1 create forge-console
# Put the returned database_id into wrangler.jsonc.
# Set vars.INSTANCE_AUTHORITY to your domain and vars.INSTANCE_NAME to your label.
# Set vars.OCI_URL and vars.OCI_REPOSITORY to your reachable OCI registry.
pnpm exec wrangler secret put ADMIN_TOKEN
pnpm exec wrangler secret put SIGNING_KEY_JWK
# Only if your OCI backend requires authentication:
pnpm exec wrangler secret put OCI_AUTHORIZATION
pnpm exec wrangler d1 migrations apply forge-console --remote
pnpm cf:deploy
```

Generate the private signing key with `node scripts/keygen.mjs`; store it in a secret manager
and provide that JSON to the secret prompt. Generate the admin token with `openssl rand -hex 32`.
For the requested hosted instance, set `INSTANCE_AUTHORITY=forge.gmac.io` and configure a
Workers custom domain route: `{"pattern":"forge.gmac.io","custom_domain":true}`. Other
installations choose their own domain. This repository does not deploy or register that domain.

For local Workers development, provide the same variables in a private `.dev.vars` file,
write JSON-valued entries with single outer quotes (for example,
`SIGNING_KEY_JWK='{"kty":"OKP",...}'`; do not backslash-escape the JSON's quotes),
apply `wrangler d1 migrations apply forge-console --local`, and run `pnpm cf:dev`. Both SQL
migrations must be applied before serving traffic. The actual Worker uses `nodejs_compat`;
the Node-only filesystem store and server are not invoked in Workers.

## Optional Workers domain for a Docker origin

`src/edge.ts` is a small HTTPS proxy for operators who want a Workers custom domain in front
of Docker. The full application remains on Node/SQLite with its private OCI backend.
Copy `wrangler.edge.jsonc` into a private deployment configuration, set `ORIGIN_URL` to the
HTTPS origin plus a dedicated path prefix, add your custom domain route, and deploy with
`wrangler deploy --config <config>`. Set `ORIGIN_TOKEN` using `wrangler secret put` before
attaching the public domain.

The origin reverse proxy must strip that path prefix, require the matching
`X-Forge-Origin-Token`, remove that header before forwarding, and preserve the console’s
public Host for same-origin write checks. Keep `PUBLIC_ORIGIN` set to the public HTTPS URL.
The edge forwards the administrator Authorization header, streams bodies, replaces any
client-supplied origin credential, and refuses to follow redirects. The origin credential
is separate from the administrator token. It is not needed for direct Docker or full
Workers/D1 deployments.

## Configuration reference

| Variable | Purpose |
|---|---|
| `ADMIN_TOKEN` | Required shared operator credential, at least 32 characters. Browser keeps it in tab memory only. |
| `INSTANCE_AUTHORITY` | Required stable identity under which manifests are signed. |
| `INSTANCE_NAME` | Display label; defaults to Forge. |
| `OCI_URL` | OCI registry origin, e.g. `https://registry.example.com`; omit to run app management alone. |
| `OCI_REPOSITORY` | Repository path inside that registry, e.g. `team/forge`. Required with OCI. |
| `OCI_AUTHORIZATION` | Optional server-only full Authorization value, `Bearer …` or `Basic …`. |
| `OCI_ALLOW_HTTP` | Explicit `true` for a local/private HTTP registry; defaults false. |
| `OCI_BLOB_HOSTS` | Comma-separated exact HTTPS hosts permitted for blob download redirects. Authorization is never forwarded to them. |
| `SIGNING_KEY_JWK` | Private Ed25519 JWK, required with OCI; no automatic generation or central key service. |
| `SIGNING_KEY_ID` | Key identity, defaults `instance-v1`. |
| `PUBLIC_ORIGIN` | Node external origin, used for the TLS proxy scheme. |
| `DATA_PATH` | Node SQLite path; defaults `./data/console.sqlite`. |
| `HOST`, `PORT` | Node listener; defaults `0.0.0.0:8787`. |

Do not change authority or signing key casually: this first version trusts only the configured
key for the configured authority. Changing either makes older packages fail verification.
Multi-key rotation and OIDC/team roles are follow-up capabilities. A plain configuration field
can contain any string; the system cannot identify secret values automatically. Store only
references under `secretRefs`, never actual credentials.

## Publication concurrency and recovery

Publishing checks whether the version tag already exists and creates a durable unique
reservation immediately before publishing the final manifest. Concurrent console requests
sharing the same D1/SQLite database cannot replace the same version. Blob upload/validation
failures before that point are retryable; uploaded unreferenced blobs may be garbage-collected
using the OCI backend's normal process.

A timeout after the final manifest PUT is ambiguous: the publication might have succeeded.
The reservation deliberately remains. **Do not delete a reservation until an operator checks
that its version tag is absent in OCI and stops/drains any in-flight publisher.** If the tag is
present, pull and verify it; treat publication as complete. If absent after reconciliation,
delete only that reservation from `console_publications` and retry. Its `key` is
`sha256(OCI_URL + '/' + OCI_REPOSITORY + '\n' + authority + '\n' + name + '\n' + version)`
with the `sha256:` prefix. `reserved_at` helps locate the attempt.

All publishers for one authority/repository must share the reservation database. Direct OCI
writes bypass this check: configure immutable `forge-*` tags at the OCI registry or restrict
write credentials to the console. Distribution's default mutable tags are not themselves a
version immutability guarantee. OCI digest pins remain content-addressed regardless of tags.

The adapter supports OCI monolithic blob uploads, tag pagination, digest pulls and explicitly
allowed blob-read redirects. Upload redirects and cross-origin tag pagination are refused.
Use a static Basic/Bearer credential accepted by the registry; automatic WWW-Authenticate
challenge/token exchange and expiring-token refresh are not implemented.

## Backup and limits

Back up the SQLite database using SQLite's online backup mechanism (or stop the container and
copy its volume, including WAL state); back up D1 with its export facilities. Back up OCI storage
independently, and preserve the instance authority and signing key in your secret backup process.
Restoring config alone cannot restore packages. Losing the key prevents new signatures and
verification through this console. Keep publication reservations with the configuration backup.

Initial limits: 200 apps, 30 environments/app, 100 config/reference entries each, 900 KB of
configuration, 4 MB HTTP requests, 3.5 MB browser bundle uploads, 8 MB individual OCI responses,
and 20 tag-list pages. The catalog currently re-verifies artifacts on each listing with four
concurrent pulls. Each package costs several registry requests; use a Workers plan with enough
subrequests for your catalog. Large registries need a paginated API and a rebuildable index/cache.
The admin token grants access to all metadata in this instance; public/namespace-scoped access
and grant lifecycle management are not exposed. No remote app is contacted automatically.

## Verified in this change

- Full TypeScript workspace: **394 passed**, 126 existing environment-dependent tests skipped.
- All workspace typechecks and packaging checks passed.
- Console suite: **24 passed**, including real OCI Distribution integration.
- Chromium acceptance passed against Node, the built Docker container, and local workerd/D1:
  app creation, environment editing, OCI publication, verified contract browsing, mobile layout,
  and no off-origin browser requests.
- SQLite/Docker and D1/local Worker configurations survived process/container restarts.
- Worker dry-run build passed. Production rollout status is recorded in the published plan.

## Validation

```sh
pnpm --filter @forgegraph/registry... build
pnpm --filter @forgegraph/console typecheck
pnpm --filter @forgegraph/console test
# Real OCI integration (requires a disposable registry):
docker run --rm -d --name forge-console-oci-test -p 127.0.0.1:15000:5000 registry:3
OCI_TEST_URL=http://127.0.0.1:15000 pnpm --filter @forgegraph/console test
# Browser acceptance against a disposable Node server:
cd packages/console
pnpm build
node scripts/local-test-server.mjs
# In another terminal in packages/console:
pnpm exec playwright install chromium
pnpm exec playwright test
# Same browser workflow against local wrangler:
CONSOLE_TEST_URL=http://127.0.0.1:8788 pnpm exec playwright test
```

The test helper uses a known test-only token, a generated ephemeral signing key and a temporary
database. Never use it as a production entrypoint. The browser suite writes disposable apps and
versions; run it only against a test instance. OCI integration is explicitly skipped unless
`OCI_TEST_URL` is provided. API/unit tests include bad auth, validation, revision conflicts,
persistence, publication reservations, tamper detection, redirect credential isolation,
sign-out races and draft revision preservation.

## Deployment operations and function playground

The Deployments screen manages configured immutable releases through a private deployment
controller: deploy with a configuration snapshot, inspect progress and logs, restart, stop,
and roll back to a previous release and its configuration. The bundled controller uses Docker.
Native Cloudflare deployment provisioning is not included; the console itself still runs on
Workers or Node. The HTTP controller boundary allows other providers to be installed locally.

Build the console, then build the runner from the repository root:

```sh
docker build -f packages/console/Runner.Dockerfile -t forge-runner .
cd packages/console
node scripts/build-playground.mjs
cd ../..
docker build -f packages/console/Playground.Dockerfile -t forge-playground .
docker image inspect forge-playground --format '{{.Id}}'
```

Run the controller on a private Docker network with a persistent volume at /data, a read-only
/config/targets.json, RUNNER_TOKEN (32+ random characters), and the Docker socket mounted at
/var/run/docker.sock. Only the runner requires Docker access. It has host-level container
control; do not expose its port publicly or give its credential to application users.
Use a dedicated controller per target set; multiple controllers must not manage the same target.

Example target file (replace the image with the immutable ID from the build, and artifact
with the signed OCI package digest returned by publication):

```json
[{"id":"playground","name":"Support playground","network":"forge-console_default",
"environment":{"RUNTIME_TOKEN":"REPLACE_WITH_RANDOM_RUNTIME_TOKEN"},
"releases":[{"id":"v1","name":"1.0.0","createdAt":"2026-09-21T00:00:00Z",
"artifact":"sha256:SIGNED_OCI_PACKAGE_DIGEST","image":"sha256:IMMUTABLE_IMAGE_ID"}]}]
```

Configure the console server with these JSON environment variables. Tokens never reach the browser:

```text
DEPLOYMENT_TARGETS_JSON=[{"id":"playground","name":"Support playground","kind":"docker","endpoint":"http://runner:8790/targets/playground","token":"RUNNER_TOKEN","runtimeId":"playground"}]
RUNTIME_TARGETS_JSON=[{"id":"playground","name":"Support playground","endpoint":"http://runner:8790/runtime/playground","token":"RUNTIME_TOKEN"}]
```

Releases are installed by the operator's build pipeline, never arbitrary browser-supplied images.
Protected environment bindings are configured in the target file. UI configuration cannot replace
them. Data must live in an external retained service: managed containers have read-only roots and
ephemeral /tmp. The sample runtime exposes pure quote/contact-validation functions and uses no
persistent application data. Rollback does not reverse database migrations. Back up the controller
SQLite volume alongside console and OCI data. Interrupted actions are marked failed on recovery;
owned nonactive containers are removed before accepting new actions.

The playground discovers functions from the live OpenAPI contract, generates sample JSON, and
displays status, duration, returned data and declared errors. Invocations execute real effects.
Results remain in browser session memory. Build/revision preconditions reject stale requests.
External runtimes must advertise invocation-preconditions; GET function input binding is currently
unsupported in the playground. Deployment status records the last action's health check, not
continuous monitoring.
