import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppBundle } from "@forgegraph/runtime";
import { destroyPlan, resolvePlan } from "../src/deployment-plan.js";
import { emitTerraform } from "../src/terraform.js";
import { emitCloudflareTunnels, type CloudflareTunnelSpec } from "../src/tunnels.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../conformance/fixtures/acme.app.json"), "utf8")) as AppBundle;
const tunnel: CloudflareTunnelSpec = { name: "preview", ownership: "managed", ingress: [{ hostname: "Preview.Example.com", service: "http://localhost:8080" }], connector: { tokenRef: { source: "external-secret-store", path: "forge/preview/token" } } };
const plan = (tunnels: CloudflareTunnelSpec[] = [tunnel]) => resolvePlan(bundle, { target: "cloudflare", stage: "dev", stateOwner: "native", tunnels });

describe("Cloudflare Tunnel primitive", () => {
  it("plans a named resource and projects remote ingress plus a private token-file command", () => {
    const p = plan();
    expect(p.resources.find(r => r.id === "tunnel-preview")).toMatchObject({ kind: "cloudflare_tunnel", ownership: "managed", retain: false, bindings: {} });
    const [projection] = emitCloudflareTunnels(p);
    expect(projection).toMatchObject({ id: "tunnel-preview", create: { name: "forge-acme-commerce-dev-tunnel-preview", config_src: "cloudflare" }, config: { ingress: [{ hostname: "preview.example.com", service: "http://localhost:8080" }, { service: "http_status:404" }] }, connector: { executable: "cloudflared", args: ["tunnel", "--no-autoupdate", "run", "--token-file", "/run/secrets/tunnels/preview.token"], credential: { file: "/run/secrets/tunnels/preview.token", mode: "0600", source: "external-secret-store", path: "forge/preview/token" } } });
    expect(p.secrets.some(s => s.path === "forge/preview/token")).toBe(false);
    expect(emitCloudflareTunnels(plan())).toEqual(emitCloudflareTunnels(p));
  });
  it("retains adopted tunnels and never projects their creation", () => {
    const p = plan([{ ...tunnel, ownership: "adopted", adoptId: "00000000-0000-0000-0000-000000000001" }]);
    expect(emitCloudflareTunnels(p)[0]).toMatchObject({ tunnelId: "00000000-0000-0000-0000-000000000001" });
    expect(emitCloudflareTunnels(p)[0]?.create).toBeUndefined();
    expect(destroyPlan(p).retained.map(r => r.id)).toContain("tunnel-preview");
    expect(destroyPlan(p, { approveDestroy: ["tunnel-preview"] }).destroy).toContain("tunnel-preview");
    expect(destroyPlan(plan([{ ...tunnel, retain: true }])).retained.map(r => r.id)).toContain("tunnel-preview");
  });
  it("reports Terraform's tunnel gap instead of silently omitting it", () => {
    expect(emitTerraform({ ...plan(), stateOwner: "terraform" }).unsupported).toContainEqual({ id: "tunnel-preview", kind: "cloudflare_tunnel", reason: expect.stringMatching(/not implemented/) });
    expect(() => emitCloudflareTunnels({ ...plan(), stateOwner: "terraform" })).toThrow(/state owner/);
  });
  it("preserves plans without tunnels", () => {
    expect(plan([])).toEqual(resolvePlan(bundle, { target: "cloudflare", stage: "dev", stateOwner: "native" }));
    expect(emitCloudflareTunnels(plan([]))).toEqual([]);
  });
  it.each(["aws", "self-hosted"] as const)("rejects tunnels on %s", target => {
    expect(() => resolvePlan(bundle, { target, stage: "dev", stateOwner: "native", tunnels: [tunnel] })).toThrow(/Cloudflare/);
  });
  it("supports HTTPS and IPv6 origins while preserving ingress order", () => {
    const p = plan([{ ...tunnel, ingress: [{ hostname: "secure.example.com", service: "https://internal:8443/" }, { hostname: "v6.example.com", service: "http://[::1]:8080" }] }]);
    expect(emitCloudflareTunnels(p)[0]?.config.ingress).toEqual([{ hostname: "secure.example.com", service: "https://internal:8443" }, { hostname: "v6.example.com", service: "http://[::1]:8080" }, { service: "http_status:404" }]);
  });
  it("rejects two resources adopting the same physical tunnel", () => {
    const adopted = { ...tunnel, ownership: "adopted" as const, adoptId: "00000000-0000-0000-0000-000000000001" };
    expect(() => plan([adopted, { ...adopted, name: "other", ingress: [{ hostname: "other.example.com", service: "http://localhost:8081" }] }])).toThrow(/adoptId/);
  });
  it("copies only credential references and excludes unexpected token values", () => {
    const input = { ...tunnel, connector: { tokenRef: { ...tunnel.connector.tokenRef, token: "private-token-value" }, token: "private-token-value" } };
    expect(JSON.stringify(plan([input]))).not.toContain("private-token-value");
  });
  it("rejects name and hostname collisions", () => {
    expect(() => plan([tunnel, tunnel])).toThrow(/duplicate/);
    expect(() => plan([tunnel, { ...tunnel, name: "other" }])).toThrow(/hostname/);
  });
  it.each(["ssh://localhost", "http://user:secret@localhost", "http://localhost/path", "http://localhost?x=1", "http://localhost/#fragment", "not a url"])("rejects invalid origin %s without echoing it", service => {
    expect(() => plan([{ ...tunnel, ingress: [{ hostname: "preview.example.com", service }] }])).toThrow(/origin/);
    try { plan([{ ...tunnel, ingress: [{ hostname: "preview.example.com", service }] }]); } catch (error) { expect(String(error)).not.toContain(service); }
  });
  it.each(["*.example.com", "example.com:80", "https://example.com", "localhost", "-bad.example.com"])("rejects invalid exact hostname %s", hostname => {
    expect(() => plan([{ ...tunnel, ingress: [{ hostname, service: "http://localhost:8080" }] }])).toThrow(/hostname/);
  });
  it("rejects missing adoption, unsafe names and malformed credential references", () => {
    expect(() => plan([{ ...tunnel, ownership: "adopted" }])).toThrow(/adoptId/);
    expect(() => plan([{ ...tunnel, name: "../preview" }])).toThrow(/name/);
    expect(() => plan([{ ...tunnel, connector: { tokenRef: { source: "external-secret-store", path: "" } } }])).toThrow(/reference/);
    expect(() => plan([{ ...tunnel, ingress: [] }])).toThrow(/ingress/);
  });
});
