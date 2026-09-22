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

Current derivation handles function/resource dependencies in compiled IR. Workflow
step selection, input-dependent branches, compiler/CLI integration and durable Task
enqueue integration are still outstanding. Tests cover Bob-style agent work and
Forge verification work, ordering, tampering, missing pins and binding changes.
