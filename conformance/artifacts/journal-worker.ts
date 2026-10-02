/** Disposable qualification only: a secret-authenticated native D1 journal host. */
import { SqlArtifactPublicationJournal } from "../../packages/runtime/src/adapters/artifact-publication-sql.js";
import { rawD1Executor } from "../../packages/runtime/src/adapters/sql-executor.js";
import { ForgeError } from "../../packages/runtime/src/errors.js";
import type { D1Like } from "../../packages/runtime/src/adapters/d1.js";
interface Env {
  DB: D1Like;
  QUALIFICATION_SECRET: string;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const reply = (status: number, value: unknown) =>
      Response.json(value, {
        status,
        headers: { "cache-control": "no-store" },
      });
    if (
      request.headers.get("authorization") !==
      `Bearer ${env.QUALIFICATION_SECRET}`
    )
      return reply(401, { code: "Unauthenticated" });
    if (request.method !== "POST")
      return reply(405, { code: "MethodNotAllowed" });
    const raw = await request.text();
    if (raw.length > 16384) return reply(413, { code: "PayloadTooLarge" });
    try {
      const input = JSON.parse(raw),
        journal = new SqlArtifactPublicationJournal(rawD1Executor(env.DB));
      let value: unknown;
      if (input.action === "initialize") {
        await journal.initialize();
        value = null;
      } else if (input.action === "claim")
        value = await journal.claim(input.intent);
      else if (input.action === "get") value = await journal.get(input.intent);
      else if (
        input.action === "finish" &&
        ["accepted", "rejected", "observed"].includes(input.outcome)
      )
        value = await journal.finish(input.intent, input.outcome);
      else return reply(400, { code: "MalformedRequest" });
      return reply(200, { value });
    } catch (error) {
      return reply(error instanceof ForgeError ? error.status : 500, {
        code: error instanceof ForgeError ? error.code : "Internal",
      });
    }
  },
};
