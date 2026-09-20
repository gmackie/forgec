// Cloudflare entrypoint for the Acme reference application. Only this file and
// the deploy configuration are provider-specific; the .forge package and the
// generated bundle are shared with the AWS deployment.
import { createWorker } from "@forge/runtime/cloudflare";
import type { AppBundle } from "@forge/runtime";
import bundle from "../../generated/app.json";

export default createWorker(bundle as unknown as AppBundle);
