import { Effect } from "effect";
import { expect, it } from "vitest";
import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { ServiceLevels } from "../src/foundation/service-level.js";
import { Availability } from "../src/foundation/availability.js";
import { AgreementCatalog } from "../src/foundation/agreement-catalog.js";
import { Decisions } from "../src/foundation/decision.js";
import { Participations } from "../src/foundation/participation.js";
import { Evaluations } from "../src/foundation/evaluation.js";
import { Fulfillments } from "../src/foundation/fulfillment.js";
import { Engine } from "../src/engine.js";
import { localAuthorizer } from "../src/gatekeeper.js";
const p = "@forgegraph/foundation/service-level/_/", a = "@forgegraph/foundation/agreement-catalog/_/", sp = "@forgegraph/foundation/specification/_/", ep = "@forgegraph/foundation/entitlement/_/", pp = "@forgegraph/foundation/participation/_/", ev = "@forgegraph/foundation/evaluation/_/", fp = "@forgegraph/foundation/fulfillment/_/";
const run = Effect.runPromise;
async function setup(adapter: string, business = false) {
  const f = await foundation("service-level", adapter, true), { engine, call, ctx } = f;
  const api = new ServiceLevels(engine), agreements = new AgreementCatalog(engine), decisions = new Decisions(engine), evaluations = new Evaluations(engine), fulfillments = new Fulfillments(engine);
  const repository = await call(sp + "Repository.create", { key: "sla", provider: "git", locator: "https://example.test/sla" }), pin = await call(sp + "SpecificationPin.create", { repository: repository.id, anchor: "sla", revision: "a".repeat(40) });
  const parties = [];
  for (const label of ["Provider", "Customer"]) parties.push(await call("@forgegraph/foundation/party/_/Party.create", { label }));
  const set = await call(pp + "ParticipationSet.create", { label: "Signers" }), memberships = new Participations(engine, { namespace: "sla", roles: ["signer"] }); await run(memberships.registerRole("signer", ctx));
  const voters: string[] = [];
  for (const party of parties) voters.push(String((await run(memberships.add({ participationSet: String(set.id), participant: String(party.id), role: "signer", validFrom: "2025-01-01T00:00:00Z", reason: "Contract" }, ctx))).id));
  const scope = await call(ep + "EntitlementScope.create", { label: "Service" }), right = await call(ep + "RightDefinition.create", { namespace: "sla", name: "service" });
  const catalog = await call(a + "Catalog.create", { key: "services", label: "Services" }), entry = await call(a + "CatalogEntry.create", { catalog: catalog.id, key: "standard", specification: pin.id });
  const offer = await run(agreements.publish({ entry: String(entry.id), supplier: String(parties[0]!.id), terms: String(pin.id), scope: String(scope.id), right: String(right.id), validFrom: "2025-01-01T00:00:00Z", validUntil: "2027-01-01T00:00:00Z" }, ctx));
  const decision = await run(decisions.open({ participationSet: String(set.id), electors: voters, eligibilityAt: "2026-01-01T00:00:00Z", rule: "Unanimous", options: ["Accept"], deadline: "2027-01-01T00:00:00Z" }, ctx));
  const option = (await run(decisions.state(String(decision.id), ctx))).options[0]!;
  await run(agreements.select(String(offer.id), String(decision.id), String(option.id), ctx));
  for (const voter of voters) await run(decisions.respond(String(decision.id), voter, [0], ctx)); await run(decisions.finalize(String(decision.id), ctx));
  const agreement = await run(agreements.accept({ acceptanceKey: "agreement", offer: String(offer.id), customer: String(parties[1]!.id), supplierParticipation: voters[0]!, customerParticipation: voters[1]!, decisionCase: String(decision.id), approvedOption: String(option.id), expectedTerms: String(pin.id), validFrom: "2026-01-02T00:00:00Z", validUntil: "2027-01-01T00:00:00Z" }, ctx));
  const issued = await run(agreements.issue(String(agreement.id), ctx));
  let calendar: string | null = null;
  if (business) { const availability = new Availability(engine), calendarRow = await run(availability.createCalendar("Office hours", ctx)); calendar = String((await run(availability.createRevision({ calendar: String(calendarRow.id), timezone: "UTC", weekly: [1, 2, 3, 4, 5].map(weekday => ({ weekday, startMinute: 540, endMinute: 1020 })) }, ctx))).id); }
  const policy = await call(p + "ServiceLevelPolicy.create", { key: "response", specification: pin.id, clock: business ? "Business" : "UTC", calendar });
  const objective = await call(p + "ServiceLevelObjective.create", { policy: policy.id, name: "respond", targetMinutes: 60, warningMinutes: 30 });
  const fulfillSet = await call(fp + "FulfillmentSet.create", { label: "Requests" }), executor = await call(fp + "FulfillmentExecutor.create", { key: "service" });
  const startedAt = business ? "2026-01-05T16:30:00Z" : "2026-01-05T00:00:00Z";
  const fulfillment = await call(fp + "Fulfillment.create", { fulfillmentSet: fulfillSet.id, ordinal: 1, executor: executor.id, specificationPin: pin.id, requestedAt: startedAt });
  const instance = await run(api.start({ key: "request", objective: String(objective.id), agreement: String(agreement.id), right: String(issued.right), fulfillment: String(fulfillment.id), startedAt, horizon: "2026-01-07T00:00:00Z" }, ctx));
  const evaluationSet = await call(ev + "EvaluationSet.create", { label: "SLA assessments" }), evalExecutor = await call(ev + "EvaluationExecutor.create", { key: "clock", label: "Clock" });
  async function assessment() { const execution = await run(evaluations.create({ evaluationSet: String(evaluationSet.id), definition: String(pin.id), executor: String(evalExecutor.id) }, ctx)); await run(evaluations.start(String(execution.id), "2026-01-05T00:00:00Z", ctx)); return String((await run(evaluations.finish(String(execution.id), "Completed", "2026-01-06T12:00:00Z", "Clock evaluated", ctx))).id); }
  return { ...f, api, instance, fulfillment, fulfillments, assessment, parties, scope };
}
for (const adapter of foundationAdapters) {
  it(`${adapter}: raw instances cannot acquire rights from an agreement suspended at start`,async()=>{
    const f=await setup(adapter);try{
      await run(new AgreementCatalog(f.engine).transition(String(f.instance.agreement),"Suspended","Suspended before tracking",f.ctx));
      const fields={key:"raw-suspended",objective:f.instance.objective,agreement:f.instance.agreement,right:f.instance.right,entitlement:f.instance.entitlement,entitlementEnd:null,fulfillment:f.instance.fulfillment,startedAt:f.instance.startedAt,horizon:f.instance.horizon};
      const raw=await f.call(p+"ServiceLevelInstance.create",fields);
      await expect(run(f.api.state(String(raw.id),String(raw.startedAt),f.ctx))).rejects.toMatchObject({code:"ValidationFailed"});
    }finally{await f.close();}
  });

  it(`${adapter}: pinned UTC clock, pauses, durable breach races and late completion`, async () => {
    const f = await setup(adapter), { api, ctx, call } = f, id = String(f.instance.id);
    try {
      await run(api.pause(id, "2026-01-05T00:20:00Z", "Waiting", ctx));
      await expect(run(api.pause(id, "2026-01-05T00:30:00Z", "Duplicate", ctx))).rejects.toThrow();
      await run(api.resume(id, "2026-01-05T00:40:00Z", "Ready", ctx));
      expect((await run(api.state(id, "2026-01-05T01:00:00Z", ctx))).dueAt).toBe("2026-01-05T01:20:00.000Z");
      const assessment = await f.assessment();
      await run(api.assess(id, "2026-01-05T01:21:00Z", assessment, ctx));
      const breaches = await Promise.allSettled([run(api.breach(id, "2026-01-05T01:21:00Z", ctx)), run(api.breach(id, "2026-01-05T01:21:00Z", ctx))]);
      expect(breaches.some(b => b.status === "fulfilled")).toBe(true);
      const breach = (await run(api.breach(id, "2026-01-05T01:21:00Z", ctx)))!;
      await run(f.fulfillments.start(String(f.fulfillment.id), "2026-01-05T00:00:00Z", ctx));
      await run(f.fulfillments.finish(String(f.fulfillment.id), "completed", "complete", "2026-01-05T01:10:00Z", "Late arrival", ctx));
      await run(api.assess(id, "2026-01-05T01:30:00Z", await f.assessment(), ctx));
      expect((await run(api.state(id, "2026-01-05T01:30:00Z", ctx))).verdict).toBe("Breached");
      const requirement = await call(ep + "RequirementDefinition.create", { namespace: "sla", name: "remedy" });
      const duty = await call(ep + "Obligation.create", { obligatedParty: f.parties[0]!.id, requirement: requirement.id, scope: f.scope.id, incurredAt: "2026-01-05T01:21:00Z", reason: "Breach", recordedBy: ctx.actor });
      const remedy = await run(api.remedy(String(breach.id), { obligation: String(duty.id) }, ctx));
      expect((await run(api.remedy(String(breach.id), { obligation: String(duty.id) }, ctx))).id).toBe(remedy.id);
      for (const [name, field] of [["SupportFirstResponse", "ticket"], ["LabTurnaround", "sample"], ["DeploymentObjective", "deployment"]]) expect(await call(`@fixture/service-level-consumer/_/${name}.create`, { [field!]: "example", instance: id })).toMatchObject({ instance: id });
    } finally { await f.close(); }
  });
  it(`${adapter}: business hours use pinned Availability and completion before deadline is met`, async () => {
    const f = await setup(adapter, true), { api, ctx } = f, id = String(f.instance.id);
    try {
      expect((await run(api.state(id, "2026-01-05T16:30:00Z", ctx))).dueAt).toBe("2026-01-06T09:30:00.000Z");
      await run(api.pause(id, "2026-01-05T16:45:00Z", "Waiting", ctx));
      await run(api.resume(id, "2026-01-06T09:15:00Z", "Ready", ctx));
      const state = await run(api.state(id, "2026-01-06T09:45:00Z", ctx)); expect(state.elapsedMinutes).toBe(45); expect(state.dueAt).toBe("2026-01-06T10:00:00.000Z");
      await run(f.fulfillments.start(String(f.fulfillment.id), "2026-01-05T16:30:00Z", ctx));
      await run(f.fulfillments.finish(String(f.fulfillment.id), "completed", "complete", "2026-01-06T09:45:00Z", "Responded", ctx));
      expect((await run(api.assess(id, "2026-01-06T10:01:00Z", await f.assessment(), ctx))).verdict).toBe("Met");
      expect(await run(api.breach(id, "2026-01-06T10:01:00Z", ctx))).toBeNull();
      await expect(run(api.resume(id, "2026-01-06T10:02:00Z", "Late", ctx))).rejects.toThrow();
    } finally { await f.close(); }
  });
  it(`${adapter}: hidden pause history, denied assessment and cross-tenant access fail closed`, async () => {
    const f = await setup(adapter), { api, ctx, engine } = f, id = String(f.instance.id);
    try {
      await run(api.pause(id, "2026-01-05T00:20:00Z", "Waiting", ctx));
      const guarded = new Engine(engine.model, engine.layer);
      guarded.gatekeeper.authorizer = localAuthorizer({ policies: engine.model.resources.filter(r => r.id !== p + "ServiceLevelEvent").map(r => ({ id: r.id, actions: [r.id + ".*"], requires: [], where: [] })), pips: [], epoch: 1, knownObligations: [] });
      await expect(run(new ServiceLevels(guarded).state(id, "2026-01-05T00:30:00Z", ctx))).rejects.toThrow();
      guarded.gatekeeper.authorizer = localAuthorizer({ policies: engine.model.resources.map(r => ({ id: r.id, actions: [r.id + ".get"], requires: [], where: [] })), pips: [], epoch: 2, knownObligations: [] });
      await expect(run(new ServiceLevels(guarded).assess(id, "2026-01-05T00:30:00Z", await f.assessment(), ctx))).rejects.toThrow();
      await expect(run(api.state(id, "2026-01-05T00:30:00Z", { ...ctx, tenant: "other" }))).rejects.toThrow();
    } finally { await f.close(); }
  });
}
