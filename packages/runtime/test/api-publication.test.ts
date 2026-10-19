import {describe, expect, it} from "vitest";
import {apiCatalog, apiPublicationDigest, protectedResourceMetadata, resourceMetadataChallenge, serveApiPublication, validateApiPublication, type ApiPublicationProfile} from "../src/api-publication.js";

const makeProfile = (resource = "https://api.example.test/orders"): ApiPublicationProfile => ({
  version: "forge-api-publication/1",
  resource,
  authorizationServers: ["https://login.example.test"],
  scopesSupported: ["orders:read", "orders:write"],
  services: [
    {endpoint: "https://api.example.test/orders", serviceDesc: "https://api.example.test/forge/openapi.json", serviceDoc: "https://docs.example.test/orders", visibility: "public"},
    {endpoint: "https://internal.example.test/admin", serviceDesc: "https://internal.example.test/openapi.json", visibility: "private"},
  ],
  operations: {"acme.Order.list": {visibility: "oauth2", scopes: ["orders:read"]}},
});
const actions = new Set(["acme.Order.list"]);

describe("opt-in RFC 9727/9728 publisher", () => {
  it("exposes only explicitly public API endpoints in a valid Linkset", async () => {
    const profile = validateApiPublication(makeProfile(), actions);
    const catalog = apiCatalog(profile);
    expect(catalog.linkset[0]).toEqual({anchor: "https://api.example.test/.well-known/api-catalog", item: [{href: "https://api.example.test/orders"}]});
    expect(catalog.linkset[1]).toMatchObject({anchor: "https://api.example.test/orders",
      "service-desc": [{href: "https://api.example.test/forge/openapi.json", type: "application/json"}]});
    expect(JSON.stringify(catalog)).not.toContain("internal.example.test");
    const req = new Request("https://api.example.test/.well-known/api-catalog");
    const res = serveApiPublication(req, profile)!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/linkset+json");
    expect(res.headers.get("content-type")).toContain("rfc9727");
    expect(res.headers.get("link")).toContain('rel="api-catalog"');
    expect(await res.json()).toEqual(catalog);
    const head = serveApiPublication(new Request(req.url, {method:"HEAD"}), profile)!;
    expect(head.status).toBe(200);
    expect(head.headers.get("link")).toContain("api-catalog");
    expect(await head.text()).toBe("");
    expect(serveApiPublication(new Request(req.url, {method:"POST"}), profile)?.status).toBe(405);
    expect(serveApiPublication(new Request("https://elsewhere.test/.well-known/api-catalog"), profile)).toBeUndefined();
  });

  it("derives path-specific OAuth resource metadata from the resource identifier", async () => {
    const profile = validateApiPublication(makeProfile(), actions);
    expect(profile.metadataPath).toBe("/.well-known/oauth-protected-resource/orders");
    expect(resourceMetadataChallenge(profile)).toBe('Bearer resource_metadata="https://api.example.test/.well-known/oauth-protected-resource/orders"');
    const metadata = serveApiPublication(new Request("https://api.example.test/.well-known/oauth-protected-resource/orders"), profile)!;
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("content-type")).toBe("application/json");
    expect(await metadata.json()).toEqual({
      resource: "https://api.example.test/orders",
      authorization_servers: ["https://login.example.test"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["orders:read", "orders:write"],
    });
    const originOnly = validateApiPublication(makeProfile("https://api.example.test"), actions);
    expect(originOnly.metadataPath).toBe("/.well-known/oauth-protected-resource");
    expect(protectedResourceMetadata(originOnly).resource).toBe("https://api.example.test");
    expect((await apiPublicationDigest(profile))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects spoofed origins, private-only catalogs, unknown operations, and incorrect OAuth scopes", () => {
    const profile = makeProfile();
    expect(() => validateApiPublication({...profile, resource:"http://api.example.test/orders"}, actions)).toThrow(/HTTPS/);
    expect(() => validateApiPublication({...profile, resource:"https://user:pass@api.example.test/orders"}, actions)).toThrow(/HTTPS/);
    expect(() => validateApiPublication({...profile, authorizationServers:["https://evil.test#fragment"]}, actions)).toThrow(/HTTPS/);
    expect(() => validateApiPublication({...profile, services:profile.services.map(s=>({...s,visibility:"private" as const}))}, actions)).toThrow(/publishable/);
    expect(() => validateApiPublication({...profile, services:[...profile.services,profile.services[0]!] }, actions)).toThrow(/duplicate/);
    expect(() => validateApiPublication({...profile, operations:{"unknown.action":{visibility:"oauth2", scopes:["orders:read"]}}}, actions)).toThrow(/unrecognized/);
    expect(() => validateApiPublication({...profile, operations:{"acme.Order.list":{visibility:"oauth2", scopes:["super-admin"]}}}, actions)).toThrow(/undeclared/);
    expect(() => validateApiPublication({...profile, operations:{"acme.Order.list":{visibility:"public", scopes:["orders:read"]}}}, actions)).toThrow(/non-oauth2/);
    expect(() => validateApiPublication({...profile, scopesSupported:["orders:read", "orders:read"]}, actions)).toThrow(/duplicates/);
  });
});
