import { Storage } from "../src/services.js";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { AgreementCatalog, type AcceptAgreement } from "../src/foundation/agreement-catalog.js";
import { Evaluations } from "../src/foundation/evaluation.js";
import { Decisions } from "../src/foundation/decision.js";
import { Participations } from "../src/foundation/participation.js";
import { Artifacts } from "../src/foundation/artifact.js";
import { Engine } from "../src/engine.js";
import { localAuthorizer } from "../src/gatekeeper.js";
const p = "@forgegraph/foundation/agreement-catalog/_/", sp = "@forgegraph/foundation/specification/_/", ep = "@forgegraph/foundation/entitlement/_/", pp = "@forgegraph/foundation/participation/_/", ap = "@forgegraph/foundation/artifact/_/";
const run = Effect.runPromise;
async function setup(adapter: string) {
  const f = await foundation("agreement-catalog", adapter, true), { engine, ctx, call } = f;
  const api = new AgreementCatalog(engine), decisions = new Decisions(engine);
  const repository = await call(sp + "Repository.create", { key: "terms", provider: "git", locator: "https://example.test/terms" });
  const pin = await call(sp + "SpecificationPin.create", { repository: repository.id, anchor: "service", revision: "a".repeat(40) });
  const artifact = await call(ap + "Artifact.create", { key: "terms", label: "Terms" });
  const content = await call(ap + "ArtifactContent.create", {});
  const upload = await call(ap + "ArtifactContent.beginUpload", { id: content.id, expectedVersion: 1, mediaType: "text/plain", byteCount: 5 });
  await f.objects.simulateUpload((upload.upload as { url: string }).url, new TextEncoder().encode("Terms"), "text/plain");
  const sealed = await call(ap + "ArtifactContent.finalizeUpload", { id: content.id, expectedVersion: 2 });
  const document = await run(new Artifacts(engine).publish({ artifact: String(artifact.id), content: String(content.id), digest: String(sealed.digest), specificationPin: String(pin.id) }, ctx));
  const supplier = await call("@forgegraph/foundation/party/_/Party.create", { label: "Supplier" }), customer = await call("@forgegraph/foundation/party/_/Party.create", { label: "Customer" });
  const set = await call(pp + "ParticipationSet.create", { label: "Signatories" });
  const members = new Participations(engine, { namespace: "agreements", roles: ["signer"] });
  await run(members.registerRole("signer", ctx));
  const signerIds: string[] = [];
  for (const party of [supplier, customer]) signerIds.push(String((await run(members.add({ participationSet: String(set.id), participant: String(party.id), role: "signer", validFrom: "2025-01-01T00:00:00Z", reason: "Authorized representative" }, ctx))).id));
  const scope = await call(ep + "EntitlementScope.create", { label: "Service" }), right = await call(ep + "RightDefinition.create", { namespace: "agreement", name: "use-service" }), requirement = await call(ep + "RequirementDefinition.create", { namespace: "agreement", name: "pay-invoice" });
  const catalog = await call(p + "Catalog.create", { key: "services", label: "Services" }), entry = await call(p + "CatalogEntry.create", { catalog: catalog.id, key: "standard", specification: pin.id });
  const evidencePrefix = "@forgegraph/foundation/evidence/_/", evaluationPrefix = "@forgegraph/foundation/evaluation/_/";
  const evidence = await call(evidencePrefix + "EvidenceBundle.create", { key: "terms-support", label: "Terms support" });
  const seal = await call(evidencePrefix + "EvidenceSeal.create", { bundle: evidence.id, head: null, recordedBy: ctx.actor });
  const evaluationSet = await call(evaluationPrefix + "EvaluationSet.create", { label: "Qualifications" });
  const executor = await call(evaluationPrefix + "EvaluationExecutor.create", { key: "review", label: "Review" });
  const evaluations = new Evaluations(engine);
  const evaluation = await run(evaluations.create({ evaluationSet: String(evaluationSet.id), definition: String(pin.id), executor: String(executor.id) }, ctx));
  await run(evaluations.start(String(evaluation.id), "2026-01-01T00:00:00Z", ctx));
  const finish = await run(evaluations.finish(String(evaluation.id), "Completed", "2026-01-01T00:00:01Z", "Qualification ran", ctx, String(seal.id)));
  const offerInput = { support: String(seal.id), evaluation: String(finish.id), entry: String(entry.id), supplier: String(supplier.id), terms: String(pin.id), document: String(document.id), scope: String(scope.id), right: String(right.id), requirement: String(requirement.id), validFrom: "2025-01-01T00:00:00Z", validUntil: "2027-01-01T00:00:00Z" };
  const offer = await run(api.publish(offerInput, ctx));
  async function approve(offerId = String(offer.id), responses = 2) {
    const decision = await run(decisions.open({ participationSet: String(set.id), electors: signerIds, eligibilityAt: "2026-01-01T00:00:00Z", rule: "Quorum", threshold: 1, options: ["Accept", "Reject"], deadline: "2027-01-01T00:00:00Z" }, ctx));
    const state = await run(decisions.state(String(decision.id), ctx));
    await run(api.select(offerId, String(decision.id), String(state.options[0]!.id), ctx));
    for (const voter of signerIds.slice(0, responses)) await run(decisions.respond(String(decision.id), voter, [0], ctx));
    await run(decisions.finalize(String(decision.id), ctx));
    return { decisionCase: String(decision.id), approvedOption: String(state.options[0]!.id) };
  }
  const approval = await approve();
  const input: AcceptAgreement = { acceptanceKey: "first", offer: String(offer.id), customer: String(customer.id), supplierParticipation: signerIds[0]!, customerParticipation: signerIds[1]!, ...approval, expectedTerms: String(pin.id), expectedDocument: String(document.id), validFrom: "2026-02-01T00:00:00Z", validUntil: "2026-12-01T00:00:00Z" };
  return { ...f, api, decisions, members, pin, document, supplier, customer, signerIds, scope, offer, offerInput, approve, input };
}
for (const adapter of foundationAdapters) {
  it(`${adapter}: ambiguous or legacy timestamps cannot establish authority ordering`, async () => {
    for (const timestamp of ["2026-01-01T00:00:00.000Z", undefined, "invalid"]) {
      const f = await setup(adapter);
      try {
        
        const original = f.engine.call.bind(f.engine);
        const spy = vi.spyOn(f.engine, "call").mockImplementation((op, input, context) => original(op, input, context).pipe(Effect.map(row => op.endsWith(".get") && Object.hasOwn(row, "createdAt") ? {...row, createdAt: timestamp} : row)));
        try { await expect(run(f.api.accept(f.input, f.ctx))).rejects.toMatchObject({detail: 'Offer selection must precede decision responses'}); }
        finally { spy.mockRestore(); }
      } finally { await f.close(); }
    }
  });

  it(`${adapter}: pinned acceptance, resumable exactly-once issuance and four typed domains`, async () => {
    const f = await setup(adapter), { api, ctx, call } = f;
    try {
      const attempts = await Promise.allSettled([run(api.accept(f.input, ctx)), run(api.accept(f.input, ctx))]);
      const accepted = attempts.find(a => a.status === "fulfilled");
      expect(accepted).toBeDefined();
      const agreement = (accepted as PromiseFulfilledResult<Record<string, unknown>>).value, id = String(agreement.id);
      expect((await run(api.accept(f.input, ctx))).id).toBe(id);
      expect((await run(api.state(id, "2026-03-01T00:00:00Z", ctx))).phase).toBe("PendingIssuance");
      const issued = await Promise.allSettled([run(api.issue(id, ctx)), run(api.issue(id, ctx))]);
      expect(issued.some(a => a.status === "fulfilled")).toBe(true);
      const completed = await run(api.issue(id, ctx));
      expect((await run(api.issue(id, ctx))).id).toBe(completed.id);
      const rights = await call(ep + "Entitlement.list.byHolderScope", { params: { holder: f.customer.id, scope: f.scope.id } });
      const duties = await call(ep + "Obligation.list.byObligatedPartyScope", { params: { obligatedParty: f.customer.id, scope: f.scope.id } });
      expect(rights.items).toHaveLength(1); expect(duties.items).toHaveLength(1);
      expect((await run(api.state(id, "2026-03-01T00:00:00Z", ctx))).phase).toBe("Active");
      expect(await run(api.rightsAt(id, "2026-03-01T00:00:00Z", ctx))).toHaveLength(1);
      for (const [name, field] of [["SaaSSubscription", "workspace"], ["CourseEnrollment", "courseCode"], ["LabServiceOrder", "sampleCode"], ["VendorContract", "vendorCode"]]) expect(await call(`@fixture/agreement-catalog-consumer/_/${name}.create`, { [field!]: "example", agreement: id })).toMatchObject({ agreement: id });
      await expect(call(p + "Agreement.update", { id, patch: { terms: "drift" } })).rejects.toThrow();
      await expect(run(api.accept({ ...f.input, expectedTerms: "drift" }, ctx))).rejects.toThrow();
      await expect(run(api.accept({ ...f.input, validUntil: "2026-11-01T00:00:00Z" }, ctx))).rejects.toMatchObject({ code: "IdempotencyMismatch" });
      await expect(run(api.state(id, "2026-03-01T00:00:00Z", { ...ctx, tenant: "other" }))).rejects.toThrow();
    } finally { await f.close(); }
  });
  it(`${adapter}: missing signers, expired offers and lifecycle history`, async () => {
    const f = await setup(adapter), { api, ctx } = f;
    try {
      const missing = await f.approve(String(f.offer.id), 1);
      await expect(run(api.accept({ ...f.input, acceptanceKey: "missing", ...missing }, ctx))).rejects.toMatchObject({ detail: "Both signers must approve the selected terms through Decision" });
      const agreement = await run(api.accept(f.input, ctx)), id = String(agreement.id);
      await run(api.issue(id, ctx));
      const races = await Promise.allSettled([run(api.transition(id, "Suspended", "Review", ctx)), run(api.transition(id, "Suspended", "Competing review", ctx))]);
      expect(races.filter(r => r.status === "fulfilled")).toHaveLength(1);
      let state = await run(api.state(id, "2026-03-01T00:00:00Z", ctx));
      if (state.phase === "Suspended") {
        await run(api.transition(id, "Resumed", "Review done", ctx));
        await run(api.transition(id, "Terminated", "Exit", ctx));
      }
      state = await run(api.state(id, "2026-03-01T00:00:00Z", ctx));
      expect(state.phase).toBe("Terminated");
      expect(await run(api.rightsAt(id, "2026-03-01T00:00:00Z", ctx))).toHaveLength(0);
      await expect(run(api.transition(id, "Resumed", "Illegal", ctx))).rejects.toThrow();
      f.engine.testClockJump(366 * 24 * 60 * 60 * 1000);
      await expect(run(api.accept({ ...f.input, acceptanceKey: "expired", validFrom: "2028-01-01T00:00:00Z", validUntil: "2029-01-01T00:00:00Z" }, ctx))).rejects.toThrow();
    } finally { await f.close(); }
  });
  it(`${adapter}: independent successor agreements, denied issuance and hidden lifecycle`, async () => {
    const f = await setup(adapter), { api, ctx, engine } = f;
    try {
      const agreement = await run(api.accept(f.input, ctx)), id = String(agreement.id);
      const guarded = new Engine(engine.model, engine.layer);
      guarded.gatekeeper.authorizer = localAuthorizer({ policies: engine.model.resources.map(r => ({ id: r.id, actions: [r.id + ".get"], requires: [], where: [] })), pips: [], epoch: 1, knownObligations: [] });
      await expect(run(new AgreementCatalog(guarded).issue(id, ctx))).rejects.toThrow();
      expect((await run(api.state(id, "2026-03-01T00:00:00Z", ctx))).issuance).toBeNull();
      const nextOffer = await run(api.publish({ ...f.offerInput, previous: String(f.offer.id) }, ctx));
      const nextApproval = await f.approve(String(nextOffer.id));
      const successor = await run(api.accept({ ...f.input, ...nextApproval, acceptanceKey: "renewal", offer: String(nextOffer.id), predecessor: id, change: "Renewal", validFrom: "2026-12-01T00:00:00Z", validUntil: "2027-12-01T00:00:00Z" }, ctx));
      expect(successor.predecessor).toBe(id);
      const amendmentOffer = await run(api.publish({ ...f.offerInput, previous: String(nextOffer.id) }, ctx));
      const amendmentApproval = await f.approve(String(amendmentOffer.id));
      const amendment = await run(api.accept({ ...f.input, ...amendmentApproval, acceptanceKey: "amendment", offer: String(amendmentOffer.id), predecessor: String(successor.id), change: "Amendment" }, ctx));
      expect(amendment.predecessor).toBe(successor.id);
      await expect(run(api.accept({ ...f.input, acceptanceKey: "foreign" }, { ...ctx, tenant: "other" }))).rejects.toThrow();
      expect((await run(api.state(id, "2026-03-01T00:00:00Z", ctx))).agreement.offer).toBe(f.offer.id);
      await run(api.transition(id, "Suspended", "Pause", ctx));
      guarded.gatekeeper.authorizer = localAuthorizer({ policies: engine.model.resources.filter(r => r.id !== p + "AgreementEvent").map(r => ({ id: r.id, actions: [r.id + ".*"], requires: [], where: [] })), pips: [], epoch: 2, knownObligations: [] });
      await expect(run(new AgreementCatalog(guarded).state(id, "2026-03-01T00:00:00Z", ctx))).rejects.toThrow();
    } finally { await f.close(); }
  });
  it(`${adapter}: interrupted issuance resumes without duplicate grants`, async () => {
    const f = await setup(adapter), { api, ctx, engine, call } = f;
    try {
      const agreement = await run(api.accept(f.input, ctx)), id = String(agreement.id);
      const guarded = new Engine(engine.model, engine.layer);
      guarded.gatekeeper.authorizer = localAuthorizer({ policies: engine.model.resources.map(r => ({ id: r.id, actions: [r.id + (r.id === p + "AgreementEntitlementLink" ? ".get" : ".*")], requires: [], where: [] })), pips: [], epoch: 1, knownObligations: [] });
      await expect(run(new AgreementCatalog(guarded).issue(id, ctx))).rejects.toThrow();
      expect((await run(api.state(id, "2026-03-01T00:00:00Z", ctx))).phase).toBe("PendingIssuance");
      expect(await run(api.rightsAt(id, "2026-03-01T00:00:00Z", ctx))).toHaveLength(0);
      const grants = await call(ep + "Entitlement.list.byHolderScope", { params: { holder: f.customer.id, scope: f.scope.id } });
      expect(grants.items).toHaveLength(1);
      await run(api.issue(id, { ...ctx, actor: "other-authorized-issuer", requestId: "resume" }));
      expect((await call(ep + "Entitlement.list.byHolderScope", { params: { holder: f.customer.id, scope: f.scope.id } })).items).toHaveLength(1);
      expect(await run(api.rightsAt(id, "2026-03-01T00:00:00Z", ctx))).toHaveLength(1);
      expect((await run(api.state(id, "2025-12-01T00:00:00Z", ctx))).phase).toBe("NotAccepted");
    } finally { await f.close(); }
  });

}

