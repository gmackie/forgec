// FORG-38: every Cloudflare resource the lab creates. Workers are deployed by ForgeGraph (stage `staging`
// of forge-console, ../../../../.forgegraph.yaml while the lab runs); the D1 databases, R2 buckets and the
// queue are created and deleted with wrangler (README, "Created and deleted").
export const WORKERS = {
  "linker-b": "forge-lab-linker-b",
  probe: "forge-lab-probe",
  "rpc-callee": "forge-lab-rpc-callee",
  "c-router": "forge-lab-c-router",
  "c-dynamic": "forge-lab-c-dynamic",
  "c-get-customers": "forge-lab-c-get-customers",
  "c-post-orders": "forge-lab-c-post-orders",
  "c-submit": "forge-lab-c-submit",
  "c-sweep": "forge-lab-c-sweep",
};
export const D1 = { acme: "forge-lab-acme", pricing: "forge-lab-pricing" };
export const R2 = { unitsB: "forge-lab-units-b", unitsC: "forge-lab-units-c" };
export const QUEUE = "forge-lab-acme-fulfill-order";
export const SUBDOMAIN = "gmac.workers.dev";
export const url = (target) => `https://${WORKERS[target]}.${SUBDOMAIN}`;
