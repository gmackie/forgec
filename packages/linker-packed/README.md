# @forgegraph/linker-packed

**Stability: internal (research, FORG-29).** Not published.

Linker A (packed). Turns a sealed Closure Manifest (`schemas/closure-manifest.schema.json`, written
by `@forgegraph/units`) into Cloudflare Worker scripts:

```sh
pnpm --filter @acme/commerce-deploy units:build   # forgec build --units + seal
node packages/linker-packed/src/cli.ts examples/acme --strategy per-entry-point
# or: --strategy single (the whole-app baseline), --full-app-json (no slicing)
```

Output goes to `<app>/generated/linked/<strategy>/`: `link.json` (the deployment), one directory per
script (`entry.mjs`, `app.slice.json`, `units/<sha256>.js`, `wrangler.jsonc`, `worker.js`), and for
split strategies a router script.

Each script carries only:

- the unit modules of its group's closures, copied byte for byte from the manifest and re-verified
  against their digests;
- a slice of `app.json` with the declarations those closures reach (`src/slice.ts`). Since FORG-33
  every runtime surface is an entry point, so the residual group (requests no entry point claims)
  gets an empty slice and the sweep gets its dispatch unit's closure. Contract-metadata routes take
  the whole `app.json` by design (mode `whole`: they publish the whole contract). Only a manifest
  that still lists `uncovered` surfaces makes the residual a whole-app `fallback`, with the reason;
- a thin host (`src/host.ts`) that passes the runtime only the bindings the manifest declares,
  answers only its own routes, and forwards outbox dispatch to the dispatch owner when its model is a
  slice.

Everything that can be wrong with the manifest is refused at link time with a `LinkError`
(`src/manifest.ts`, `src/capabilities.ts`). That covers a manifest hash, module digest or closure
hash that does not recompute, a missing unit or module, an import provided outside the closure, a
capability the model would grant but the manifest does not, a binding the group's runtime needs
but the manifest does not declare, and a module finding that bypasses capability handles.

Grouping is a strategy (`src/strategies.ts`): `per-entry-point` and `single` exist. Add one by
implementing `GroupingStrategy` and registering it in `STRATEGIES`. Cloudflare's placement rules
(workflow steps run inside their workflow class) are applied after any strategy.

`src/local.ts` serves linked output in workerd through Miniflare, for tests and the research run.

Why a package of its own rather than part of `@forgegraph/units`: units *produces* the manifest
(Node, esbuild, the TypeScript AST over `impl/`); a linker *consumes* it and owns a runtime-facing
host. Every linker (A here, B in FORG-30) is meant to consume the same manifest independently, so the
schema is the contract between them and neither linker depends on the other.

Results for the reference app: `research/composable-units/t3-linker-packed/`, and after FORG-33
`research/composable-units/r2-coverage/`.
