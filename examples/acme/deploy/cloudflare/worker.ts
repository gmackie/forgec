// Cloudflare entrypoint for the Acme reference application. Only this file and
// the deploy configuration are provider-specific; the .forge package and the
// generated bundle are shared with the AWS deployment.
import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import { createRealtimeObject, createWorker, createWorkflowEntrypoint } from "@forge/runtime/cloudflare";
import type { AppBundle } from "@forge/runtime";
import bundle from "../../generated/app.json";
import { externals, functions } from "../../impl/index.js";

const app = bundle as unknown as AppBundle;
const options = { functions, externals };

export default createWorker(app, options);

// One WorkflowEntrypoint per declared workflow (bundle.workflows[].cloudflare.className).
// The class body is generic: Cloudflare Workflows provides the durable timers and retries,
// the portable executor provides every step semantic.
export class ProcessOrderWorkflow extends createWorkflowEntrypoint(WorkflowEntrypoint, app, options) {}

// Realtime streams (bundle.realtime.cloudflare): one Durable Object per (tenant, stream).
export class ForgeRealtime extends createRealtimeObject(DurableObject, app, options) {}
