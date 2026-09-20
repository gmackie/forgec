/**
 * M0 spike: guarded mutations on live D1.
 *
 * Plan §10.3: "a conditional UPDATE affecting zero rows is not an SQL error",
 * so `UPDATE ... WHERE version = ?; INSERT audit; INSERT outbox` is not safe on
 * its own. This Worker exposes a few named scenarios so a test suite running
 * outside Cloudflare can drive them against a real D1 database and inspect the
 * durable result.
 *
 * Variants of the guarded update:
 *   predicate-first  assertion row computed from an SQL predicate BEFORE the
 *                    update (the design sketched in the plan)
 *   changes-after    assertion row computed from changes() AFTER the update
 *   unguarded        the naive batch — a control that documents the hazard
 */

export interface Env {
  DB: D1Database;
  SPIKE_TOKEN: string;
}

type UpdateVariant = "predicate-first" | "changes-after" | "unguarded";

interface UpdateRequest {
  tenant: string;
  id: string;
  expectedVersion: number;
  name: string;
  opId: string;
  variant: UpdateVariant;
}

interface ProviderError {
  name: string;
  message: string;
  cause?: string;
}

type Outcome = "VersionConflict" | "ProviderError";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function describeError(e: unknown): ProviderError {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    return {
      name: e.name,
      message: e.message,
      ...(cause instanceof Error ? { cause: cause.message } : {}),
    };
  }
  return { name: "Unknown", message: String(e) };
}

/**
 * Deliberately minimal classification. The spike's job is to record what D1
 * actually raises; the real adapter must not rely on message parsing alone.
 */
function classify(err: ProviderError): Outcome {
  const text = `${err.message} ${err.cause ?? ""}`;
  return /CHECK constraint failed: forge_precondition\b/.test(text) ? "VersionConflict" : "ProviderError";
}

function auditStatement(db: D1Database, r: UpdateRequest): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO audit (tenant, op_id, resource, record_id, new_version) VALUES (?1, ?2, 'customer', ?3, ?4)",
    )
    .bind(r.tenant, r.opId, r.id, r.expectedVersion + 1);
}

function outboxStatement(db: D1Database, r: UpdateRequest): D1PreparedStatement {
  return db
    .prepare("INSERT INTO outbox (tenant, op_id, ordinal, payload) VALUES (?1, ?2, 0, ?3)")
    .bind(r.tenant, r.opId, JSON.stringify({ type: "CustomerUpdated", id: r.id }));
}

function updateStatement(db: D1Database, r: UpdateRequest): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE customer SET name = ?1, version = version + 1 WHERE tenant = ?2 AND id = ?3 AND version = ?4",
    )
    .bind(r.name, r.tenant, r.id, r.expectedVersion);
}

function buildBatch(db: D1Database, r: UpdateRequest): D1PreparedStatement[] {
  const releaseAssert = db.prepare("DELETE FROM _forge_assert WHERE op_id = ?1").bind(r.opId);
  switch (r.variant) {
    case "predicate-first": {
      const assert = db
        .prepare(
          "INSERT INTO _forge_assert (op_id, satisfied) SELECT ?1, EXISTS (SELECT 1 FROM customer WHERE tenant = ?2 AND id = ?3 AND version = ?4)",
        )
        .bind(r.opId, r.tenant, r.id, r.expectedVersion);
      return [assert, updateStatement(db, r), auditStatement(db, r), outboxStatement(db, r), releaseAssert];
    }
    case "changes-after": {
      const assert = db
        .prepare("INSERT INTO _forge_assert (op_id, satisfied) VALUES (?1, changes())")
        .bind(r.opId);
      return [updateStatement(db, r), assert, auditStatement(db, r), outboxStatement(db, r), releaseAssert];
    }
    case "unguarded":
      return [updateStatement(db, r), auditStatement(db, r), outboxStatement(db, r)];
  }
}

async function handleUpdate(env: Env, r: UpdateRequest): Promise<Response> {
  try {
    const results = await env.DB.batch(buildBatch(env.DB, r));
    const updateIndex = r.variant === "predicate-first" ? 1 : 0;
    const update = results[updateIndex];
    return json({
      ok: true,
      rowsChanged: update?.meta.changes ?? null,
      meta: results.map((x) => ({ success: x.success, changes: x.meta.changes })),
    });
  } catch (e) {
    const error = describeError(e);
    return json({ ok: false, outcome: classify(error), error }, 409);
  }
}