it("memory: concurrent issuance receipt misses cannot duplicate raw entitlement grants",async()=>{
 const f=await setup("memory");try{
  const agreement=await run(f.api.accept(f.input,f.ctx));
  const guarded=new Engine(f.engine.model,f.engine.layer);
  guarded.gatekeeper.authorizer=localAuthorizer({policies:f.engine.model.resources.map(r=>({id:r.id,actions:[r.id+(r.id===ep+"Entitlement"?".get":".*")],requires:[],where:[]})),pips:[],epoch:1,knownObligations:[]});
  await expect(run(new AgreementCatalog(guarded).issue(String(agreement.id),f.ctx))).rejects.toThrow();
  const storage=await run(Effect.gen(function*(){return yield* Storage;}).pipe(Effect.provide(f.engine.layer)));
  const getReceipt=storage.getReceipt.bind(storage);let arrivals=0,release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
  storage.getReceipt=(tenant,operation,key)=>operation===ep+"Entitlement.create"&&key.endsWith(":grant")?Effect.gen(function*(){const receipt=yield* getReceipt(tenant,operation,key);if(++arrivals===2)release();yield* Effect.promise(()=>barrier);return receipt;}):getReceipt(tenant,operation,key);
  try{await Promise.allSettled([run(f.api.issue(String(agreement.id),f.ctx)),run(f.api.issue(String(agreement.id),f.ctx))]);}finally{storage.getReceipt=getReceipt;}
  const grants=await f.call(ep+"Entitlement.list.byHolderScope",{params:{holder:f.customer.id,scope:f.scope.id}});expect(grants.items).toHaveLength(1);
 }finally{await f.close();}
});
