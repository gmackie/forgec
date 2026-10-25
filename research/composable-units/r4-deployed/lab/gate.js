// FORG-38 lab wrapper for the public lab Workers (linker B's host, linker C's router and tier host).
//   - A gate: every request needs `x-lab-token: <LAB_TOKEN>`. acme runs with FORGE_AUTH=dev-headers, which
//     trusts tenant and actor headers verbatim, and these Workers have public workers.dev hostnames. C's
//     router forwards the client's headers, so the token reaches the tier host behind it.
//   - Isolate identity on every answer, so a cold child can be told apart from a request that landed on
//     another isolate of this Worker: x-lab-<name>-isolate, -isolate-age-ms, -requests, and x-lab-colo.
//   - GET /_lab/whoami answers the identity alone; GET /_lab/health answers 200 to anyone (the deploy probe).
// The wrapped Worker is unchanged; only these headers are added.
export function labGate(inner, name) {
  let isolate = null;
  let started = 0;
  let requests = 0;
  return {
    async fetch(request, env, ctx) {
      // Random values are not available in global scope, so the identity is made on the first request.
      if (!isolate) {
        isolate = crypto.randomUUID().slice(0, 8);
        started = Date.now();
      }
      requests++;
      const id = { name, isolate, ageMs: Date.now() - started, requests, colo: request.cf?.colo ?? null };
      // ForgeGraph's post-deploy probe: no token, no information.
      if (new URL(request.url).pathname === "/_lab/health") return new Response("ok");
      if (!env.LAB_TOKEN || request.headers.get("x-lab-token") !== env.LAB_TOKEN) return new Response("not found", { status: 404 });
      if (new URL(request.url).pathname === "/_lab/whoami") return Response.json(id);
      const t0 = Date.now();
      const res = await inner.fetch(request, env, ctx);
      if (res.status === 101 || res.webSocket) return res;
      const out = new Response(res.body, res);
      out.headers.set(`x-lab-${name}-isolate`, isolate);
      out.headers.set(`x-lab-${name}-isolate-age-ms`, String(id.ageMs));
      out.headers.set(`x-lab-${name}-requests`, String(requests));
      out.headers.set(`x-lab-${name}-ms`, String(Date.now() - t0));
      if (id.colo) out.headers.set("x-lab-colo", id.colo);
      return out;
    },
  };
}
