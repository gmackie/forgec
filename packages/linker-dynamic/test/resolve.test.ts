// Resolution, policy derivation and the SQL gate, in Node against the sealed acme manifest.
import { beforeAll, describe, expect, it } from "vitest";
import { childMain, childSource, type LinkerKit } from "../src/child.ts";
import { LinkError, matchRoute, resolveManifest, type ClosureManifest } from "../src/manifest.ts";
import { derivePolicy, privilegedPolicy } from "../src/policy.ts";
import { checkSql, tableAccess } from "../src/sql-gate.ts";
import { MemoryBlobStore, verifiedBlob } from "../src/store.ts";
import { acmeManifest, appBundle, entry, h, rehash } from "./fixtures.ts";

beforeAll(() => h.prepare());

const linkError = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof LinkError) return e;
    throw e;
  }
  throw new Error("expected a LinkError");
};

describe("resolveManifest", () => {
  it("resolves the sealed acme manifest", async () => {
    const r = await resolveManifest(acmeManifest());
    expect(r.entries.size).toBe(acmeManifest().entryPoints.length);
    expect(r.routes.length).toBe(acmeManifest().entryPoints.filter((e) => e.kind === "http-route").length);
    // FORG-33: every surface the runtime serves is an entry point.
    expect(acmeManifest().uncovered).toEqual([]);
    for (const id of ["POST /v1/changesets", "POST /v1/imports/stage", "GET /v1/views/pending-orders", "GET /v1/caches/current-site-policy", "POST /v1/schedules/nightly-reconciliation/tick", "GET /forge/discovery", "GET /_forge/objects/{token}"]) expect(r.entries.has(id), id).toBe(true);
    expect(r.byQueue.get("forge-acme-commerce-fulfill-order")?.id).toBe("fulfill-order");
    expect(r.byWorkflowClass.get("ProcessOrderWorkflow")?.id).toBe("@acme/commerce/_/ProcessOrder");
  });

  it("matches static segments before parameters and refuses unknown routes", async () => {
    const r = await resolveManifest(acmeManifest());
    expect(matchRoute(r, "GET", "/v1/customers/queries/by-code")?.id).toBe("GET /v1/customers/queries/by-code");
    expect(matchRoute(r, "GET", "/v1/customers/cus_1")?.id).toBe("GET /v1/customers/{id}");
    expect(matchRoute(r, "get", "/v1/orders/o1/submit")).toBeNull();
    expect(matchRoute(r, "POST", "/v1/orders/o1/submit")?.id).toBe("POST /v1/orders/{order}/submit");
    expect(matchRoute(r, "GET", "/v1/nothing")).toBeNull();
    expect(matchRoute(r, "POST", "/v1/changesets")?.id).toBe("POST /v1/changesets");
    expect(matchRoute(r, "DELETE", "/v1/customers")).toBeNull();
    expect(matchRoute(r, "DELETE", "/v1/customers", { anyMethod: true })?.id).toMatch(/^(GET|POST) \/v1\/customers$/);
  });

  it("refuses a js-module unit whose module hash the manifest does not list", async () => {
    const m = acmeManifest();
    const unit = Object.values(m.units).find((u) => u.symbol === "@acme/commerce/_/SubmitOrder")!;
    delete m.modules[(unit.implementation as { module: string }).module];
    const e = await linkError(resolveManifest(rehash(m)));
    expect(e.code).toBe("MissingUnit");
    expect(e.problems.join("\n")).toMatch(/SubmitOrder .* needs module sha256:[0-9a-f]{64}, which the manifest does not list/);
  });

  it("refuses a closure that names a unit the manifest does not have", async () => {
    const m = acmeManifest();
    entry(m, "GET /v1/customers").closure.push(`sha256:${"0".repeat(64)}`);
    const e = await linkError(resolveManifest(rehash(m)));
    expect(e.code).toBe("MissingUnit");
    expect(e.problems.some((p) => p.includes("GET /v1/customers: closure unit sha256:000"))).toBe(true);
  });

  it("refuses a closure that is not closed under dependencies", async () => {
    const m = acmeManifest();
    const submit = entry(m, "POST /v1/orders/{order}/submit");
    const authorize = Object.entries(m.units).find(([, u]) => u.symbol === "@acme/payments/_/AuthorizePayment")![0];
    submit.closure = submit.closure.filter((x) => x !== authorize);
    submit.imports = submit.imports.filter((i) => i.unit !== authorize);
    const e = await linkError(resolveManifest(rehash(m)));
    expect(e.problems.join("\n")).toMatch(/POST \/v1\/orders\/\{order\}\/submit: closure is not closed/);
  });

  it("refuses a closure hash that does not cover its closure", async () => {
    const m = acmeManifest();
    entry(m, "GET /v1/customers").closureHash = entry(m, "GET /v1/orders").closureHash;
    const e = await linkError(resolveManifest(rehash(m, { closures: false })));
    expect(e.code).toBe("ClosureHashMismatch");
  });

  it("refuses content that does not match the manifest hash", async () => {
    const m = acmeManifest();
    entry(m, "GET /v1/customers").imports = [];
    const e = await linkError(resolveManifest(m));
    expect(e.code).toBe("ManifestHashMismatch");
  });

  it("refuses an unsupported manifest version", async () => {
    const e = await linkError(resolveManifest({ ...acmeManifest(), version: "closure-manifest/2" } as unknown as ClosureManifest));
    expect(e.code).toBe("UnsupportedManifest");
  });
});

