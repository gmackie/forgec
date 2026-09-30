import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { Reachability } from "../src/foundation/reachability.js";
const prefix = "@forgegraph/foundation/reachability/_/";
const consumer = "@foundation-probe/reachability-consumers/_/";
const ctx = { tenant: "acme", actor: "user", requestId: "reachability-consumer" };
const at = "2026-02-01T00:00:00Z", from = "2026-01-01T00:00:00Z";

for (const adapter of foundationAdapters)
  it(`${adapter}: party and non-party owners attach locator sets, and a consumer selects without owning`, async () => {
    const f = await foundation("reachability", adapter, true);
    const engine = f.engine;
    try {
      const call = (op: string, input: Record<string, unknown>, context = ctx) =>
        Effect.runPromise(engine.call(op, input, context));
      const run = Effect.runPromise;
      const service = new Reachability(engine);
      const set = async (label: string) => (await call(prefix + "LocatorSet.create", { label })).id;
      const emailKind = await call(prefix + "LocatorKind.create", { key: "email", label: "Email", personal: true });
      const apiKind = await call(prefix + "LocatorKind.create", { key: "api-url", label: "API", personal: false });
      const support = await call(prefix + "LocatorPurpose.create", { key: "support", label: "Support" });

      // F91-06: a Party-shaped owner, reached by contact points.
      const account = await call(consumer + "CustomerAccount.create", { name: "Ada Lovelace", locators: await set("Ada") });
      const personal = await run(service.declare("ContactPoint", {
        locatorSet: String(account.locators), kind: String(emailKind.id), purpose: String(support.id),
        value: "ada@example.com", preference: 1, validFrom: from,
      }, ctx));

      // F91-06: two owners that are not a Party at all, reached by endpoints.
      const serviceOwner = await call(consumer + "SupportService.create", { name: "Desk", locators: await set("Desk") });
      const device = await call(consumer + "FieldDevice.create", { serial: "DEV-001", locators: await set("Device") });
      const deskEndpoint = await run(service.declare("Endpoint", {
        locatorSet: String(serviceOwner.locators), kind: String(apiKind.id), purpose: String(support.id),
        value: "https://desk.example.com/api", preference: 1, validFrom: from,
      }, ctx));
      await run(service.declare("Endpoint", {
        locatorSet: String(device.locators), kind: String(apiKind.id), purpose: String(support.id),
        value: "https://10.0.0.7/telemetry", preference: 1, validFrom: from,
      }, ctx));

      // A locator set belongs to exactly one owner, so reachability cannot be shared by accident.
      await expect(call(consumer + "SupportService.create", { name: "Duplicate", locators: serviceOwner.locators })).rejects.toThrow();

      // Resolution is per owner: the device's endpoint is not the desk's.
      const deskResolved = await run(service.resolve("Endpoint", {
        locatorSet: String(serviceOwner.locators), kind: String(apiKind.id), purpose: String(support.id),
      }, at, ctx));
      expect(deskResolved?.locator).toBe(deskEndpoint["id"]);
      expect(deskResolved?.value).toBe("https://desk.example.com/api");

      // A person's set holds no endpoints, and a service's holds no contact points.
      expect(await run(service.resolve("Endpoint", {
        locatorSet: String(account.locators), kind: String(apiKind.id), purpose: String(support.id),
      }, at, ctx))).toBeNull();
      expect((await run(service.resolve("ContactPoint", {
        locatorSet: String(account.locators), kind: String(emailKind.id), purpose: String(support.id),
      }, at, ctx)))?.locator).toBe(personal["id"]);

      // The notification-shaped consumer holds a reference and nothing else: it cannot restate
      // the value, the validity or the verification, so it cannot drift from the substrate.
      const route = await call(consumer + "OutboundRoute.create", { service: serviceOwner.id, destination: deskEndpoint["id"] });
      expect(Object.keys(route).sort()).toEqual(["destination", "id", "service"]);
      await expect(call(consumer + "OutboundRoute.create", { service: serviceOwner.id, destination: deskEndpoint["id"] })).rejects.toThrow();
      // Selecting a destination that belongs to a different owner is the caller's business rule,
      // not this package's: the substrate deliberately does not know who may route to whom.
      await expect(call(consumer + "OutboundRoute.create", { service: serviceOwner.id, destination: personal["id"] })).rejects.toThrow();
    } finally {
      await f.close();
    }
  });

/**
 * F91-08, checked structurally rather than asserted in prose: no transport or runtime mechanic
 * may become a reachability fact. A locator says where something can be reached. Whether a
 * message was sent, how many attempts it took, and what the provider answered are Delivery's,
 * and the moment one of those words appears as a field here the boundary has moved.
 */
it("declares no transport or delivery mechanics", () => {
  const bundle = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../../conformance/fixtures/reachability/app.json"),
      "utf8",
    ),
  ) as { contracts: { resources: { name: string; fields?: { name: string }[] }[] } };
  const mechanics = /attempt|retry|backoff|deliver|dispatch|sent|transport|payload|queue|webhookSecret|status/i;
  const offending = bundle.contracts.resources.flatMap((r) =>
    (r.fields ?? []).filter((field) => mechanics.test(field.name)).map((field) => `${r.name}.${field.name}`),
  );
  expect(offending).toEqual([]);
  // And the substrate does define the facts it is supposed to.
  expect(bundle.contracts.resources.map((r) => r.name).sort()).toEqual([
    "ContactPoint", "ContactPointDisposition", "ContactPointVerification",
    "Endpoint", "EndpointDisposition", "EndpointVerification",
    "LocatorKind", "LocatorPurpose", "LocatorSet",
  ]);
});