/** Write an audit row, then fail a CHECK in the same batch. The audit row must not survive. */
async function handleRollbackProof(env: Env, r: { tenant: string; opId: string }): Promise<Response> {
  const audit = env.DB
    .prepare(
      "INSERT INTO audit (tenant, op_id, resource, record_id, new_version) VALUES (?1, ?2, 'proof', 'none', 0)",
    )
    .bind(r.tenant, r.opId);
  const failing = env.DB
    .prepare("INSERT INTO _forge_assert (op_id, satisfied) VALUES (?1, 0)")
    .bind(r.opId);
  try {
    await env.DB.batch([audit, failing]);
    return json({ ok: true, note: "batch unexpectedly succeeded" });
  } catch (e) {
    const error = describeError(e);
    return json({ ok: false, outcome: classify(error), error }, 409);
  }
}

/* ---------- outbox dispatcher primitives (plan §14) ---------- */

interface ClaimRequest { tenant: string; opId: string; ordinal: number; owner: string; now: number; leaseMs: number }
interface CompleteRequest { tenant: string; opId: string; ordinal: number; owner: string }

/** Rows that are pending and either never leased or whose lease has expired. */
async function handleOutboxSweep(env: Env, r: { tenant: string; now: number }): Promise<Response> {
  const res = await env.DB
    .prepare(
      "SELECT op_id, ordinal, status, attempts, lease_owner, lease_until FROM outbox WHERE tenant = ?1 AND status = 'pending' AND (lease_until IS NULL OR lease_until < ?2) ORDER BY op_id, ordinal LIMIT 100",
    )
    .bind(r.tenant, r.now)
    .all();
  return json(res.results);
}

/** Conditional lease acquisition: exactly one dispatcher wins; attempts counts logical deliveries tried. */
async function handleOutboxClaim(env: Env, r: ClaimRequest): Promise<Response> {
  const res = await env.DB
    .prepare(
      "UPDATE outbox SET lease_owner = ?1, lease_until = ?2, attempts = attempts + 1 WHERE tenant = ?3 AND op_id = ?4 AND ordinal = ?5 AND status = 'pending' AND (lease_until IS NULL OR lease_until < ?6)",
    )
    .bind(r.owner, r.now + r.leaseMs, r.tenant, r.opId, r.ordinal, r.now)
    .run();
  return json({ ok: res.meta.changes === 1 });
}

/** Fenced completion: only the current lease holder may mark the row delivered. */
async function handleOutboxComplete(env: Env, r: CompleteRequest): Promise<Response> {
  const res = await env.DB
    .prepare(
      "UPDATE outbox SET status = 'delivered', lease_owner = NULL, lease_until = NULL WHERE tenant = ?1 AND op_id = ?2 AND ordinal = ?3 AND status = 'pending' AND lease_owner = ?4",
    )
    .bind(r.tenant, r.opId, r.ordinal, r.owner)
    .run();
  return json({ ok: res.meta.changes === 1 });
}

async function handleDump(env: Env, tenant: string): Promise<Response> {
  const [customer, audit, outbox, asserts] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM customer WHERE tenant = ?1 ORDER BY id").bind(tenant),
    env.DB.prepare("SELECT * FROM audit WHERE tenant = ?1 ORDER BY op_id").bind(tenant),
    env.DB.prepare("SELECT * FROM outbox WHERE tenant = ?1 ORDER BY op_id, ordinal").bind(tenant),
    env.DB.prepare("SELECT * FROM _forge_assert ORDER BY op_id"),
  ]);
  return json({
    customer: customer?.results ?? [],
    audit: audit?.results ?? [],
    outbox: outbox?.results ?? [],
    asserts: asserts?.results ?? [],
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (request.headers.get("x-spike-token") !== env.SPIKE_TOKEN) return json({ error: "forbidden" }, 403);

    const url = new URL(request.url);
    const body = (await request.json()) as Record<string, unknown>;

    switch (url.pathname) {
      case "/reset": {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM outbox"),
          env.DB.prepare("DELETE FROM audit"),
          env.DB.prepare("DELETE FROM customer"),
          env.DB.prepare("DELETE FROM _forge_assert"),
        ]);
        return json({ ok: true });
      }
      case "/seed": {
        const { tenant, id, name } = body as { tenant: string; id: string; name: string };
        await env.DB
          .prepare("INSERT INTO customer (tenant, id, version, name) VALUES (?1, ?2, 1, ?3)")
          .bind(tenant, id, name)
          .run();
        return json({ ok: true, version: 1 });
      }
      case "/update":
        return handleUpdate(env, body as unknown as UpdateRequest);
      case "/rollback-proof":
        return handleRollbackProof(env, body as { tenant: string; opId: string });
      case "/dump":
        return handleDump(env, (body as { tenant: string }).tenant);
      case "/outbox/sweep":
        return handleOutboxSweep(env, body as { tenant: string; now: number });
      case "/outbox/claim":
        return handleOutboxClaim(env, body as unknown as ClaimRequest);
      case "/outbox/complete":
        return handleOutboxComplete(env, body as unknown as CompleteRequest);
      default:
        return json({ error: "not found" }, 404);
    }
  },
} satisfies ExportedHandler<Env>;
