/** Disposable management-path qualification; never an application endpoint. */
export default {
  async fetch(request, env) {
    const reply = (status, body) =>
      Response.json(body, {
        status,
        headers: { "cache-control": "no-store" },
      });
    if (
      !env.QUALIFICATION_SECRET ||
      request.headers.get("authorization") !==
        `Bearer ${env.QUALIFICATION_SECRET}`
    ) {
      return reply(401, { code: "Unauthenticated" });
    }
    const url = new URL(request.url);
    if (url.search || !/^forge-binding-[a-z0-9-]+$/.test(env.REPO_NAME ?? "")) {
      return reply(400, { code: "InvalidRequest" });
    }
    const cleanup = request.method === "DELETE" && url.pathname === "/repo";
    if (
      !cleanup &&
      (!Number.isFinite(Number(env.EXPIRES_AT)) ||
        Date.now() >= Number(env.EXPIRES_AT))
    ) {
      return reply(410, { code: "Expired" });
    }
    try {
      if (request.method === "GET" && url.pathname === "/ready")
        return reply(200, { ready: true });
      if (request.method === "POST" && url.pathname === "/create") {
        const result = await env.ARTIFACTS.create(env.REPO_NAME, {
          setDefaultBranch: "main",
        });
        return reply(200, {
          id: result.id,
          name: result.name,
          remote: result.remote,
          token: result.token,
        });
      }
      if (request.method === "GET" && url.pathname === "/repo") {
        const repo = await env.ARTIFACTS.get(env.REPO_NAME);
        try {
          return reply(200, await repo.info());
        } finally {
          repo[Symbol.dispose]();
        }
      }
      if (cleanup) {
        await env.ARTIFACTS.delete(env.REPO_NAME);
        return reply(200, { deleted: true });
      }
      return reply(405, { code: "MethodNotAllowed" });
    } catch (error) {
      if (error?.code === 10200 || error?.code === "NOT_FOUND")
        return reply(404, { code: "NotFound" });
      return reply(502, { code: "ProviderFailure" });
    }
  },
};
