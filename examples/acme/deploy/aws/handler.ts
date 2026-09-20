// AWS Lambda entrypoint for the Acme reference application. Same bundle, same
// runtime, same client as the Cloudflare deployment; only this host differs.
import { createLambdaHandler } from "@forge/runtime/aws";
import type { AppBundle } from "@forge/runtime";
import bundle from "../../generated/app.json" with { type: "json" };

export const handler = createLambdaHandler(bundle as unknown as AppBundle);
