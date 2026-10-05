/** Synthetic legacy schema rehearsal; never evidence of a production export or cutover. */
import { resolve } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { Model, type AppBundle, type Expr } from "../src/model.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import type { Snapshot } from "../src/portability.js";
import { Evaluations } from "../src/foundation/evaluation.js";
import { foundation } from "./helpers/foundation.js";
const p = "@forgegraph/foundation/participation/_/", party = "@forgegraph/foundation/party/_/Party";
const e = "@forgegraph/foundation/evaluation/_/", a = "@forgegraph/foundation/agreement-catalog/_/";
const q = "@forgegraph/foundation/quotation-pricing/_/", s = "@forgegraph/foundation/specification/_/", l = "@forgegraph/foundation/ledger/_/";
const admin = "@foundation-probe/quotation-pricing-consumers/_/admin.";
const at = "2026-01-01T00:00:00.000Z", until = "2027-01-01T00:00:00.000Z", recordedAt = "2026-09-23T00:00:00.000Z";
const run = Effect.runPromise;
const removed = new Set([a + "AgreementAcceptance", a + "AgreementAcceptanceCommit", e + "EvaluationQuarantine",
  "@forgegraph/foundation/party/_/PrincipalRepresentation", "@forgegraph/foundation/party/_/RepresentationRevocation"]);

function refersTo(expr: Expr, names: string[]): boolean {
  if (expr.kind === "name") return names.includes(expr.path[0]!);
  if (expr.kind === "binary") return refersTo(expr.lhs, names) || refersTo(expr.rhs, names);
  if (expr.kind === "unary") return refersTo(expr.operand, names);
  if (expr.kind === "call") return expr.args.some(arg => refersTo(arg, names));
  return false;
}
function legacyBundle(target: AppBundle): AppBundle {
  // Rename the identity throughout the synthetic bundle (operations included), while
  // retaining all current consumer resources. This is explicitly not an old release.
  const source = JSON.parse(JSON.stringify(target).replaceAll(party, p + "Participant")) as AppBundle;
  source.buildHash = "synthetic-legacy-quotation-migration";
  for (const module of source.ir.modules) {
    module.resources = module.resources.filter(resource => !removed.has(resource.id));
    for (const resource of module.resources) {
      if (resource.id === p + "Participant") resource.name = "Participant";
      if (resource.id === e + "EvaluationStart") {
        resource.decorators.timestamps = false;
        resource.fields = resource.fields.filter(field => !["createdAt", "updatedAt"].includes(field.name));
      }
      if (resource.id === a + "Agreement") {
        resource.fields = resource.fields.filter(field => field.name !== "acceptance");
        resource.rules = resource.rules.filter(rule => !refersTo(rule, ["acceptance"]));
      }
      if (resource.id === q + "QuoteEnd") {
        resource.fields = resource.fields.filter(field => !["intent", "acceptanceDigest"].includes(field.name));
        resource.rules = resource.rules.filter(rule => !refersTo(rule, ["intent", "acceptanceDigest"]));
      }
    }
  }
  return source;
}

