/** Optional Workers HTTPS entrypoint for a Docker-hosted console. */
interface EdgeConfig { ORIGIN_URL: string; ORIGIN_TOKEN: string }
export default {
  async fetch(request: Request, env: EdgeConfig): Promise<Response> {
    let origin: URL;
    try {
      origin = new URL(env.ORIGIN_URL);
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || !env.ORIGIN_TOKEN) throw new Error("Invalid origin");
    } catch { return new Response("Origin is not configured", { status: 503 }); }
    const incoming = new URL(request.url);
    origin.pathname = origin.pathname.replace(/\/$/, "") + incoming.pathname;
    origin.search = incoming.search;
    const headers = new Headers(request.headers);
    headers.set("x-forge-origin-token", env.ORIGIN_TOKEN);
    headers.delete("host");
    try {
      return await fetch(new Request(origin, {
        method: request.method, headers, redirect: "manual",
        ...(!["GET", "HEAD"].includes(request.method) ? { body: request.body, duplex: "half" } : {}),
      } as RequestInit));
    } catch { return new Response("Origin unavailable", { status: 502 }); }
  },
};
