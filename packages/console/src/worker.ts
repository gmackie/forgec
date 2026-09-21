import type { D1Database } from "@cloudflare/workers-types";
import { gitRepositories } from "./git.js";
import { createApi } from "./api.js";
import { registryFrom, secure, type Config } from "./config.js";
import { stateText, type State, type StateStore } from "./model.js";
export interface Env extends Config {
  DB: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
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
    if (path === "/healthz") return secure(Response.json({ status: "ok" }));
    if (!path.startsWith("/api/"))
      return secure((await env.ASSETS.fetch(request)) as unknown as Response);
    try {
      if (!env.INSTANCE_AUTHORITY)
        return secure(
          Response.json(
            { error: "Configure INSTANCE_AUTHORITY." },
            { status: 503 },
          ),
        );
      const api = createApi({
        store: new D1State(env.DB),
        token: env.ADMIN_TOKEN || "",
        authority: env.INSTANCE_AUTHORITY,
        name: env.INSTANCE_NAME || "Forge",
        runtime: "Cloudflare Workers",
        registry: await registryFrom(env),
        git: gitRepositories(env),
      });
      return secure(await api(request));
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
      );
    }
  },
};
