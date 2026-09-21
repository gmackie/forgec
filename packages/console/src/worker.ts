import type { D1Database } from "@cloudflare/workers-types";
import { createApi } from "./api.js";
import { authFrom, registryFrom, secure, type Config } from "./config.js";
import { stateText, type State, type StateStore } from "./model.js";
import { credentialStore, type SqlLike } from "./credentials.js";
import { R2Oci, type R2Like } from "./r2-oci.js";
import { createRegistryHttp } from "./registry-http.js";
import { createTokenEndpoint, verifyRegistryToken } from "./registry-token.js";
export interface Env extends Config {
  DB: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Present only when OCI_BACKEND=r2. */
  BLOBS?: R2Like;
}
/** D1 through the small SQL surface the credential store needs. */
function d1Sql(db: D1Database): SqlLike {
  return {
    async all(text, params) {
      const result = await db.prepare(text).bind(...(params as never[])).all();
      return (result.results ?? []) as Record<string, unknown>[];
    },
    async run(text, params) {
      const result = await db.prepare(text).bind(...(params as never[])).run();
      return { changes: result.meta.changes };
    },
  };
}
export class D1State implements StateStore {
  constructor(private readonly db: D1Database) {}
  async reservePublication(key: string): Promise<boolean> {
    const result = await this.db
      .prepare("INSERT OR IGNORE INTO console_publications VALUES (?, ?)")
      .bind(key, new Date().toISOString())
      .run();
    return result.meta.changes === 1;
  }
  async read(): Promise<State> {
    const row = await this.db
      .prepare("SELECT data FROM console_state WHERE id=1")
      .first<{ data: string }>();
    if (!row) throw new Error("Apply the console D1 migration first.");
    return JSON.parse(row.data) as State;
  }
  async save(expected: number, next: State): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE console_state SET revision=?, data=? WHERE id=1 AND revision=?",
      )
      .bind(next.revision, stateText(next), expected)
      .run();
    return result.meta.changes === 1;
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/healthz") return secure(Response.json({ status: "ok" }), env);
    // The OCI endpoints answer before the asset handler, and deliberately without the console's
    // CSP: these are protocol responses for container clients, not pages for a browser.
    if (path === "/v2" || path.startsWith("/v2/")) {
      if (!env.BLOBS || env.OCI_BACKEND !== "r2" || !env.INSTANCE_AUTHORITY)
        return Response.json(
          {
            errors: [
              {
                code: "UNSUPPORTED",
                message: "This instance does not serve an OCI registry.",
              },
            ],
          },
          { status: 404 },
        );
      const registry = new R2Oci({
        bucket: env.BLOBS,
        repository: env.OCI_REPOSITORY || "forge",
        url: `https://${env.INSTANCE_AUTHORITY}`,
      });
      const store = credentialStore(d1Sql(env.DB));
      const secret = env.REGISTRY_TOKEN_SECRET || "";
      return createRegistryHttp({
        registry,
        service: env.INSTANCE_AUTHORITY,
        ...(secret
          ? {
              issueToken: createTokenEndpoint({
                store,
                secret,
                service: env.INSTANCE_AUTHORITY,
                repository: registry.repository,
              }),
            }
          : {}),
        authorize: async (incoming) => {
          if (!secret) return null;
          const header = incoming.headers.get("authorization") ?? "";
          if (!header.startsWith("Bearer ")) return null;
          const claims = await verifyRegistryToken(
            secret,
            header.slice(7),
            env.INSTANCE_AUTHORITY!,
          );
          return claims ? { scopes: claims.scopes } : null;
        },
      })(request);
    }
    if (!path.startsWith("/api/"))
      return secure((await env.ASSETS.fetch(request)) as unknown as Response, env);
    try {
      if (!env.INSTANCE_AUTHORITY)
        return secure(
          Response.json(
            { error: "Configure INSTANCE_AUTHORITY." },
            { status: 503 },
          ),
          env,
        );
      const api = createApi({
        store: new D1State(env.DB),
        auth: authFrom(env),
        authMode: env.AUTH_MODE === "cloudflare-access" ? "cloudflare-access" : "token",
        identityAuthority: env.ACCESS_TEAM_DOMAIN ?? null,
        authority: env.INSTANCE_AUTHORITY,
        name: env.INSTANCE_NAME || "Forge",
        runtime: "Cloudflare Workers",
        registry: await registryFrom(env, env),
      });
      return secure(await api(request), env);
    } catch (error) {
      console.error(
        "Console initialization failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      return secure(
        Response.json(
          { error: "Instance configuration is incomplete." },
          { status: 503 },
        ),
        env,
      );
    }
  },
};
