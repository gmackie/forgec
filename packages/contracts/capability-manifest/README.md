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
