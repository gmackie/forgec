/**
 * Integrations: external HTTP APIs the playground can browse and call.
 *
 * The catalog comes from ForgeGraph's contract registry: every app in the workspace is an
 * integration, described by its published contract. `INTEGRATIONS_JSON` supplies what the
 * registry does not know — a base URL when the app's health-check origin is not its API, how to
 * authenticate, and whether writes are allowed.
 *
 * Calls are proxied by this server, never made from the browser: the base URL is pinned per
 * integration, only operations in the contract can be called with only their declared
 * parameters, redirects are refused, reads are the default and every write needs both an
 * integration-level opt-in and a per-call confirmation. Credentials are named secrets read on
 * the server; their values never appear in a response, an error or the audit log.
 */
import { z } from "zod";
import { Problem } from "./model.js";
import {
  contractIrSchema,
  contractToOpenApi,
  describeOperation,
  type ContractIr,
  type OpenApiOperation,
} from "./contract-openapi.js";
import { sampleInput } from "./runtime-control.js";

/** Secret names an integration may reference. A fixed prefix keeps instance secrets (signing keys,
 * admin tokens) from being named as an integration credential and sent to another host. */
const secretName = z.string().regex(/^INTEGRATION_[A-Z0-9_]{1,64}$/);
const authSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("bearer"), secret: secretName }).strict(),
  z
    .object({
      kind: z.literal("header"),
      name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
      secret: secretName,
    })
    .strict(),
  /** A Cloudflare Access service token, for apps behind Access. */
  z
    .object({ kind: z.literal("cloudflare-access"), clientId: secretName, clientSecret: secretName })
    .strict(),
]);
export type IntegrationAuth = z.infer<typeof authSchema>;
const overrideSchema = z
  .object({
    /** The ForgeGraph app slug this entry configures. */
    app: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    name: z.string().min(1).max(120).optional(),
    /** The API's base URL, path prefix included (e.g. `https://example.com/api`). */
    baseUrl: z.string().max(500).optional(),
    auth: authSchema.optional(),
    /** Allow non-GET operations. Each write still needs confirmation per call. */
    writes: z.boolean().optional(),
    hidden: z.boolean().optional(),
  })
  .strict();
export type IntegrationOverride = z.infer<typeof overrideSchema>;

export interface IntegrationsConfig {
  FORGEGRAPH_URL?: string | undefined;
  FORGEGRAPH_TOKEN?: string | undefined;
  INTEGRATIONS_JSON?: string | undefined;
  /** "true" only in local acceptance tests: allow http and loopback base URLs. */
  INTEGRATIONS_ALLOW_HTTP?: string | undefined;
}

export interface IntegrationSummary {
  id: string;
  name: string;
  app: string;
  description: string | null;
  /** Where calls go. Null until the app's API location is known. */
  baseUrl: string | null;
  auth: IntegrationAuth["kind"];
  writes: boolean;
}

const BLOCKED_HOST =
  /^(localhost|metadata(\.google\.internal)?|.*\.(local|localhost|internal|lan|home|corp))$/i;
/**
 * A public https base URL. Hostnames only: literal IPs (which is how private ranges and cloud
 * metadata endpoints are usually reached) and internal names are refused. Name resolution is
 * not checked, because Workers cannot resolve names before connecting.
 */
export function publicBaseUrl(raw: string, insecure = false): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid integration base URL: ${raw}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // Local acceptance tests only (INTEGRATIONS_ALLOW_HTTP): any http(s) host, still no credentials.
  if (insecure) {
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error(`Invalid integration base URL: ${raw}`);
    return url.origin + url.pathname.replace(/\/+$/, "");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    !host.includes(".") ||
    /^[\d.]+$/.test(host) ||
    host.includes(":") ||
    BLOCKED_HOST.test(host)
  )
    throw new Error(`Integration base URLs must be public https origins: ${raw}`);
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export function integrationOverrides(json: string | undefined, insecure = false): IntegrationOverride[] {
  if (!json) return [];
  const list = z.array(overrideSchema).max(200).parse(JSON.parse(json));
  if (new Set(list.map((o) => o.app)).size !== list.length)
    throw new Error("Duplicate app in INTEGRATIONS_JSON.");
  for (const o of list) if (o.baseUrl) publicBaseUrl(o.baseUrl, insecure);
  return list;
}

interface ForgeGraphApp {
  slug: string;
  name: string;
  description?: string | null;
  healthCheckUrl?: string | null;
}

