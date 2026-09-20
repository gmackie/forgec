// The Acme management workspace: the generic @forge/react workspace driven by
// the compiled UI descriptor and the generated client. Point it at either
// deployment with ?api=<base-url>; the UI and its contracts do not change.
import { createRoot } from "react-dom/client";
import { Workspace } from "@forge/react";
import { createClient } from "../generated/client";
import bundle from "../generated/app.json";

const params = new URLSearchParams(location.search);
const baseUrl = params.get("api") ?? "https://forge-acme.gmac.workers.dev";
const tenant = params.get("tenant") ?? "acme";
const client = createClient({ baseUrl, tenant, actor: "workspace" });

createRoot(document.getElementById("root")!).render(<Workspace descriptor={(bundle as any).ui} call={client.call} />);
