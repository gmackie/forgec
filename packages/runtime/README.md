# @forgegraph/runtime

The Effect runtime for a ForgeGraph application bundle. One bundle (`app.json`, produced by
`forgec build`) plus your `impl/` functions run unchanged on Cloudflare Workers, AWS Lambda and
Node — the adapters differ, the observable behaviour does not.

**Stability: stable-candidate.** The engine, host and adapter entry points below are the supported
surface; anything not documented here may change in a minor release before 1.0.

```bash
npm install @forgegraph/runtime
```

## Entry points

| import | what |
|---|---|
| `@forgegraph/runtime` | `Engine`, `Model`, `createHttpHandler`, `jwtAuth`, `devHeaderAuth`, errors, codecs, telemetry, gatekeeper, suppression |
| `@forgegraph/runtime/node` | `createNodeHost` — Fetch server, realtime hub, durable sweep, graceful drain |
| `@forgegraph/runtime/cloudflare` | Workers entrypoint, Workflows binding, Durable Object realtime |
| `@forgegraph/runtime/aws` | Lambda handler, Step Functions driver, API Gateway WebSocket |
| `@forgegraph/runtime/d1`, `/dynamodb`, `/postgres`, `/memory` | storage adapters |
| `@forgegraph/runtime/r2`, `/s3`, `/memory-objects` | object stores |
| `@forgegraph/runtime/compose` | `composeRuntime` — wire an engine without a host |

## Minimal Node host

```ts
import { createNodeHost } from "@forgegraph/runtime/node";
import { createPostgresStorage } from "@forgegraph/runtime/postgres";
import { jwtAuth, Model, type AppBundle } from "@forgegraph/runtime";
import bundle from "./generated/app.json" with { type: "json" };
import { functions, externals } from "./impl/index.js";

const app = bundle as unknown as AppBundle;
const host = createNodeHost({
  bundle: app,
  store: createPostgresStorage(pool, new Model(app)),
  functions,
  externals,
  auth: jwtAuth({ issuer, audience, secret, claims: { tenant: "tid", actor: "sub" } }),
  cursorSecret: process.env.CURSOR_SECRET!,
});
await host.listen(8080);
```

The host **refuses to start without an authentication host**. For local development set
`FORGE_AUTH=dev-headers`, which trusts `x-forge-tenant` / `x-forge-actor` verbatim and logs a warning
on every boot. Never enable it where untrusted callers can reach the process.

## Documentation

[Getting started](https://github.com/gmackorg/forgegraph/blob/main/docs/getting-started.md) ·
[Portable profile](https://github.com/gmackorg/forgegraph/blob/main/docs/portable-profile.md) ·
[Operations](https://github.com/gmackorg/forgegraph/blob/main/docs/operations.md)

Apache-2.0
