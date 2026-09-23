import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { Adjudications } from "../src/foundation/adjudication.js";
import { Decisions } from "../src/foundation/decision.js";
import { Participations } from "../src/foundation/participation.js";
import { Entitlements } from "../src/foundation/entitlement.js";
import { Evaluations } from "../src/foundation/evaluation.js";
import { Ledger } from "../src/foundation/ledger.js";
import { Deliveries } from "../src/foundation/delivery.js";
import { Engine } from "../src/engine.js";
import { localAuthorizer } from "../src/gatekeeper.js";
const p = "@forgegraph/foundation/adjudication/_/", pp = "@forgegraph/foundation/participation/_/", ep = "@forgegraph/foundation/entitlement/_/", sp = "@forgegraph/foundation/specification/_/", ev = "@forgegraph/foundation/evaluation/_/", lp = "@forgegraph/foundation/ledger/_/";
const run = Effect.runPromise;
async function setup(adapter: string, approve = true) {
  const f = await foundation("adjudication", adapter, true), { engine, call, ctx } = f;
  const api = new Adjudications(engine), decisions = new Decisions(engine), entitlements = new Entitlements(engine), evaluations = new Evaluations(engine);
  const party = await call("@forgegraph/foundation/party/_/Party.create", { label: "Beneficiary" });
  const scope = await call(ep + "EntitlementScope.create", { label: "Coverage" }), right = await call(ep + "RightDefinition.create", { namespace: "claims", name: "covered" });
  const coverage = await run(entitlements.issue({ holder: String(party.id), right: String(right.id), scope: String(scope.id), quantity: "100.000000", unit: "USD", validFrom: "2025-01-01T00:00:00Z", validUntil: "2027-01-01T00:00:00Z", reason: "Coverage" }, ctx));
  const set = await call(pp + "ParticipationSet.create", { label: "Reviewers" });
  const memberships = new Participations(engine, { namespace: "adjudication", roles: ["reviewer"] }); await run(memberships.registerRole("reviewer", ctx));
  const voter = await run(memberships.add({ participationSet: String(set.id), participant: String(party.id), role: "reviewer", validFrom: "2025-01-01T00:00:00Z", reason: "Review" }, ctx));
  const decision = await run(decisions.open({ participationSet: String(set.id), electors: [String(voter.id)], eligibilityAt: "2026-01-01T00:00:00Z", rule: "Single", options: ["Approve", "Reject"], deadline: "2027-01-01T00:00:00Z" }, ctx));
  const approvedOption = (await run(decisions.state(String(decision.id), ctx))).options[0]!.id;
  const bundle = await call("@forgegraph/foundation/evidence/_/EvidenceBundle.create", { key: "reasons", label: "Evidence" }), seal = await call("@forgegraph/foundation/evidence/_/EvidenceSeal.create", { bundle: bundle.id, head: null, recordedBy: ctx.actor });
  const record = await run(api.open({ key: "case", coverage: String(coverage.id), coverageAt: "2026-01-01T00:00:00Z", decisionCase: String(decision.id), approvedOption: String(approvedOption), requested: "80.000000", unit: "USD", itemCount: 1, support: String(seal.id) }, ctx));
  const repo = await call(sp + "Repository.create", { key: "rules", provider: "git", locator: "https://example.test/rules" }), pin = await call(sp + "SpecificationPin.create", { repository: repo.id, anchor: "adjust", revision: "a".repeat(40) });
  const evalSet = await call(ev + "EvaluationSet.create", { label: "Items" }), executor = await call(ev + "EvaluationExecutor.create", { key: "review", label: "Review" });
  const execution = await run(evaluations.create({ evaluationSet: String(evalSet.id), definition: String(pin.id), executor: String(executor.id) }, ctx));
  await run(evaluations.start(String(execution.id), "2026-01-01T00:00:00Z", ctx));
  const finish = await run(evaluations.finish(String(execution.id), "Completed", "2026-01-01T01:00:00Z", "Reviewed", ctx, String(seal.id)));
  const item = await run(api.item(String(record.id), 0, "80.000000", String(finish.id), String(seal.id), ctx));
  await run(decisions.respond(String(decision.id), String(voter.id), [approve ? 0 : 1], ctx)); await run(decisions.finalize(String(decision.id), ctx));
  const book = await call(lp + "LedgerBook.create", { key: "settlement" }), debit = await call(lp + "Account.create", { book: book.id, key: "fund", unit: "USD" }), credit = await call(lp + "Account.create", { book: book.id, key: "beneficiary", unit: "USD" });
  return { ...f, api, record, item, seal, book, debit, credit, coverage, entitlements, pin, decisions, set, voter };
}
for (const adapter of foundationAdapters) {
  it(`${adapter}: ambiguous or legacy timestamps cannot establish authority ordering`, async () => {
    for (const timestamp of ["2026-01-01T00:00:00.000Z", undefined, "invalid"]) {
      const f = await setup(adapter);
      try {
        
        const original = f.engine.call.bind(f.engine);
        const spy = vi.spyOn(f.engine, "call").mockImplementation((op, input, context) => original(op, input, context).pipe(Effect.map(row => op.endsWith(".get") && Object.hasOwn(row, "createdAt") ? {...row, createdAt: timestamp} : row)));
        try { await expect(run(f.api.determine(String(f.record.id), "60.000000", "Approved", String(f.seal.id), f.ctx))).rejects.toMatchObject({detail: 'Decision predates the adjudication context'}); }
        finally { spy.mockRestore(); }
      } finally { await f.close(); }
    }
  });
  it(`${adapter}: ambiguous item timestamps cannot prove prior Decision binding`, async () => {
    for (const timestamp of ["2026-01-01T00:00:00.000Z", undefined, "invalid"]) {
      const f = await setup(adapter);
      try {
        
        const first = (await run(new Decisions(f.engine).state(String(f.record.decisionCase), f.ctx))).events[0]!.createdAt;
        const original = f.engine.call.bind(f.engine);
        const spy = vi.spyOn(f.engine, "call").mockImplementation((op, input, context) => original(op, input, context).pipe(Effect.map(row => op === p + "AdjudicationItem.get" ? {...row, createdAt: timestamp === "2026-01-01T00:00:00.000Z" ? first : timestamp} : row)));
        try { await expect(run(f.api.determine(String(f.record.id), "60.000000", "Approved", String(f.seal.id), f.ctx))).rejects.toMatchObject({detail: 'Item was added after Decision responses'}); }
        finally { spy.mockRestore(); }
      } finally { await f.close(); }
    }
  });

  it(`${adapter}: determination, source reasons, exact idempotent settlement and three domains`, async () => {
    const f = await setup(adapter), { api, ctx, call } = f;
    try {
      await expect(run(api.determine(String(f.record.id), "100.000000", "Over request", String(f.seal.id), ctx))).rejects.toMatchObject({ detail: "Determination exceeds requested quantity" });
      const races = await Promise.allSettled([run(api.determine(String(f.record.id), "60.000000", "Approved in part", String(f.seal.id), ctx)), run(api.determine(String(f.record.id), "70.000000", "Different adjustment", String(f.seal.id), ctx))]);
      expect(races.filter(r => r.status === "fulfilled")).toHaveLength(1);
      const determination = (await run(api.determination(String(f.record.id), ctx)))!;
      expect(["60.000000", "70.000000"]).toContain(determination.authorized);
      await run(api.reason(String(determination.id), String(f.item.id), "Coverage limit applied", String(f.seal.id), ctx));
      const intent = await run(api.planSettlement(String(determination.id), String(f.book.id), String(f.debit.id), String(f.credit.id), ctx));
      const settles = await Promise.allSettled([run(api.settle(String(intent.id), ctx)), run(api.settle(String(intent.id), ctx))]);
      expect(settles.some(r => r.status === "fulfilled")).toBe(true);
      const link = await run(api.settle(String(intent.id), ctx));
      expect((await run(api.settlement(String(intent.id), ctx)))!.id).toBe(link.id);
      expect((await run(new Ledger(f.engine).rebuild(String(f.book.id), ctx))).groupIds).toHaveLength(1);
      expect((await run(new Ledger(f.engine).balance(String(f.credit.id), ctx))).quantity).toBe(determination.authorized);
      await expect(call(p + "SettlementIntent.create", { determination: determination.id, book: f.book.id, debit: f.debit.id, credit: f.credit.id, quantity: "61.000000", unit: "USD" })).rejects.toThrow();
      for (const [name, field] of [["ExpenseRequest", "expenseCode"], ["WarrantyRequest", "serialNumber"], ["HealthcarePreauthorization", "serviceCode"]]) expect(await call(`@fixture/adjudication-consumer/_/${name}.create`, { [field!]: "example", adjudicationCase: f.record.id })).toMatchObject({ adjudicationCase: f.record.id });
      await expect(run(api.determination(String(f.record.id), { ...ctx, tenant: "other" }))).rejects.toThrow();
      const finish = await call(ev + "EvaluationFinish.get", { id: f.item.evaluation });
      await call(ev + "EvaluationQuarantine.create", { run: finish.run, sourceDigest: "a".repeat(64), reason: "Legacy execution", recordedBy: ctx.actor });
      // A fresh undecided case isolates admission from existing terminal checks.
      const decision = await run(f.decisions.open({ participationSet: String(f.set.id), electors: [String(f.voter.id)], eligibilityAt: "2026-01-01T00:00:00Z", rule: "Single", options: ["Approve", "Reject"], deadline: "2027-01-01T00:00:00Z" }, ctx));
      const option = (await run(f.decisions.state(String(decision.id), ctx))).options[0]!;
      const next = await run(api.open({ key: "post-migration", coverage: String(f.coverage.id), coverageAt: "2026-01-01T00:00:00Z", decisionCase: String(decision.id), approvedOption: String(option.id), requested: "80.000000", unit: "USD", itemCount: 1, support: String(f.seal.id) }, ctx));
      await expect(run(api.item(String(next.id), 0, "80.000000", String(finish.id), String(f.seal.id), ctx))).rejects.toMatchObject({ detail: "Evaluation is quarantined; execute a new run with fresh bindings" });
      expect(await call(p + "AdjudicationItem.get", { id: f.item.id })).toMatchObject({ evaluation: finish.id });
    } finally { await f.close(); }
  });
  it(`${adapter}: fulfillment and explanation intents remain distinct from execution`, async () => {
    const f = await setup(adapter), { api, ctx, call } = f;
    try {
      const determination = await run(api.determine(String(f.record.id), "80.000000", "Approved", String(f.seal.id), ctx));
      const fp = "@forgegraph/foundation/fulfillment/_/", dp = "@forgegraph/foundation/delivery/_/";
      const set = await call(fp + "FulfillmentSet.create", { label: "Service" }), executor = await call(fp + "FulfillmentExecutor.create", { key: "provider" });
      const fulfillment = await call(fp + "Fulfillment.create", { fulfillmentSet: set.id, ordinal: 1, specificationPin: f.pin.id, executor: executor.id, requestedAt: "2026-01-01T00:00:00Z", evidence: f.seal.id });
      expect((await run(api.authorize(String(determination.id), String(fulfillment.id), ctx))).fulfillment).toBe(fulfillment.id);
      const destination = await call(dp + "DeliveryDestination.create", { key: "portal", label: "Portal" });
      const intent = await run(new Deliveries(f.engine).create({ key: "explanation", destination: String(destination.id), maxAttempts: 2 }, ctx));
      expect((await run(api.explain(String(determination.id), String(intent.id), ctx))).support).toBe(f.seal.id);
      await run(f.entitlements.revoke(String(f.coverage.id), "2025-12-31T00:00:00Z", "Later backdated termination", ctx));
      expect((await run(api.determination(String(f.record.id), ctx)))!.id).toBe(determination.id);
      const guarded = new Engine(f.engine.model, f.engine.layer);
      guarded.gatekeeper.authorizer = localAuthorizer({ policies: f.engine.model.resources.filter(r => r.id !== p + "Determination").map(r => ({ id: r.id, actions: [r.id + ".*"], requires: [], where: [] })), pips: [], epoch: 1, knownObligations: [] });
      await expect(run(new Adjudications(guarded).determination(String(f.record.id), ctx))).rejects.toMatchObject({ code: "NotFound" });
    } finally { await f.close(); }
  });
  it(`${adapter}: rejected Decision cannot authorize a positive award or settlement`, async () => {
    const f = await setup(adapter, false), { api, ctx } = f;
    try {
      await expect(run(api.determine(String(f.record.id), "1.000000", "Contradiction", String(f.seal.id), ctx))).rejects.toThrow();
      const determination = await run(api.determine(String(f.record.id), "0.000000", "Not covered", String(f.seal.id), ctx));
      await expect(run(api.planSettlement(String(determination.id), String(f.book.id), String(f.debit.id), String(f.credit.id), ctx))).rejects.toThrow();
      const guarded = new Engine(f.engine.model, f.engine.layer);
      guarded.gatekeeper.authorizer = localAuthorizer({ policies: f.engine.model.resources.map(r => ({ id: r.id, actions: [r.id + ".get"], requires: [], where: [] })), pips: [], epoch: 1, knownObligations: [] });
      await expect(run(new Adjudications(guarded).reason(String(determination.id), String(f.item.id), "Denied", String(f.seal.id), ctx))).rejects.toThrow();
    } finally { await f.close(); }
  });
}