async function legacySource(target: AppBundle, accepted = false) {
  const bundle = legacyBundle(target), engine = new Engine(new Model(bundle), testLayer(new MemoryStorage()));
  const ctx = { tenant: "acme", actor: "synthetic-migration", requestId: "legacy-export" };
  const call = (op: string, input: Record<string, unknown>) => run(engine.call(op, input, ctx));
  const supplier = await call(p + "Participant.create", { label: "Legacy supplier" });
  const buyer = await call(p + "Participant.create", { label: "Legacy buyer" });
  const set = await call(p + "ParticipationSet.create", { label: "Historic signers" });
  const role = await call(p + "ParticipationRole.create", { namespace: "migration", name: "signer" });
  const participation = await call(p + "Participation.create", { participationSet: set.id, participant: supplier.id, role: role.id, validFrom: at, validUntil: null, recordedBy: ctx.actor, reason: "Historical membership" });
  const repo = await call(s + "Repository.create", { key: "migration", provider: "git", locator: "https://example.test/synthetic" });
  const pin = await call(s + "SpecificationPin.create", { repository: repo.id, anchor: "legacy", revision: "a".repeat(40) });
  const evalSet = await call(e + "EvaluationSet.create", { label: "Historical evaluation" });
  const executor = await call(e + "EvaluationExecutor.create", { key: "migration", label: "Legacy executor" });
  const evaluation = await call(e + "EvaluationRun.create", { evaluationSet: evalSet.id, definition: pin.id, executor: executor.id, parent: null, depth: 1 });
  const start = await call(e + "EvaluationStart.create", { run: evaluation.id, startedAt: at, recordedBy: ctx.actor });
  const finish = await call(e + "EvaluationFinish.create", { run: evaluation.id, start: start.id, outcome: "Completed", finishedAt: "2026-01-02T00:00:00Z", support: null, reason: "Historical assessment", recordedBy: ctx.actor });
  const catalog = await call(a + "Catalog.create", { key: "migration", label: "Legacy catalog" });
  const entry = await call(a + "CatalogEntry.create", { catalog: catalog.id, key: "service", specification: pin.id });
  const scope = await call("@forgegraph/foundation/entitlement/_/EntitlementScope.create", { label: "Service" });
  const offer = await call(a + "Offer.create", { entry: entry.id, revision: 1, supplier: supplier.id, terms: pin.id, scope: scope.id, validFrom: at, validUntil: until });
  const customerParticipation = await call(p + "Participation.create", { participationSet: set.id, participant: buyer.id, role: role.id, validFrom: at, validUntil: null, recordedBy: ctx.actor, reason: "Historical buyer" });
  const d = "@forgegraph/foundation/decision/_/";
  const elector = await call(d + "DecisionElector.create", { participation: participation.id, depth: 1 });
  const decision = await call(d + "DecisionCase.create", { participationSet: set.id, electors: elector.id, eligibilityAt: at, rule: "Single", ruleVersion: "decision-rule/1", threshold: 1, optionCount: 1, deadline: until });
  const option = await call(d + "DecisionOption.create", { decisionCase: decision.id, ordinal: 0, label: "Approve" });
  const qualification = await call(a + "OfferQualification.create", { offer: offer.id, decisionCase: decision.id, approvedOption: option.id });
  const response = await call(d + "DecisionResponse.create", { decisionCase: decision.id, voter: participation.id, ranking: [0], recordedBy: ctx.actor });
  const member = await call(d + "DecisionOutcomeMember.create", { response: response.id, depth: 1 });
  const outcome = await call(d + "DecisionOutcome.create", { decisionCase: decision.id, selected: option.id, responses: member.id, snapshotDigest: "b".repeat(64) });
  const agreement = await call(a + "Agreement.create", { acceptanceKey: "historic-contract", offer: offer.id, supplier: supplier.id, customer: buyer.id, supplierParticipation: participation.id, customerParticipation: customerParticipation.id, qualification: qualification.id, approvalOption: option.id, approval: outcome.id, terms: pin.id, validFrom: "2026-02-01T00:00:00Z", validUntil: until, change: "Original", recordedBy: ctx.actor });
  const end = await call(p + "ParticipationEnd.create", { participation: participation.id, effectiveAt: "2026-02-01T00:00:00Z", revoked: true, recordedBy: ctx.actor, reason: "Historical revocation" });
  const book = await call(l + "LedgerBook.create", { key: "legacy" });
  const account = await call(l + "Account.create", { book: book.id, key: "USD", unit: "USD" });
  const rate = await call(q + "PricingRate.create", { key: "legacy", definition: pin.id, account: account.id, unitPrice: "1.000000", validFrom: at, validUntil: until });
  const line = await call(q + "QuoteLine.create", { rate: rate.id, quantity: "2.000000" });
  const quote = await call(q + "Quote.create", { key: "legacy", offer: offer.id, buyer: buyer.id, terms: pin.id, evaluation: finish.id, pricedAt: at, expiresAt: until, head: line.id });
  if (!accepted) engine.testClockJump(400 * 24 * 60 * 60 * 1000);
  const terminal = await call(q + "QuoteEnd.create", { quote: quote.id, outcome: accepted ? "Accepted" : "Expired", reason: "Legacy terminal fact" });
  await call(admin + "fence", { on: true });
  const snapshot = await call(admin + "export", {}) as unknown as Snapshot;
  return { bundle, snapshot, supplier, buyer, participation, end, start, finish, evaluation, quote, terminal, agreement };
}

