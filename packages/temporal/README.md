# @forgegraph/temporal

Temporal-backed workflow driver for ForgeGraph (the `self-hosted-full` profile).

**Stability: experimental.** Certified against a single-node `temporal server start-dev`; multi-node
clusters and Temporal Cloud are separate, unverified tuples.

```bash
npm install @forgegraph/temporal
```

The Forge engine stays the executor: instances, steps, receipts and the signal inbox live in your
store, exactly as on Cloudflare Workflows and Step Functions. Temporal supplies durable timers and
signal buffering — one Temporal execution per Forge instance.

```ts
import { temporalDriver, temporalWorker } from "@forgegraph/temporal";

const driver = await temporalDriver({ address: "127.0.0.1:7233", taskQueue: "forge" });
const host = createNodeHost({ ...options, workflowDriver: driver });

const worker = await temporalWorker(host.runtime.engine, { address: "127.0.0.1:7233", taskQueue: "forge" });
await worker.run();
```

Run the worker in its own process (or several) alongside the API. A crash of either resumes from the
store plus Temporal's timers; see `test/temporal.test.ts` for the certified crash/restart evidence.

Apache-2.0
