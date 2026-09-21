/**
 * FORGE-072 / PAR-148, PAR-149, PAR-155: managed Postgres profiles are exact
 * products and modes; certification of a mode comes from the contract suite
 * run through that mode; the matrix never infers a status from names.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CertificationMatrix } from "../src/matrix.js";
import { MANAGED_PROFILES, qualifyPostgres, rawPgExecutor, resolveProfile, transactionPooled } from "../src/managed-postgres.js";

const url = process.env["FORGE_PG_URL"];

describe("PAR-149: PlanetScale needs an engine designation", () => {
  it("resolution refuses ambiguity and unsupported engines; exact products resolve to exact profiles", () => {
    expect(() => resolveProfile({ product: "planetscale" })).toThrow(/name the engine explicitly/);
    expect(() => resolveProfile({ product: "planetscale", engine: "mysql" })).toThrow(/unsupported/);
    expect(resolveProfile({ product: "planetscale", engine: "postgres" }).id).toBe("planetscale-postgres/direct");
    expect(resolveProfile({ product: "neon", mode: "pooled-transaction" })).toMatchObject({ id: "neon/pooled-transaction", sessionState: false, transactions: { isolation: "serializable" } });
    expect(() => resolveProfile({ product: "neon", mode: "pooled-session" })).toThrow(/no managed profile/);
    expect(MANAGED_PROFILES["neon/direct"]!.backups.pointInTime).toBe(true);
  });
});

describe("PAR-155: certification is per exact tuple", () => {
  it("swapping any component of a certified tuple yields unverified; a failing suite yields unsupported; names inherit nothing", () => {
    const m = new CertificationMatrix();
    const pgTuple = { engine: "postgres-17", driver: "pg@8/direct", runtime: "node-24", deployment: "self-hosted" };
    expect(m.status(pgTuple).status).toBe("unverified");
    m.record(pgTuple, { suite: "postgres-contract", passed: 33, failed: 0, at: "2026-09-21T00:00:00Z" });
    expect(m.requireCertified(pgTuple)).toMatchObject({ ok: true });
    // same engine, different driver mode: nothing carries over
    const pooled = { ...pgTuple, driver: "pg@8/pooled-transaction" };
    expect(m.requireCertified(pooled)).toMatchObject({ ok: false, status: "unverified", reason: expect.stringMatching(/exact combination/) });
    // same everything but the deployment: unverified too
    expect(m.status({ ...pgTuple, deployment: "docker" }).status).toBe("unverified");
    // a run with failures marks the tuple unsupported, with evidence retained
    const bad = m.record(pooled, { suite: "postgres-contract", passed: 30, failed: 1, at: "2026-09-21T00:00:00Z" });
    expect(bad.status).toBe("unsupported");
    expect(m.requireCertified(pooled)).toMatchObject({ ok: false, status: "unsupported" });
    expect(m.toJSON().version).toBe("certification-matrix/1");
  });
});

describe.skipIf(!url)("PAR-148: connection modes are certified by the suite they pass", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: url, max: 2 }); });
  afterAll(async () => { await pool?.end(); });

  it("direct mode passes the full contract; a transaction-mode pooler passes the contract without session state and is certified only for that", async () => {
    const direct = await qualifyPostgres(MANAGED_PROFILES["local/direct"]!, rawPgExecutor(pool));
    expect(direct.checks.filter((c) => !c.ok)).toEqual([]);
    expect(direct).toMatchObject({ certified: true, contract: "full" });
    expect(direct.serverVersion).toMatch(/^1[5-9]/);
    const pooled = await qualifyPostgres(MANAGED_PROFILES["neon/pooled-transaction"]!, transactionPooled(rawPgExecutor(pool)));
    expect(pooled.checks.find((c) => c.name === "session-state")!.ok).toBe(false);
    expect(pooled).toMatchObject({ certified: true, contract: "no-session-state" });
    // the same pooled executor claimed as a *direct* profile is not certified: the declared semantics were not demonstrated
    const misdeclared = await qualifyPostgres(MANAGED_PROFILES["neon/direct"]!, transactionPooled(rawPgExecutor(pool)));
    expect(misdeclared.certified).toBe(false);
    // the matrix records the tuple with what actually passed
    const m = new CertificationMatrix();
    const e = m.record({ engine: `postgres-${direct.serverVersion}`, driver: "pg/direct", runtime: "node", deployment: "local" }, { suite: "postgres-qualification", passed: direct.checks.length, failed: 0, at: new Date().toISOString(), ...(direct.serverVersion ? { engineVersion: direct.serverVersion } : {}) });
    expect(e.status).toBe("certified");
  });
});
