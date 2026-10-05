import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { Knowledge } from "../src/foundation/knowledge.js";
import { Publications } from "../src/foundation/publication.js";
import { Artifacts } from "../src/foundation/artifact.js";
import { Participations } from "../src/foundation/participation.js";
import { Entitlements } from "../src/foundation/entitlement.js";
import { Evaluations } from "../src/foundation/evaluation.js";
import { Engine } from "../src/engine.js";
import { localAuthorizer } from "../src/gatekeeper.js";
const p = "@forgegraph/foundation/knowledge/_/", cp = "@forgegraph/foundation/classification/_/", ip = "@forgegraph/foundation/identifiers/_/", sp = "@forgegraph/foundation/specification/_/", ap = "@forgegraph/foundation/artifact/_/", pub = "@forgegraph/foundation/publication/_/", ep = "@forgegraph/foundation/entitlement/_/", pp = "@forgegraph/foundation/participation/_/", ev = "@forgegraph/foundation/evaluation/_/";
const run = Effect.runPromise;
async function setup(adapter: string) {
  const f = await foundation("knowledge", adapter, true), { engine, ctx, call } = f;
  const api = new Knowledge(engine), publications = new Publications(engine), entitlements = new Entitlements(engine), evaluations = new Evaluations(engine);
  const repository = await call(sp + "Repository.create", { key: "knowledge", provider: "git", locator: "https://example.test/knowledge" });
  const pin = await call(sp + "SpecificationPin.create", { repository: repository.id, anchor: "edition", revision: "a".repeat(40) });
  const artifact = await call(ap + "Artifact.create", { key: "article", label: "Article" }), content = await call(ap + "ArtifactContent.create", {});
  const upload = await call(ap + "ArtifactContent.beginUpload", { id: content.id, expectedVersion: 1, mediaType: "text/plain", byteCount: 7 });
  await f.objects.simulateUpload((upload.upload as { url: string }).url, new TextEncoder().encode("Article"), "text/plain");
  const sealed = await call(ap + "ArtifactContent.finalizeUpload", { id: content.id, expectedVersion: 2 });
  const artifactRevision = await run(new Artifacts(engine).publish({ artifact: String(artifact.id), content: String(content.id), digest: String(sealed.digest), specificationPin: String(pin.id) }, ctx));
  await call(ap + "admin.inspect", { resource: ap + "ArtifactContent", id: content.id, digest: sealed.digest, verdict: "allowed", detector: "test" });
  const taxonomyIdentifiers = await call(ip + "IdentifierSet.create", { label: "Taxonomy" }), conceptIdentifiers = await call(ip + "IdentifierSet.create", { label: "Concept" });
  const taxonomy = await call(cp + "Taxonomy.create", { key: "topics", identifiers: taxonomyIdentifiers.id });
  const concept = await call(cp + "Concept.create", { taxonomy: taxonomy.id, ordinal: 1, identifiers: conceptIdentifiers.id, parent: null });
  const meaning = await call(cp + "ConceptRevision.create", { concept: concept.id, taxonomy: taxonomy.id, ordinal: 1, revision: 1, label: "Safety", definition: "Safety guidance" });
  const classifications = await call(cp + "ClassificationSet.create", { label: "Article topics" });
  const assignment = await call(cp + "ClassificationAssignment.create", { classifications: classifications.id, meaning: meaning.id, recordedAt: "2025-01-01T00:00:00Z" });
  const scope = await call(ep + "EntitlementScope.create", { label: "Knowledge library" }), right = await call(ep + "RightDefinition.create", { namespace: "knowledge", name: "read" });
  const item = await call(p + "KnowledgeItem.create", { key: "article", title: "Safety article", accessRight: right.id, scope: scope.id });
  const revisionInput = { item: String(item.id), specification: String(pin.id), content: String(artifactRevision.id), classifications: [String(assignment.id)], assessmentDefinition: String(pin.id) };
  const revision = await run(api.createRevision(revisionInput, ctx));
  const series = await call(pub + "PublicationSeries.create", { key: "articles", label: "Articles" }), audience = await call(pp + "ParticipationSet.create", { label: "Readers" });
  const channel = await call(pub + "PublicationChannel.create", { series: series.id, name: "current", audience: audience.id });
  const candidate = await run(publications.register({ series: String(series.id), version: "1", specification: String(pin.id), artifact: String(artifactRevision.id), policy: "None" }, ctx));
  await run(publications.qualify(String(candidate.id), {}, ctx));
  const release = await run(publications.publish(String(candidate.id), String(channel.id), ctx));
  const promotion = (await run(publications.state(String(series.id), ctx))).events[0]!;
  const audienceLink = await run(publications.audience(String(promotion.id), ctx));
  const edition = await run(api.publish(String(revision.id), String(audienceLink.id), ctx));
  const party = await call("@forgegraph/foundation/party/_/Party.create", { label: "Reader" });
  const memberships = new Participations(engine, { namespace: "knowledge", roles: ["reader"] });
  await run(memberships.registerRole("reader", ctx));
  const member = await run(memberships.add({ participationSet: String(audience.id), participant: String(party.id), role: "reader", validFrom: "2025-01-01T00:00:00Z", reason: "Invited" }, ctx));
  const grant = await run(entitlements.issue({ holder: String(party.id), right: String(right.id), scope: String(scope.id), validFrom: "2025-01-01T00:00:00Z", validUntil: "2027-01-01T00:00:00Z", reason: "Subscription" }, ctx));
  const access = { entitlement: String(grant.id), participation: String(member.id) };
  const evaluationSet = await call(ev + "EvaluationSet.create", { label: "Reader feedback" }), executor = await call(ev + "EvaluationExecutor.create", { key: "assessment", label: "Assessment" });
  const execution = () => run(evaluations.create({ evaluationSet: String(evaluationSet.id), definition: String(pin.id), executor: String(executor.id) }, ctx));
  return { ...f, api, publications, entitlements, evaluations, memberships, access, revision, revisionInput, edition, meaning, concept, taxonomy, assignment, classifications, release, execution, audienceLink };
}
for (const adapter of foundationAdapters) {
  it(`${adapter}: ambiguous or legacy timestamps cannot establish authority ordering`, async () => {
    for (const timestamp of ["2026-01-01T00:00:00.000Z", undefined, "invalid"]) {
      const f = await setup(adapter);
      try {
        const execution = await f.execution(); const feedback = await run(f.api.feedback(String(f.edition.id), String(execution.id), f.ctx)); await run(f.evaluations.start(String(execution.id), "2026-01-02T00:00:00Z", f.ctx)); const finish = await run(f.evaluations.finish(String(execution.id), "Completed", "2026-01-03T00:00:00Z", "Assessment", f.ctx));
        const original = f.engine.call.bind(f.engine);
        const spy = vi.spyOn(f.engine, "call").mockImplementation((op, input, context) => original(op, input, context).pipe(Effect.map(row => op.endsWith(".get") && Object.hasOwn(row, "createdAt") ? {...row, createdAt: timestamp} : row)));
        try { await expect(run(f.api.finishFeedback(String(feedback.id), String(finish.id), f.ctx))).rejects.toMatchObject({detail: 'Feedback execution predates its edition binding'}); }
        finally { spy.mockRestore(); }
      } finally { await f.close(); }
    }
  });

  it(`${adapter}: future execution dates cannot authorize post-hoc feedback binding`,async()=>{
    const f=await setup(adapter);try{
      const execution=await f.execution();await run(f.evaluations.start(String(execution.id),"2026-12-01T00:00:00Z",f.ctx));
      const finish=await run(f.evaluations.finish(String(execution.id),"Completed","2026-12-02T00:00:00Z","Old execution",f.ctx));
      const feedback=await f.call(p+"KnowledgeFeedback.create",{edition:f.edition.id,revision:f.revision.id,run:execution.id});
      await expect(run(f.api.finishFeedback(String(feedback.id),String(finish.id),f.ctx))).rejects.toMatchObject({code:"ValidationFailed"});
    }finally{await f.close();}
  });

  it(`${adapter}: exact editions, taxonomy history, authorized download and three domain wrappers`, async () => {
    const f = await setup(adapter), { api, ctx, call } = f;
    try {
      const result = await run(api.resolve(String(f.edition.id), f.access, ctx));
      expect(result.revision.id).toBe(f.revision.id); expect(result.meanings[0]!.id).toBe(f.meaning.id);
      const download = await run(api.download(String(f.edition.id), f.access, ctx));
      expect(new TextDecoder().decode(await f.objects.simulateDownload(String(download.url)))).toBe("Article");
      const changed = await call(cp + "ConceptRevision.create", { concept: f.concept.id, taxonomy: f.taxonomy.id, ordinal: 1, revision: 2, previous: f.meaning.id, label: "Changed safety", definition: "New meaning" });
      const newAssignment = await call(cp + "ClassificationAssignment.create", { classifications: f.classifications.id, meaning: changed.id, recordedAt: "2026-01-01T00:00:00Z" });
      await call(cp + "ClassificationRetraction.create", { assignment: f.assignment.id, effectiveAt: "2026-01-01T00:00:00Z", reason: "New meaning" });
      expect((await run(api.history(String(f.edition.id), ctx))).meanings[0]!.id).toBe(f.meaning.id);
      const successors = await Promise.allSettled([run(api.createRevision({ ...f.revisionInput, classifications: [String(newAssignment.id)], previous: String(f.revision.id) }, ctx)), run(api.createRevision({ ...f.revisionInput, classifications: [String(newAssignment.id)], previous: String(f.revision.id) }, ctx))]);
      expect(successors.filter(s => s.status === "fulfilled")).toHaveLength(1);
      for (const [name, field] of [["SupportArticle", "product"], ["StandardOperatingProcedure", "procedureCode"], ["TrainingMaterial", "courseCode"]]) expect(await call(`@fixture/knowledge-consumer/_/${name}.create`, { [field!]: "example", edition: f.edition.id })).toMatchObject({ edition: f.edition.id });
      await expect(call(p + "KnowledgeRevision.delete", { id: f.revision.id })).rejects.toThrow();
      await expect(run(api.resolve(String(f.edition.id), f.access, { ...ctx, tenant: "other" }))).rejects.toThrow();
    } finally { await f.close(); }
  });
  it(`${adapter}: revoked rights, audience denial and retirement preserve history`, async () => {
    const f = await setup(adapter), { api, ctx, engine } = f;
    try {
      await run(f.entitlements.revoke(f.access.entitlement, "2026-01-01T00:00:00Z", "Withdrawn", ctx));
      await expect(run(api.resolve(String(f.edition.id), f.access, ctx))).rejects.toMatchObject({ detail: "Knowledge access entitlement is absent, expired or revoked" });
      const guarded = new Engine(engine.model, engine.layer);
      guarded.gatekeeper.authorizer = localAuthorizer({ policies: engine.model.resources.filter(r => r.id !== ep + "EntitlementEnd").map(r => ({ id: r.id, actions: [r.id + ".*"], requires: [], where: [] })), pips: [], epoch: 1, knownObligations: [] });
      await expect(run(new Knowledge(guarded).resolve(String(f.edition.id), f.access, ctx))).rejects.toMatchObject({ code: "NotFound" });
      await run(f.publications.transition(String(f.release.id), "Retired", "Replaced", ctx));
      expect((await run(api.history(String(f.edition.id), ctx))).status).toBe("Retired");
      guarded.gatekeeper.authorizer = localAuthorizer({ policies: engine.model.resources.map(r => ({ id: r.id, actions: [r.id + ".get"], requires: [], where: [] })), pips: [], epoch: 2, knownObligations: [] });
      await expect(run(new Knowledge(guarded).createRevision({ ...f.revisionInput, previous: String(f.revision.id) }, ctx))).rejects.toThrow();
      await expect(run(api.resolve(String(f.edition.id), f.access, ctx))).rejects.toMatchObject({ detail: "Knowledge edition is not available" });
      await expect(run(api.publish(String(f.revision.id), String(f.audienceLink.id), ctx))).rejects.toThrow();
    } finally { await f.close(); }
  });
  it(`${adapter}: feedback is bound to the exact edition and independent audience membership is required`, async () => {
    const f = await setup(adapter), { api, ctx, call } = f;
    try {
      const execution = await f.execution(), otherExecution = await f.execution();
      const feedback = await run(api.feedback(String(f.edition.id), String(execution.id), ctx));
      for (const entry of [execution, otherExecution]) await run(f.evaluations.start(String(entry.id), "2026-01-02T00:00:00Z", ctx));
      const finish = await run(f.evaluations.finish(String(execution.id), "Completed", "2026-01-03T00:00:00Z", "Reader assessment", ctx));
      const otherFinish = await run(f.evaluations.finish(String(otherExecution.id), "Completed", "2026-01-03T00:00:00Z", "Unrelated", ctx));
      await expect(run(api.finishFeedback(String(feedback.id), String(otherFinish.id), ctx))).rejects.toThrow();
      expect((await run(api.finishFeedback(String(feedback.id), String(finish.id), ctx))).finish).toBe(finish.id);
      expect((await call(p + "KnowledgeFeedback.get", { id: feedback.id })).revision).toBe(f.revision.id);
      await run(f.memberships.revoke(f.access.participation, "2026-01-01T00:00:00Z", "Audience ended", ctx));
      await expect(run(api.resolve(String(f.edition.id), f.access, ctx))).rejects.toMatchObject({ detail: "Knowledge audience membership is not effective for the entitlement holder" });
    } finally { await f.close(); }
  });
}
