// FORG-48: every Cloudflare resource the loader-miss lab creates. Workers are deployed by ForgeGraph (targets
// miss-* on forge-console's retired `staging` stage, sortOrder 90); D1 and R2 are created and deleted with
// wrangler (README, "Created and deleted"). Names are distinct from FORG-38's and FORG-47's labs.
export const WORKERS = {
  // pre-FORG-48 fetch path (LINKER_UNIT_CACHE=off): every blob from R2, one after another
  "miss-base": "forge-lab-miss-b-base",
  // FORG-48 default: memory, Cache API, parallel
  "miss-b": "forge-lab-miss-b",
  // the same, with Smart Placement
  "miss-smart": "forge-lab-miss-b-smart",
};
export const D1 = { acme: "forge-lab-miss-acme" };
export const R2 = { "miss-base": "forge-lab-miss-units-base", "miss-b": "forge-lab-miss-units-b", "miss-smart": "forge-lab-miss-units-smart" };
/** Stage secrets (forge secret set … --stage staging), renamed so they cannot collide with another lab's. */
export const SECRETS = { LAB_TOKEN: "MISS_LAB_TOKEN", LINKER_ADMIN_TOKEN: "MISS_LINKER_ADMIN_TOKEN", CURSOR_SECRET: "MISS_CURSOR_SECRET" };
export const SUBDOMAIN = "gmac.workers.dev";
export const url = (target) => `https://${WORKERS[target]}.${SUBDOMAIN}`;
