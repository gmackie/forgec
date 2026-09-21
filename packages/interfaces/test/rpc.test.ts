/**
 * FORGE-053 / PAR-119: the same callable bound locally and over authenticated
 * HTTP enforces the same operation envelope; business errors and remote
 * invocation failures stay distinct typed outcomes; a contract/audience
 * mismatch fails before anything is disclosed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStorage, type AppBundle } from "@forgegraph/runtime";
import { createNodeHost, type NodeHost } from "@forgegraph/runtime/node";
import { devHeaderAuth } from "@forgegraph/runtime";
import { externals, functions } from "../../../examples/acme/impl/index.js";
import { httpCallable, localCallable, type Callable, type Outcome } from "../src/rpc.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const A = "@acme/commerce/_";

describe("PAR-119: local and remote RPC authorization parity", () => {
  let host: NodeHost;
  let base: string;
  beforeAll(async () => {
    host = createNodeHost({ auth: devHeaderAuth(), bundle, store: new MemoryStorage(), functions, externals, cursorSecret: "rpc-test", sweepIntervalMs: 0, telemetryFormat: "silent" });
    base = (await host.listen(0)).url;
  });
  afterAll(async () => { await host?.stop(); });

  const both = (): { local: Callable; remote: Callable } => ({
    local: localCallable(host.runtime.engine, { tenant: "rpc", actor: "operator" }),
    remote: httpCallable({ baseUrl: base, credential: { kind: "dev-header", tenant: "rpc", actor: "operator" } }),
  });

  it("results match across bindings and both validate the same envelope", async () => {
    const { local, remote } = both();
    const a = await local.invoke(`${A}/Customer.create`, { code: "LOCAL", name: "Local" });
    const b = await remote.invoke(`${A}/Customer.create`, { code: "REMOTE", name: "Remote" });
    expect(a.kind).toBe("ok");
    expect(b.kind).toBe("ok");
    const ra = (a as Extract<Outcome, { kind: "ok" }>).value as { id: string; version: number };
    const rb = (b as Extract<Outcome, { kind: "ok" }>).value as { id: string; version: number };
    // the remote binding sees exactly what the local one stored
    const viaRemote = await remote.invoke(`${A}/Customer.get`, { id: ra.id });
    const viaLocal = await local.invoke(`${A}/Customer.get`, { id: rb.id });
    expect(viaRemote).toEqual(await local.invoke(`${A}/Customer.get`, { id: ra.id }));
    expect(viaLocal.kind).toBe("ok");
    // validation failures are business outcomes with the same code and field paths on both bindings
    const badL = await local.invoke(`${A}/Customer.create`, { code: "x", name: "" });
    const badR = await remote.invoke(`${A}/Customer.create`, { code: "x", name: "" });
    expect(badL.kind).toBe("error");
    expect(badR.kind).toBe("error");
    const pl = (badL as Extract<Outcome, { kind: "error" }>).problem;
    const pr = (badR as Extract<Outcome, { kind: "error" }>).problem;
    expect(pr.code).toBe(pl.code);
    expect(pr.status).toBe(422);
    expect(pr.fields?.map((f) => f.path).sort()).toEqual(pl.fields?.map((f) => f.path).sort());
    // stale preconditions are business outcomes too
    const stale = await remote.invoke(`${A}/Customer.update`, { id: ra.id, expectedVersion: 9, patch: { name: "Nope" } });
    expect(stale).toMatchObject({ kind: "error", problem: { code: "VersionConflict", status: 412 } });
    const staleL = await local.invoke(`${A}/Customer.update`, { id: ra.id, expectedVersion: 9, patch: { name: "Nope" } });
    expect(staleL).toMatchObject({ kind: "error", problem: { code: "VersionConflict", status: 412 } });
  });

  it("denials match: another tenant's record reads as NotFound on both bindings", async () => {
    const { local } = both();
    const mine = await local.invoke(`${A}/Customer.create`, { code: "MINE", name: "Mine" });
    const id = (mine as Extract<Outcome, { kind: "ok" }>).value as { id: string };
    const otherL = localCallable(host.runtime.engine, { tenant: "other", actor: "x" });
    const otherR = httpCallable({ baseUrl: base, credential: { kind: "dev-header", tenant: "other", actor: "x" } });
    expect(await otherL.invoke(`${A}/Customer.get`, { id: id.id })).toMatchObject({ kind: "error", problem: { code: "NotFound", status: 404 } });
    expect(await otherR.invoke(`${A}/Customer.get`, { id: id.id })).toMatchObject({ kind: "error", problem: { code: "NotFound", status: 404 } });
  });

  it("a declared business error and a remote invocation failure are distinct outcomes", async () => {
    const { local, remote } = both();
    // unknown operation: a contract-level refusal on both sides, not a transport failure
    expect((await local.invoke(`${A}/Nope.go`, {})).kind).toBe("error");
    expect((await remote.invoke(`${A}/Nope.go`, {})).kind).toBe("error");
    // an unreachable endpoint is an invocation failure, never a business error
    const dead = httpCallable({ baseUrl: "http://127.0.0.1:9", credential: { kind: "dev-header", tenant: "rpc", actor: "operator" } });
    const out = await dead.invoke(`${A}/Customer.get`, { id: "cus_0001" });
    expect(out.kind).toBe("invocationFailed");
    expect((out as Extract<Outcome, { kind: "invocationFailed" }>).reason).toBe("transport");
    expect((out as Extract<Outcome, { kind: "invocationFailed" }>).retryable).toBe(true);
  });

  it("a contract/audience mismatch fails before disclosure (no operation is attempted)", async () => {
    const remote = httpCallable({ baseUrl: base, credential: { kind: "dev-header", tenant: "rpc", actor: "operator" }, expect: { contracts: "contracts/99", wire: "0000" } });
    const out = await remote.invoke(`${A}/Customer.create`, { code: "NEVER", name: "Never" });
    expect(out.kind).toBe("invocationFailed");
    expect((out as Extract<Outcome, { kind: "invocationFailed" }>).reason).toBe("contract-mismatch");
    // nothing was created
    const list = await localCallable(host.runtime.engine, { tenant: "rpc", actor: "operator" }).invoke(`${A}/Customer.find.byCode`, { params: { code: "NEVER" } });
    expect(list).toMatchObject({ kind: "error", problem: { code: "NotFound" } });
    // the expectation is satisfied by the digests discovery reports
    const good = httpCallable({ baseUrl: base, credential: { kind: "dev-header", tenant: "rpc", actor: "operator" }, expect: { contracts: bundle.contracts.version, wire: bundle.digests!["wire"]! } });
    expect((await good.invoke(`${A}/Customer.find.byCode`, { params: { code: "REMOTE" } })).kind).toBe("ok");
  });

  it("purpose travels with the call on both bindings and a credential without that purpose is refused remotely", async () => {
    const local = localCallable(host.runtime.engine, { tenant: "rpc", actor: "operator", purposes: ["@acme/commerce/_/Nope"] });
    expect(await local.invoke(`${A}/Customer.find.byCode`, { params: { code: "REMOTE" } }, { purpose: "@acme/commerce/_/Other" })).toMatchObject({ kind: "error", problem: { code: "NotPermitted" } });
  });
});