for (const provider of process.env.FORGE_FOUNDATION_PG_URL ? ["sqlite", "postgres"] : ["sqlite"]) {
  it(`${provider}: composed legacy export imports identities, history and quarantine behind a fence`, async () => {
    const target = await foundation("quotation-pricing", provider, true);
    try {
      const { composeFoundationMigration, migrationDigest } = await import(resolve(import.meta.dirname, "../../../scripts/foundation-migration-compose.mjs"));
      const source = await legacySource(target.engine.model.bundle);
      const before = structuredClone(source.snapshot);
      const referenceFields = source.bundle.ir.modules.flatMap(module => module.resources.flatMap(resource => resource.fields
        .filter(field => field.type.base.kind === "reference" && field.type.base.resource === p + "Participant")
        .map(field => ({ resource: resource.id, field: field.name }))));
      const reviewFor = (snapshot: Snapshot) => ({ version: 1, tenant: "acme", sourceDigest: migrationDigest(snapshot),
        sourceBuildHash: source.bundle.buildHash, targetBuildHash: target.engine.model.bundle.buildHash,
        sourceBundleDigest: migrationDigest(source.bundle), targetBundleDigest: migrationDigest(target.engine.model.bundle),
        reviewedBy: "migration-operator", recordedAt, legacyAcceptedQuotes: "block", ordinaryAgreements: "preserve-without-acceptance",
        emptyTargetResources: [...removed].filter(id => id !== e + "EvaluationQuarantine"),
        identity: { referenceFields, mapping: [source.supplier, source.buyer].map((row, index) => ({ tenant: "acme", participant: row.id, party: `migrated-party-${index}` })),
          parties: [source.supplier, source.buyer].map((row, index) => ({ tenant: "acme", id: `migrated-party-${index}`, label: row.label, identifiers: null, createdAt: at, updatedAt: at })) } });
      const prepared = composeFoundationMigration(source.snapshot, source.bundle, target.engine.model.bundle, reviewFor(source.snapshot));
      expect(source.snapshot).toEqual(before);
      expect(prepared.report).toMatchObject({ status: "prepared-for-fenced-rehearsal", deploymentAuthorized: false, sourceCompletenessProven: false, identityCount: 2 });
      expect(prepared.snapshot.resources[p + "ParticipationEnd"]).toEqual(source.snapshot.resources[p + "ParticipationEnd"]);
      expect(prepared.snapshot.resources[e + "EvaluationFinish"]).toEqual(source.snapshot.resources[e + "EvaluationFinish"]);
      await target.call(admin + "fence", { on: true });
      await expect(target.call(party + ".create", { label: "Premature traffic" })).rejects.toMatchObject({ code: "WriteFenced" });
      const imported = await target.call(admin + "import", { snapshot: prepared.snapshot });
      expect((imported.imported as Record<string, number>)[party]).toBe(2);
      expect(await target.call(admin + "verify", { snapshot: prepared.snapshot })).toMatchObject({ ok: true });
      const repeated = await target.call(admin + "import", { snapshot: prepared.snapshot });
      expect((repeated.skipped as Record<string, number>)[e + "EvaluationQuarantine"]).toBe(1);
      expect(await target.call(p + "Participation.get", { id: source.participation.id })).toMatchObject({ participant: "migrated-party-0" });
      expect(await target.call(p + "ParticipationEnd.get", { id: source.end.id })).toEqual(source.end);
      expect(await target.call(a + "Agreement.get", { id: source.agreement.id })).toEqual({ ...source.agreement, supplier: "migrated-party-0", customer: "migrated-party-1", acceptance: null });
      expect(await target.call(q + "Quote.get", { id: source.quote.id })).toMatchObject({ buyer: "migrated-party-1" });
      expect(await target.call(q + "QuoteEnd.get", { id: source.terminal.id })).toMatchObject({ outcome: "Expired", intent: null, acceptanceDigest: null });
      expect(await target.call(e + "EvaluationStart.get", { id: source.start.id })).toMatchObject({ startedAt: at, createdAt: recordedAt });
      const quarantine = prepared.snapshot.resources[e + "EvaluationQuarantine"].records[0];
      expect(quarantine.sourceDigest).toBe(migrationDigest(source.snapshot));
      expect(await target.call(e + "EvaluationQuarantine.get", { id: quarantine.id })).toEqual(quarantine);
      for (const id of [a + "AgreementAcceptance", a + "AgreementAcceptanceCommit"]) expect(prepared.snapshot.resources[id].count).toBe(0);
      await target.call(admin + "fence", { on: false });
      expect(await run(new Evaluations(target.engine).phase(String(source.evaluation.id), target.ctx))).toBe("Completed");
      await expect(run(new Evaluations(target.engine).result(String(source.finish.id), target.ctx))).rejects.toMatchObject({ detail: "Evaluation is quarantined; execute a new run with fresh bindings" });
      const accepted = await legacySource(target.engine.model.bundle, true);
      const blocked = composeFoundationMigration(accepted.snapshot, accepted.bundle, target.engine.model.bundle, reviewFor(accepted.snapshot));
      expect(blocked.snapshot).toBeNull();
      expect(blocked.report).toMatchObject({ status: "blocked", deploymentAuthorized: false, unresolved: [{ resource: q + "QuoteEnd", id: accepted.terminal.id }] });
    } finally { await target.close(); }
  });
}