describe("derivePolicy", () => {
  const schema = () => appBundle().sql;

  it("narrows a read route to its resource's table", () => {
    const m = acmeManifest();
    const p = derivePolicy(m, entry(m, "GET /v1/customers"), schema());
    expect(p.tables.read).toContain("customer");
    expect(p.tables.read).not.toContain("order_");
    expect(p.tables.write).not.toContain("customer");
    expect(p.units).toEqual([]);
    expect(p.egress).toEqual([]);
    expect(p.objects).toEqual([]);
  });

  it("gives SubmitOrder its declared tables, the reference-guard reads, its queue and its units", () => {
    const m = acmeManifest();
    const p = derivePolicy(m, entry(m, "POST /v1/orders/{order}/submit"), schema());
    expect(p.tables.write).toContain("order_");
    expect(p.tables.write).not.toContain("site");
    expect(p.tables.read).toEqual(expect.arrayContaining(["order_", "site", "customer", "order_document"]));
    expect(p.tables.read).not.toContain("department");
    expect(p.tables.read).not.toContain("site_policy");
    expect(p.queues).toEqual(["Q_FULFILL_ORDER"]);
    expect(p.workflows).toEqual([]);
    expect(p.units.map((u) => m.units[u]!.symbol).sort()).toEqual(["@acme/commerce/_/SubmitOrder", "@acme/payments/_/AuthorizePayment"]);
    expect(p.unlinked).toEqual(["durable-object:REALTIME (realtime fan-out is not linked by T4)"]);
  });

  it("gives object routes their R2 binding and nothing else", () => {
    const m = acmeManifest();
    expect(derivePolicy(m, entry(m, "GET /v1/order-documents/{id}/content"), schema()).objects).toEqual(["BLOBS"]);
    expect(derivePolicy(m, entry(m, "GET /v1/orders/{id}"), schema()).objects).toEqual([]);
  });

  it("no entry point is privileged: the sweep is narrowed to the dispatch unit's closure", () => {
    const m = acmeManifest();
    for (const e of m.entryPoints) expect(derivePolicy(m, e, schema()).privileged, e.id).toBe(false);
    const sweep = derivePolicy(m, entry(m, "forge:sweep"), schema());
    expect(sweep.queues).toEqual(["Q_FULFILL_ORDER"]);
    expect(sweep.workflows).toEqual(["WF_PROCESS_ORDER"]);
    expect(sweep.tables.write).toEqual(expect.arrayContaining(["order_", "forge_outbox"]));
    expect(sweep.tables.write).not.toContain("customer");
    expect(sweep.tables.read).not.toContain("department");
    // A manifest sealed before FORG-33 (sweep without a root) still gets the reported whole-app child.
    const old = { ...entry(m, "forge:sweep"), root: null };
    expect(derivePolicy(m, old, schema()).privileged).toBe(true);
    const all = privilegedPolicy(m, schema(), "x");
    expect(all.tables.write).toEqual(expect.arrayContaining(["customer", "order_", "forge_outbox"]));
  });

  it("gives changesets every stageable table and the object-bytes route only its bucket", () => {
    const m = acmeManifest();
    const cs = derivePolicy(m, entry(m, "POST /v1/changesets"), schema());
    expect(cs.tables.write).toEqual(expect.arrayContaining(["customer", "department", "order_", "order_document", "site", "site_policy"]));
    const objects = derivePolicy(m, entry(m, "GET /_forge/objects/{token}"), schema());
    expect([objects.objects, objects.tables]).toEqual([["BLOBS"], { read: [], write: [] }]);
    const view = derivePolicy(m, entry(m, "GET /v1/views/pending-orders"), schema());
    expect(view.tables.read).toContain("order_");
    expect(view.tables.write).not.toContain("order_");
  });

  it("child code never sweeps the outbox in-process and exposes the runtime's dispatch() (FORG-29 hand-off)", () => {
    const m = acmeManifest();
    const kit: LinkerKit = { libraries: { "@forgegraph/runtime@0.5.0": "sha256:r", "effect@4.0.3": "sha256:e" }, apps: { [m.buildHash]: "sha256:a" } };
    for (const p of [derivePolicy(m, entry(m, "POST /v1/orders"), schema()), privilegedPolicy(m, schema(), "runtime:dispatch")]) {
      const main = childMain(childSource(m, p, kit), p, []);
      // postCommit replaces the in-process nudge, and fetch passes no ctx: the host owns dispatch.
      expect(main).toMatch(/createWorker\(app, \{ functions, externals, postCommit: async \(\) => undefined \}\)/);
      expect(main).toContain("fetch: (request, env) => worker.fetch(request, hostEnv(env)),");
      expect(main).toContain("dispatch(tenant, o) { return worker.dispatch(hostEnv(this.env), tenant, o); }");
      expect(main).not.toContain("sweepTenant");
    }
  });

  it("fails closed when the kit lacks a library the closure needs", () => {
    const m = acmeManifest();
    const p = derivePolicy(m, entry(m, "POST /v1/orders/{order}/submit"), schema());
    const kit: LinkerKit = { libraries: { "@forgegraph/runtime@0.5.0": "sha256:x" }, apps: { [m.buildHash]: "sha256:y" } };
    expect(() => childSource(m, p, kit)).toThrow(/library effect@4\.0\.3 is not provided/);
    expect(() => childSource(m, p, { ...kit, libraries: { ...kit.libraries, "effect@4.0.3": "sha256:z" }, apps: {} })).toThrow(/no app bundle/);
  });
});

