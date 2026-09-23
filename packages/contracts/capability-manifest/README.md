# @forgegraph/capability-manifest

Pinned adapter capability manifests and their validator. A manifest states what a storage or object
adapter actually guarantees (atomic batch shape, ordering, conditional writes, limits); the compiler
validates it by digest and shape and **never executes it**.

**Stability: stable-candidate.**

```bash
npm install @forgegraph/capability-manifest
```

```ts
import { loadManifest, validateManifest } from "@forgegraph/capability-manifest";

const manifest = loadManifest("d1");          // bundled: memory, d1, dynamodb
validateManifest(manifest);                    // throws on an unknown or malformed capability
```

Pin a manifest from a package with `[extensions.<target>] manifest = "..."` and `sha256 = "..."` in
`forge.toml`; a digest mismatch fails the build (E-EXT-001/002).

Apache-2.0

Execution manifests (`execution-manifest/1`) describe simple runner atoms such as
`tool.forgec`, `browser.playwright` and `os.linux`. They are separate from adapter
support/evidence claims: matching an atom grants no data or operation authority.

`pinExecutionManifest` validates and hashes a manifest. `deriveExecutionRequirements`
walks a function's transitive `uses`, selected content-pinned implementation/provider
bindings, and profile providers. Missing bindings or pins fail closed. Results carry
sorted atoms, atom-to-source explanations, artifact/profile digests and a provenance
digest. The artifact digest is `executionDigest` over the exact supplied compiled IR;
it is an integrity check, not a trust signature. Requirements describe selected
bindings, not a proof that arbitrary handwritten code has no undeclared dependencies.

Explicit extra atoms require a reason. `runnerEligibility` uses all-of matching only.
`executionCompatibility` reports changed requirements and provenance; callers must
persist the returned snapshot with a task and never re-derive already queued work.

`deriveWorkflowStepRequirements` selects a named function call or mapped call in a
compiled workflow, including calls nested in choice/parallel branches. It derives
only that activity's transitive requirements and binds the workflow ID, step ID,
version and graph hash into the snapshot and explanations. Duplicate step IDs,
unknown steps, non-activity steps and artifact/pin tampering fail closed.

The caller selects the activity being dispatched; this helper does not execute
branch predicates or schedule work. `WorkQueue.enqueueWorkflowStep` materializes
and persists that snapshot, verifies the target against the queue's execution
function and keeps existing tasks unchanged across workflow revisions. Mapped
items receive separate caller-supplied task identities and share the pinned
activity contract.

Automatic workflow-to-runner dispatch, input-dependent manifest requirements and
compiler/CLI integration remain outstanding. Tests cover Bob-style agent work,
Forge verification work, compiled map enqueue, restart, capability matching,
ordering, tampering, missing pins and binding changes.
