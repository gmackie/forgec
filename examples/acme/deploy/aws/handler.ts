// AWS Lambda entrypoint for the Acme reference application. Same bundle, same
// runtime, same client as the Cloudflare deployment; only this host differs.
import { createLambdaHandler } from "@forgegraph/runtime/aws";
import type { AppBundle } from "@forgegraph/runtime";
import bundle from "../../generated/app.json" with { type: "json" };
import { externals, functions } from "../../impl/index.js";

export const handler = createLambdaHandler(bundle as unknown as AppBundle, { functions, externals });