/** Read access to ForgeGraph's app list and contract registry with a read-scope token. */
export class ForgeGraphRegistry {
  private readonly base: string;
  constructor(
    url: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
    insecure = false,
  ) {
    this.base = publicBaseUrl(url, insecure);
  }
  private async get(path: string): Promise<{ status: number; value: any }> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
      });
    } catch {
      throw new Problem(502, "ForgeGraph did not respond within the request deadline.");
    }
    if (response.status === 401 || response.status === 403)
      throw new Problem(502, "ForgeGraph refused the console's token. Check FORGEGRAPH_TOKEN.");
    if (response.status === 404) return { status: 404, value: null };
    if (!response.ok) throw new Problem(502, `ForgeGraph returned ${response.status}.`);
    const text = await response.text();
    if (text.length > 8_000_000) throw new Problem(502, "ForgeGraph response exceeds 8 MB.");
    try {
      return { status: response.status, value: JSON.parse(text) };
    } catch {
      throw new Problem(502, "ForgeGraph returned non-JSON.");
    }
  }
  async apps(): Promise<ForgeGraphApp[]> {
    const { value } = await this.get("/api/fg/apps");
    if (!Array.isArray(value?.apps)) throw new Problem(502, "ForgeGraph returned an invalid app list.");
    return value.apps.filter((a: any) => typeof a?.slug === "string" && typeof a?.name === "string");
  }
  /** The app's latest published contract, or null when it has published none. */
  async contract(slug: string): Promise<ContractIr | null> {
    const { status, value } = await this.get(`/api/fg/contracts?appSlug=${encodeURIComponent(slug)}`);
    if (status === 404) return null;
    const parsed = contractIrSchema.safeParse(value?.ir);
    if (!parsed.success) throw new Problem(502, `ForgeGraph returned an invalid contract for ${slug}.`);
    return parsed.data;
  }
}

/** The origin of an app's health check: where its API is unless configured otherwise. */
function healthOrigin(url: string | null | undefined, insecure: boolean): string | null {
  if (!url) return null;
  try {
    return publicBaseUrl(new URL(url).origin, insecure);
  } catch {
    return null;
  }
}

/** Starting values for the request builder: required parameters and a body from the schema. */
function sampleRequest(op: OpenApiOperation, doc: unknown) {
  const values = (where: "path" | "query" | "header") =>
    Object.fromEntries(
      op.parameters
        .filter((p) => p.in === where && p.required)
        .map((p) => [p.name, sampleInput(p.schema, doc) ?? ""]),
    );
  const json = op.requestBody && Object.entries(op.requestBody.content).find(([type]) => /json/i.test(type));
  return {
    path: values("path"),
    query: values("query"),
    headers: values("header"),
    ...(json ? { body: sampleInput(json[1].schema, doc) ?? {} } : {}),
  };
}

const CACHE_MS = 5 * 60_000;
const RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "etag",
  "last-modified",
  "cache-control",
  "retry-after",
  "x-request-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);
/** Request headers a caller may never set through a declared header parameter. */
const RESERVED_HEADERS =
  /^(authorization|cookie|host|content-length|connection|transfer-encoding|proxy-.*|cf-.*|x-forwarded-.*|forwarded)$/i;

export const callSchema = z
  .object({
    operationId: z.string().min(1).max(300),
    path: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    headers: z.record(z.string(), z.string().max(2000)).optional(),
    body: z.unknown().optional(),
    contentType: z.string().max(200).optional(),
    /** Required for any operation other than GET/HEAD. */
    confirmWrite: z.boolean().optional(),
  })
  .strict();
export type IntegrationCall = z.infer<typeof callSchema>;

export interface IntegrationResult {
  status: number;
  ok: boolean;
  durationMs: number;
  headers: Record<string, string>;
  /** Parsed JSON, text, or null for an empty or binary body. */
  body: unknown;
  bodyKind: "json" | "text" | "empty" | "binary";
}

export class Integrations {
  private appsCache: { at: number; apps: ForgeGraphApp[] } | null = null;
  private contracts = new Map<string, { at: number; contract: ContractIr | null }>();
  constructor(
    private readonly registry: ForgeGraphRegistry,
    private readonly overrides: IntegrationOverride[],
    private readonly secrets: Record<string, unknown>,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly insecure = false,
  ) {}

