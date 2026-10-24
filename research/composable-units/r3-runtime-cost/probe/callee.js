import { WorkerEntrypoint } from "cloudflare:workers";
export default class Runtime extends WorkerEntrypoint {
  async keys() { return Object.keys(this.env); }
  async useDb(db) { try { const r = await db.prepare("select 1 as x").first(); return { ok: true, r }; } catch (e) { return { ok: false, e: String(e) }; } }
  async callback(caps) { const a = await caps.sql("select 2 as y", []); const b = await caps.nested({ deep: [1, 2] }); return { a, b }; }
  async respond(caps) { const body = await caps.sql("select 3 as z", []); return { response: new Response(JSON.stringify(body), { status: 201, headers: { "x-a": "1" } }), tenants: ["t1"] }; }
  async fnArg(fn) { return await fn(21); }
  async stream(caps) { const s = await caps.stream(); return new Response(s).text(); }
  async later(caps) { this.ctx.waitUntil((async () => { await new Promise((r) => setTimeout(r, 20)); try { await caps.sql("select 4", []); globalThis.lateOk = true; } catch (e) { globalThis.lateErr = String(e); } })()); return "returned"; }
  async lateResult() { return { lateOk: globalThis.lateOk ?? null, lateErr: globalThis.lateErr ?? null }; }
  async error(caps) { try { await caps.boom(); } catch (e) { return { name: e.name, message: e.message }; } }
  async noop() { return 1; }
  async roundtrips(caps, n) { for (let i = 0; i < n; i++) await caps.noop(); return n; }
}