describe("SQL gate", () => {
  const policy = { label: "t", tables: { read: ["order_", "site", "forge_outbox"], write: ["order_", "forge_outbox"] } };

  it("classifies the runtime's statements", () => {
    expect(tableAccess(`SELECT * FROM order_ WHERE tenant = ?`)).toEqual({ write: null, read: ["order_"] });
    expect(tableAccess(`INSERT INTO forge_outbox (a) VALUES (?)`)).toEqual({ write: "forge_outbox", read: [] });
    expect(tableAccess(`UPDATE "order_" SET "x" = ? WHERE id = ?`)).toEqual({ write: "order_", read: [] });
    expect(tableAccess(`DELETE FROM site WHERE id = ?`)).toEqual({ write: "site", read: [] });
    expect(tableAccess(`INSERT INTO _forge_assert (op_id, satisfied) SELECT ?, (EXISTS (SELECT 1 FROM site WHERE x) AND NOT EXISTS (WITH RECURSIVE up(id, parent, depth) AS (SELECT id FROM department WHERE id = ? UNION ALL SELECT n.id FROM department n JOIN up ON n.id = up.parent) SELECT 1 FROM up WHERE id = ?))`)).toEqual({ write: "_forge_assert", read: ["site", "department"] });
    expect(tableAccess(`INSERT INTO forge_document (a) VALUES (?) ON CONFLICT (a) DO UPDATE SET b = excluded.b`)).toEqual({ write: "forge_document", read: [] });
    expect(tableAccess(`SELECT value FROM json_each(?)`)).toEqual({ write: null, read: [] });
    expect(tableAccess(`SELECT 'from customer' AS x FROM site`)).toEqual({ write: null, read: ["site"] });
  });

  it("allows declared access and denies the rest", () => {
    expect(() => checkSql(`SELECT * FROM order_ JOIN site ON 1`, policy)).not.toThrow();
    expect(() => checkSql(`INSERT INTO order_ (a) SELECT a FROM site`, policy)).not.toThrow();
    expect(() => checkSql(`SELECT * FROM department`, policy)).toThrow(/t has no capability to read department/);
    expect(() => checkSql(`DELETE FROM site WHERE id = ?`, policy)).toThrow(/write site/);
    expect(() => checkSql(`SELECT name FROM sqlite_master`, policy)).toThrow(/read sqlite_master/);
    expect(() => checkSql(`PRAGMA table_list`, policy)).toThrow(/unclassified statement refused/);
    expect(() => checkSql(`DROP TABLE order_`, policy)).toThrow(/unclassified/);
  });
});

describe("unit store", () => {
  it("refuses missing and corrupted blobs", async () => {
    const store = new MemoryBlobStore();
    const d = await store.put(new TextEncoder().encode("export default 1;"));
    expect(new TextDecoder().decode(await verifiedBlob(store, d, "u"))).toBe("export default 1;");
    store.blobs.set(d, new TextEncoder().encode("export default 2;"));
    expect((await linkError(verifiedBlob(store, d, "u"))).code).toBe("ModuleDigestMismatch");
    expect((await linkError(verifiedBlob(store, `sha256:${"1".repeat(64)}`, "u"))).code).toBe("MissingModule");
  });
});