  private async appList(): Promise<ForgeGraphApp[]> {
    if (this.appsCache && this.now() - this.appsCache.at < CACHE_MS) return this.appsCache.apps;
    const apps = await this.registry.apps();
    this.appsCache = { at: this.now(), apps };
    return apps;
  }
  private summary(app: ForgeGraphApp): IntegrationSummary {
    const o = this.overrides.find((x) => x.app === app.slug);
    return {
      id: app.slug,
      name: o?.name ?? app.name,
      app: app.slug,
      description: app.description ?? null,
      baseUrl: o?.baseUrl ? publicBaseUrl(o.baseUrl, this.insecure) : healthOrigin(app.healthCheckUrl, this.insecure),
      auth: o?.auth?.kind ?? "none",
      writes: o?.writes ?? false,
    };
  }
  async list(): Promise<IntegrationSummary[]> {
    const hidden = new Set(this.overrides.filter((o) => o.hidden).map((o) => o.app));
    return (await this.appList())
      .filter((a) => !hidden.has(a.slug))
      .map((a) => this.summary(a))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  private async find(id: string): Promise<IntegrationSummary> {
    const app = (await this.appList()).find((a) => a.slug === id);
    if (!app || this.overrides.some((o) => o.app === id && o.hidden))
      throw new Problem(404, "Integration is not available on this instance.");
    return this.summary(app);
  }
  private async contract(id: string): Promise<ContractIr> {
    const cached = this.contracts.get(id);
    const contract =
      cached && this.now() - cached.at < CACHE_MS ? cached.contract : await this.registry.contract(id);
    this.contracts.set(id, { at: this.now(), contract });
    if (!contract)
      throw new Problem(404, "This app has not published an API contract. Add `fg contract publish` to its CI.");
    return contract;
  }
  /** The integration with its operations, for the playground's explorer. */
  async describe(id: string) {
    const integration = await this.find(id);
    const contract = await this.contract(id);
    const doc = { components: { schemas: contract.components } };
    const operations = contract.operations
      .map(describeOperation)
      .filter((o): o is OpenApiOperation => o !== null)
      .sort((a, b) => a.operationId.localeCompare(b.operationId))
      .map((o) => ({ ...o, sample: sampleRequest(o, doc) }));
    return {
      integration,
      contract: {
        fingerprint: contract.fingerprint,
        serviceId: contract.serviceId,
        operationCount: contract.operations.length,
      },
      operations,
      securitySchemes: contract.securitySchemes,
      components: contract.components,
    };
  }
  /** OpenAPI for the integration, optionally only some operations (the graph importer is size-capped). */
  async openapi(id: string, only: string[] = []) {
    const integration = await this.find(id);
    const contract = await this.contract(id);
    const picked = only.length ? { ...contract, operations: contract.operations.filter((o) => only.includes(o.id)) } : contract;
    if (only.length && picked.operations.length !== new Set(only).size)
      throw new Problem(404, "The contract has no such operation.");
    return contractToOpenApi(picked, {
      title: integration.name,
      ...(integration.baseUrl ? { serverUrl: integration.baseUrl } : {}),
    });
  }

  private secret(name: string): string {
    const value = this.secrets[name];
    if (typeof value !== "string" || !value)
      throw new Problem(503, `The integration's credential is not configured on this instance (${name}).`);
    return value;
  }
  private authHeaders(id: string): Record<string, string> {
    const auth = this.overrides.find((o) => o.app === id)?.auth;
    if (!auth || auth.kind === "none") return {};
    if (auth.kind === "bearer") return { authorization: `Bearer ${this.secret(auth.secret)}` };
    if (auth.kind === "header") return { [auth.name.toLowerCase()]: this.secret(auth.secret) };
    return {
      "cf-access-client-id": this.secret(auth.clientId),
      "cf-access-client-secret": this.secret(auth.clientSecret),
    };
  }

  /** Call one operation of an integration's contract. */
  async call(id: string, input: IntegrationCall): Promise<IntegrationResult> {
    const integration = await this.find(id);
    if (!integration.baseUrl)
      throw new Problem(409, "This integration has no base URL. Set one in INTEGRATIONS_JSON.");
    const op = (await this.contract(id)).operations
      .map(describeOperation)
      .find((o) => o?.operationId === input.operationId);
    if (!op) throw new Problem(404, "The contract has no such operation.");
    const write = !["get", "head"].includes(op.method);
    if (write && !integration.writes)
      throw new Problem(403, "Writes are not enabled for this integration.");
    if (write && input.confirmWrite !== true)
      throw new Problem(428, "Confirm this write before it is sent.");

    const declared = (where: "path" | "query" | "header") =>
      new Map(
        op.parameters
          .filter((p) => p.in === where)
          // Header names are case-insensitive; path and query names are not.
          .map((p) => [where === "header" ? p.name.toLowerCase() : p.name, p]),
      );
    const pathParams = declared("path");
    const queryParams = declared("query");
    const headerParams = declared("header");
    for (const name of Object.keys(input.path ?? {}))
      if (!pathParams.has(name)) throw new Problem(400, `Unknown path parameter ${name}.`);
    for (const name of Object.keys(input.query ?? {}))
      if (!queryParams.has(name)) throw new Problem(400, `Unknown query parameter ${name}.`);
    for (const name of Object.keys(input.headers ?? {}))
      if (!headerParams.has(name.toLowerCase()) || RESERVED_HEADERS.test(name))
        throw new Problem(400, `Header ${name} cannot be set for this operation.`);

    const path = op.path.replace(/\{([^}/]+)\}/g, (_, name: string) => {
      const value = input.path?.[name];
      if (value === undefined || value === "") throw new Problem(400, `Missing path parameter ${name}.`);
      const text = String(value);
      if (text === "." || text === "..") throw new Problem(400, `Invalid path parameter ${name}.`);
      // encodeURIComponent encodes "/", so a value can never add a path segment.
      return encodeURIComponent(text);
    });
    for (const p of [...queryParams.values()])
      if (p.required && input.query?.[p.name] === undefined)
        throw new Problem(400, `Missing query parameter ${p.name}.`);
    const base = new URL(integration.baseUrl + "/");
    const url = new URL(integration.baseUrl + path);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/$/, "")))
      throw new Problem(400, "The operation path leaves the integration's base URL.");
    for (const [k, v] of Object.entries(input.query ?? {})) url.searchParams.set(k, String(v));

    const headers: Record<string, string> = { accept: "application/json, text/plain;q=0.9, */*;q=0.1" };
    for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v;
    let requestBody: string | undefined;
    if (op.requestBody && input.body !== undefined) {
      const types = Object.keys(op.requestBody.content);
      const type = input.contentType ?? types[0]!;
      if (!types.includes(type)) throw new Problem(400, `The operation does not accept ${type}.`);
      if (!/json/i.test(type)) throw new Problem(400, "Only JSON request bodies can be sent from the playground.");
      headers["content-type"] = type;
      requestBody = JSON.stringify(input.body);
    } else if (input.body !== undefined) throw new Problem(400, "This operation takes no request body.");
    // Credentials last, so nothing above can replace them.
    Object.assign(headers, this.authHeaders(id));

    const started = this.now();
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: op.method.toUpperCase(),
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
        headers,
        ...(requestBody !== undefined ? { body: requestBody } : {}),
      });
    } catch {
      throw new Problem(504, "The integration did not respond within 15 seconds.");
    }
    if (response.status >= 300 && response.status < 400)
      throw new Problem(502, `The integration redirected (${response.status}); redirects are not followed.`);
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 2_000_000) {
          await reader.cancel();
          throw new Problem(502, "The integration's response exceeds 2 MB.");
        }
        chunks.push(part.value);
      }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    const type = response.headers.get("content-type") ?? "";
    let body: unknown = null;
    let bodyKind: IntegrationResult["bodyKind"] = "empty";
    if (size) {
      const text = /json|text|xml|javascript|x-www-form-urlencoded/i.test(type) || !type ? new TextDecoder().decode(bytes) : null;
      if (text === null) bodyKind = "binary";
      else if (/json/i.test(type))
        try {
          body = JSON.parse(text);
          bodyKind = "json";
        } catch {
          body = text;
          bodyKind = "text";
        }
      else {
        body = text;
        bodyKind = "text";
      }
    }
    const kept: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (RESPONSE_HEADERS.has(key.toLowerCase())) kept[key.toLowerCase()] = value;
    });
    return { status: response.status, ok: response.ok, durationMs: this.now() - started, headers: kept, body, bodyKind };
  }
}

export function integrationsFrom(config: IntegrationsConfig): Integrations | null {
  if (!config.FORGEGRAPH_URL) return null;
  if (!config.FORGEGRAPH_TOKEN) throw new Error("FORGEGRAPH_TOKEN is required with FORGEGRAPH_URL.");
  const insecure = config.INTEGRATIONS_ALLOW_HTTP === "true";
  return new Integrations(
    new ForgeGraphRegistry(config.FORGEGRAPH_URL, config.FORGEGRAPH_TOKEN, fetch, insecure),
    integrationOverrides(config.INTEGRATIONS_JSON, insecure),
    config as Record<string, unknown>,
    fetch,
    Date.now,
    insecure,
  );
}
