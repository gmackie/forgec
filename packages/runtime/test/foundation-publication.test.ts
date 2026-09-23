import { Effect } from "effect";
import { expect, it } from "vitest";
import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { Publications, type QualificationPolicy } from "../src/foundation/publication.js";
import { Artifacts } from "../src/foundation/artifact.js";
import { Decisions } from "../src/foundation/decision.js";
import { Participations } from "../src/foundation/participation.js";
import { Evaluations } from "../src/foundation/evaluation.js";
import { Engine } from "../src/engine.js";
import { localAuthorizer } from "../src/gatekeeper.js";
const p = "@forgegraph/foundation/publication/_/", sp = "@forgegraph/foundation/specification/_/", ap = "@forgegraph/foundation/artifact/_/", ep = "@forgegraph/foundation/evaluation/_/", pp = "@forgegraph/foundation/participation/_/";
const run = Effect.runPromise;
async function setup(adapter: string) {
  const f = await foundation("publication", adapter, true), { engine, call, ctx } = f;
  const api = new Publications(engine), decisions = new Decisions(engine), evaluations = new Evaluations(engine);
  const repository = await call(sp + "Repository.create", { key: "releases", provider: "git", locator: "https://example.test/releases" });
  const pin = await call(sp + "SpecificationPin.create", { repository: repository.id, anchor: "release", revision: "a".repeat(40) });
  const artifact = await call(ap + "Artifact.create", { key: "release", label: "Release" });
  const content = await call(ap + "ArtifactContent.create", {});
  const upload = await call(ap + "ArtifactContent.beginUpload", { id: content.id, expectedVersion: 1, mediaType: "text/plain", byteCount: 4 });
  await f.objects.simulateUpload((upload.upload as { url: string }).url, new TextEncoder().encode("body"), "text/plain");
  const sealed = await call(ap + "ArtifactContent.finalizeUpload", { id: content.id, expectedVersion: 2 });
  const revision = await run(new Artifacts(engine).publish({ artifact: String(artifact.id), content: String(content.id), digest: String(sealed.digest), specificationPin: String(pin.id) }, ctx));
  const series = await call(p + "PublicationSeries.create", { key: "product", label: "Product" });
  const audience = await call(pp + "ParticipationSet.create", { label: "Audience" });
  const channel = await call(p + "PublicationChannel.create", { series: series.id, name: "stable", audience: audience.id });
  const preview = await call(p + "PublicationChannel.create", { series: series.id, name: "preview", audience: audience.id });
  const party = await call("@forgegraph/foundation/party/_/Party.create", { label: "Approver" });
  const memberships = new Participations(engine, { namespace: "releases", roles: ["reviewer"] });
  await run(memberships.registerRole("reviewer", ctx));
  const member = await run(memberships.add({ participationSet: String(audience.id), participant: String(party.id), role: "reviewer", validFrom: "2025-01-01T00:00:00Z", reason: "Assigned" }, ctx));
  const evaluationSet = await call(ep + "EvaluationSet.create", { label: "Release tests" }), executor = await call(ep + "EvaluationExecutor.create", { key: "ci", label: "CI" });
  let version = 0;
  async function candidate(policy: QualificationPolicy, passed = true) {
    const needsDecision = policy === "DecisionApproved" || policy === "Both", needsEvaluation = policy === "EvaluationCompleted" || policy === "Both";
    const decision = needsDecision ? await run(decisions.open({ participationSet: String(audience.id), electors: [String(member.id)], eligibilityAt: "2026-01-01T00:00:00Z", rule: "Single", options: ["Approve", "Reject"], deadline: "2027-01-01T00:00:00Z" }, ctx)) : null;
    const approvedOption = decision ? (await run(decisions.state(String(decision.id), ctx))).options[0]!.id : null;
    const row = await run(api.register({ series: String(series.id), version: String(++version), specification: String(pin.id), artifact: String(revision.id), policy, ...(needsEvaluation ? { evaluationDefinition: String(pin.id) } : {}), ...(decision ? { decisionCase: String(decision.id), approvedOption: String(approvedOption) } : {}) }, ctx));
    let evaluation: string | undefined, outcome: string | undefined;
    if (needsEvaluation) {
      const execution = await run(evaluations.create({ evaluationSet: String(evaluationSet.id), definition: String(pin.id), executor: String(executor.id) }, ctx));
      await run(api.attachEvaluation(String(row.id), String(execution.id), ctx));
      await run(evaluations.start(String(execution.id), "2026-01-02T00:00:00Z", ctx));
      evaluation = String((await run(evaluations.finish(String(execution.id), passed ? "Completed" : "Failed", "2026-01-03T00:00:00Z", "Run", ctx))).id);
    }
    if (decision) {
      await run(decisions.respond(String(decision.id), String(member.id), [passed ? 0 : 1], ctx));
      outcome = String((await run(decisions.finalize(String(decision.id), ctx))).id);
    }
    return { row, gates: { ...(evaluation ? { evaluation } : {}), ...(outcome ? { decision: outcome } : {}) } };
  }
  return { ...f, api, series, channel, preview, pin, revision, candidate };
}
for (const adapter of foundationAdapters) {
  it(`${adapter}: all qualification policies, exact release pins and four domain satellites`, async () => {
    const f = await setup(adapter), { api, ctx, call } = f;
    try {
      let release;
      for (const policy of ["None", "EvaluationCompleted", "DecisionApproved", "Both"] as const) {
        const c = await f.candidate(policy);
        await run(api.qualify(String(c.row.id), c.gates, ctx));
        expect(await run(api.candidatePhase(String(c.row.id), ctx))).toBe("Qualified");
        release = await run(api.publish(String(c.row.id), String(f.channel.id), { ...ctx, idempotencyKey: `publish-${policy}` }));
        expect((await run(api.publish(String(c.row.id), String(f.channel.id), { ...ctx, idempotencyKey: `publish-${policy}` }))).id).toBe(release.id);
        expect(release.specification).toBe(f.pin.id); expect(release.artifact).toBe(f.revision.id);
        expect((await run(api.channel(String(f.channel.id), ctx))).release?.id).toBe(release.id);
      }
      for (const [name, field] of [["SoftwareRelease", "version"], ["ModelRelease", "modelRevision"], ["RecipePublication", "recipeCode"], ["DocumentPublication", "documentCode"]]) expect(await call(`@fixture/publication-consumer/_/${name}.create`, { [field!]: "example", release: release!.id })).toMatchObject({ release: release!.id });
      const state = await run(api.state(String(f.series.id), ctx));
      expect(state.events).toHaveLength(4);
      const audience = await run(api.audience(String(state.events[0]!.id), ctx));
      expect(audience.release).toBe(state.events[0]!.release);
      await expect(call(p + "Release.delete", { id: release!.id })).rejects.toThrow();
      await expect(run(api.release(String(release!.id), { ...ctx, tenant: "other" }))).rejects.toThrow();
    } finally { await f.close(); }
  });
  it(`${adapter}: failed gates reject publication and promotion races preserve the journal`, async () => {
    const f = await setup(adapter), { api, ctx, call } = f;
    try {
      for (const policy of ["EvaluationCompleted", "DecisionApproved", "Both"] as const) {
        const failed = await f.candidate(policy, false);
        await expect(run(api.qualify(String(failed.row.id), failed.gates, ctx))).rejects.toThrow();
        expect(await run(api.candidatePhase(String(failed.row.id), ctx))).toBe("Rejected");
        await expect(run(api.publish(String(failed.row.id), String(f.channel.id), ctx))).rejects.toThrow();
      }
      const c = await f.candidate("None"); await run(api.qualify(String(c.row.id), {}, ctx));
      const release = await run(api.publish(String(c.row.id), String(f.channel.id), ctx));
      const races = await Promise.allSettled([run(api.promote(String(release.id), String(f.preview.id), "Preview", ctx)), run(api.transition(String(release.id), "Retired", "Withdrawn", ctx))]);
      expect(races.some(r => r.status === "fulfilled")).toBe(true);
      const state = await run(api.state(String(f.series.id), ctx));
      expect(state.events.map(e => e.ordinal)).toEqual(state.events.map((_, i) => i));
      const status = await run(api.release(String(release.id), ctx));
      if (status!.status !== "Retired") await run(api.transition(String(release.id), "Retired", "Withdrawn", ctx));
      expect((await run(api.channel(String(f.channel.id), ctx))).release).toBeNull();
      await expect(run(api.promote(String(release.id), String(f.channel.id), "Too late", ctx))).rejects.toThrow();
      await expect(call(p + "Promotion.create", { series: f.series.id, ordinal: 9, previous: null, kind: "Retired", release: release.id, channel: null, reason: "Bad root", recordedBy: ctx.actor })).rejects.toThrow();
    } finally { await f.close(); }
  });
  it(`${adapter}: deprecation history, hidden journal and denied writes fail closed`, async () => {
    const f = await setup(adapter), { api, ctx, engine } = f;
    try {
      const c = await f.candidate("None"); await run(api.qualify(String(c.row.id), {}, ctx));
      const release = await run(api.publish(String(c.row.id), String(f.channel.id), ctx));
      await run(api.transition(String(release.id), "Deprecated", "Superseded", ctx));
      expect((await run(api.channel(String(f.channel.id), ctx))).status).toBe("Deprecated");
      await expect(run(api.promote(String(release.id), String(f.preview.id), "No", ctx))).rejects.toThrow();
      const guarded = new Engine(engine.model, engine.layer);
      guarded.gatekeeper.authorizer = localAuthorizer({ policies: engine.model.resources.filter(r => r.id !== p + "Promotion").map(r => ({ id: r.id, actions: [r.id + ".*"], requires: [], where: [] })), pips: [], epoch: 1, knownObligations: [] });
      await expect(run(new Publications(guarded).channel(String(f.channel.id), ctx))).rejects.toThrow();
      guarded.gatekeeper.authorizer = localAuthorizer({ policies: engine.model.resources.map(r => ({ id: r.id, actions: [r.id + ".get"], requires: [], where: [] })), pips: [], epoch: 2, knownObligations: [] });
      await expect(run(new Publications(guarded).transition(String(release.id), "Retired", "Denied", ctx))).rejects.toThrow();
      expect((await run(api.release(String(release.id), ctx)))!.status).toBe("Deprecated");
    } finally { await f.close(); }
  });
}
