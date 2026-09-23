import { Effect } from "effect";
import { expect, it } from "vitest";
import { Decisions, type DecisionRule } from "../src/foundation/decision.js";
import { Participations } from "../src/foundation/participation.js";
import { consumerFixture, foundationAdapters } from "./foundation-fixture.js";
import { Engine } from "../src/engine.js";
import { localAuthorizer } from "../src/gatekeeper.js";
const p = "@forgegraph/foundation/decision/_/", pp = "@forgegraph/foundation/participation/_/";
const ctx = { tenant: "acme", actor: "chair", requestId: "decision" };
const run = Effect.runPromise;
async function fixture(adapter: string) {
  const f = await consumerFixture("decision", adapter), engine = f.engine;
  const memberships = new Participations(engine, { namespace: "review", roles: ["voter"] });
  const set = await run(engine.call(pp + "ParticipationSet.create", { label: "Board" }, ctx));
  await run(memberships.registerRole("voter", ctx));
  const voters: string[] = [];
  for (let i = 0; i < 3; i++) {
    const party = await run(engine.call("@forgegraph/foundation/party/_/Party.create", { label: `Voter ${i}` }, ctx));
    const member = await run(memberships.add({ participationSet: String(set.id), participant: String(party.id), role: "voter", validFrom: "2025-01-01T00:00:00Z", reason: "Appointed" }, ctx));
    voters.push(String(member.id));
  }
  const decisions = new Decisions(engine);
  const open = (rule: DecisionRule, count = 3, threshold = 1) => run(decisions.open({ participationSet: String(set.id), electors: voters.slice(0, count), eligibilityAt: "2026-01-01T00:00:00Z", deadline: "2027-01-01T00:00:00Z", options: ["Accept", "Reject"], rule, threshold }, ctx));
  return { ...f, decisions, voters, open, memberships, set };
}
for (const adapter of foundationAdapters) {
  it(`${adapter}: six pinned rules and immutable outcomes`, async () => {
    const f = await fixture(adapter);
    try {
      for (const rule of ["Single", "ChooseOne", "First", "Quorum", "Unanimous", "Ranked"] as const) {
        const count = rule === "Single" || rule === "ChooseOne" ? 1 : 3;
        const threshold = rule === "Unanimous" ? 3 : rule === "Quorum" || rule === "Ranked" ? 2 : 1;
        const record = await f.open(rule, count, threshold), id = String(record.id);
        await expect(run(f.decisions.finalize(id, ctx))).rejects.toThrow();
        for (let i = 0; i < threshold; i++) await run(f.decisions.respond(id, f.voters[i]!, rule === "Ranked" ? (i ? [1, 0] : [0, 1]) : [0], ctx));
        const outcome = await run(f.decisions.finalize(id, ctx));
        const state = await run(f.decisions.state(id, ctx));
        expect(state.outcome?.id).toBe(outcome.id);
        expect(state.options[0]?.id).toBe(outcome.selected);
        await expect(run(f.decisions.respond(id, f.voters[0]!, [1], ctx))).rejects.toThrow();
        await expect(run(f.engine.call(p + "DecisionOutcome.delete", { id: outcome.id }, ctx))).rejects.toThrow();
        await expect(run(f.decisions.state(id, { ...ctx, tenant: "other" }))).rejects.toThrow();
      }
    } finally { await f.close(); }
  });
  it(`${adapter}: journal serializes finalize versus withdrawal and rejects raw forks`, async () => {
    const f = await fixture(adapter);
    try {
      const record = await f.open("Quorum", 3, 2), id = String(record.id);
      await run(f.decisions.respond(id, f.voters[0]!, [0], ctx));
      await run(f.decisions.respond(id, f.voters[1]!, [1], ctx));
      const before = await run(f.decisions.state(id, ctx));
      const results = await Promise.allSettled([run(f.decisions.finalize(id, ctx)), run(f.decisions.withdraw(id, String(before.responses[0]!.id), ctx))]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      const state = await run(f.decisions.state(id, ctx));
      expect(state.events).toHaveLength(3);
      if (!state.terminal) await expect(run(f.decisions.finalize(id, ctx))).rejects.toThrow();
      await expect(run(f.engine.call(p + "DecisionEvent.create", { decisionCase: id, ordinal: 2, previous: before.events[1]!.id, kind: "Withdrawn", response: before.responses[1]!.id, outcome: null, recordedBy: ctx.actor }, ctx))).rejects.toThrow();
      await expect(run(f.engine.call(p + "DecisionEvent.create", { decisionCase: id, ordinal: 9, previous: state.events.at(-1)!.id, kind: "Withdrawn", response: before.responses[1]!.id, outcome: null, recordedBy: ctx.actor }, ctx))).rejects.toThrow();
    } finally { await f.close(); }
  });
  it(`${adapter}: duplicates, eligibility snapshots and denied journal reads fail closed`, async () => {
    const f = await fixture(adapter);
    try {
      const record = await f.open("First"), id = String(record.id);
      await run(f.memberships.revoke(f.voters[0]!, "2025-12-31T00:00:00Z", "Backdated", ctx));
      const responses = await Promise.allSettled([run(f.decisions.respond(id, f.voters[0]!, [0], ctx)), run(f.decisions.respond(id, f.voters[0]!, [0], ctx))]);
      expect(responses.filter(r => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
      const successful = responses.filter(r => r.status === "fulfilled");
      expect(new Set(successful.map(r => r.value.id)).size).toBe(1);
      expect((await run(f.decisions.state(id, ctx))).responses).toHaveLength(1);
      await expect(f.open("First")).rejects.toThrow();
      const guarded = new Engine(f.engine.model, f.engine.layer);
      guarded.gatekeeper.authorizer = localAuthorizer({ policies: f.engine.model.resources.map(r => r.name).filter(name => name !== p + "DecisionEvent").map(name => ({ id: name, actions: [name + ".*"], requires: [], where: [] })), pips: [], epoch: 1, knownObligations: [] });
      await expect(run(new Decisions(guarded).state(id, ctx))).rejects.toThrow();
      await expect(run(f.decisions.expire(id, ctx))).rejects.toThrow();
    } finally { await f.close(); }
  });
  it(`${adapter}: expiry, reconsideration, support and typed applications`, async () => {
    const f = await fixture(adapter);
    try {
      const bundle = await run(f.engine.call("@forgegraph/foundation/evidence/_/EvidenceBundle.create", { key: "reasons", label: "Reasons" }, ctx));
      const { Evidence } = await import("../src/foundation/evidence.js");
      const seal = await run(new Evidence(f.engine).seal(String(bundle.id), null, ctx));
      const input = { participationSet: String(f.set.id), electors: [f.voters[0]!], eligibilityAt: "2026-01-01T00:00:00Z", deadline: "2027-01-01T00:00:00Z", options: ["Yes", "No"], rule: "Single" as const, support: String(seal.id) };
      const record = await run(f.decisions.open(input, { ...ctx, idempotencyKey: "opening" }));
      expect((await run(f.decisions.open(input, { ...ctx, idempotencyKey: "opening" }))).id).toBe(record.id);
      await expect(run(f.decisions.open({ ...input, options: ["Changed", "No"] }, { ...ctx, idempotencyKey: "opening" }))).rejects.toThrow();
      const id = String(record.id);
      await run(f.decisions.respond(id, f.voters[0]!, [0], ctx, String(seal.id)));
      f.engine.testClockJump(366 * 24 * 60 * 60 * 1000);
      const attempts = await Promise.allSettled([run(f.decisions.finalize(id, ctx)), run(f.decisions.expire(id, ctx))]);
      expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect((await run(f.decisions.state(id, ctx))).terminal?.kind).toBe("Expired");
      const successor = await run(f.decisions.open({ ...input, deadline: "2029-01-01T00:00:00Z", reconsideration: id }, ctx));
      expect(successor.reconsideration).toBe(id);
      for (const [name, field] of [["HumanApproval", "subject"], ["ReleaseGate", "releaseKey"], ["ReviewBoardDecision", "reviewKey"]]) {
        const satellite = await run(f.engine.call(`@example/decision/_/${name}.create`, { [field!]: "Example", decisionCase: successor.id }, ctx));
        expect(satellite.decisionCase).toBe(successor.id);
      }
    } finally { await f.close(); }
  });

  it(`${adapter}: malformed raw terminal candidates fail closed and denied writes stay denied`, async () => {
    const f = await fixture(adapter);
    try {
      const record = await f.open("Single", 1), id = String(record.id);
      const blocked = new Engine(f.engine.model, f.engine.layer);
      blocked.gatekeeper.authorizer = localAuthorizer({ policies: f.engine.model.resources.map(r => ({ id: r.name, actions: [r.name + ".get"], requires: [], where: [] })), pips: [], epoch: 1, knownObligations: [] });
      await expect(run(new Decisions(blocked).respond(id, f.voters[0]!, [0], ctx))).rejects.toThrow();
      expect((await run(f.decisions.state(id, ctx))).events).toHaveLength(0);
      await run(f.decisions.respond(id, f.voters[0]!, [0], ctx));
      const before = await run(f.decisions.state(id, ctx));
      const member = await run(f.engine.call(p + "DecisionOutcomeMember.create", { response: before.responses[0]!.id, next: null, depth: 1 }, ctx));
      const outcome = await run(f.engine.call(p + "DecisionOutcome.create", { decisionCase: id, selected: before.options[1]!.id, responses: member.id, snapshotDigest: "0".repeat(64) }, ctx));
      expect((await run(f.decisions.state(id, ctx))).outcome).toBeNull();
      const terminal = await run(f.engine.call(p + "DecisionEvent.create", { decisionCase: id, ordinal: 1, previous: before.events[0]!.id, kind: "Finalized", response: null, outcome: outcome.id, recordedBy: ctx.actor }, ctx));
      await expect(run(f.decisions.state(id, ctx))).rejects.toMatchObject({ detail: "Outcome does not match rule result" });
      await expect(run(f.engine.call(p + "DecisionEvent.create", { decisionCase: id, ordinal: 2, previous: terminal.id, kind: "Withdrawn", response: before.responses[0]!.id, outcome: null, recordedBy: ctx.actor }, ctx))).rejects.toThrow();
    } finally { await f.close(); }
  });

}
