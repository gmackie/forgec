import { RpcTarget } from "cloudflare:workers";
class Caps extends RpcTarget {
  constructor(env) { super(); this.env = env; }
  async sql(q, p) { return this.env.DB.prepare(q).bind(...p).first(); }
  async nested(v) { return { echoed: v }; }
  async stream() { return new Response("streamed-bytes").body; }
  async boom() { const e = new Error("refused x"); e.name = "CapabilityDenied"; throw e; }
  async noop() { return 0; }
}
export default {
  async fetch(request, env) {
    const out = {};
    const R = env.RUNTIME;
    const caps = new Caps(env);
    out.keys = await R.keys();
    out.useDb = await R.useDb(env.DB).catch((e) => ({ threw: String(e) }));
    out.callback = await R.callback(caps);
    const res = await R.respond(caps);
    out.respond = { status: res.response.status, h: res.response.headers.get("x-a"), body: await res.response.text(), tenants: res.tenants };
    out.fnArg = await R.fnArg((x) => x * 2);
    out.stream = await R.stream(caps);
    out.later = await R.later(caps);
    await new Promise((r) => setTimeout(r, 100));
    out.lateResult = await R.lateResult();
    out.error = await R.error(caps);
    const t0 = Date.now(); for (let i = 0; i < 200; i++) await R.noop(); out.noop200ms = Date.now() - t0;
    const t1 = Date.now(); await R.roundtrips(caps, 200); out.callback200ms = Date.now() - t1;
    return Response.json(out);
  },
};
