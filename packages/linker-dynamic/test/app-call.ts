// FORG-51. App calls from the tests cross the same two keep-alive hops as the harness's admin PUTs
// (FORG-45, scripts/harness.mjs), so a dropped hop answers 500 "Network connection lost." (503 if
// the Worker restarted) or fails as a reset socket. Each drop is logged with its method and path.
// A call that carries an Idempotency-Key is retried, at most APP_ATTEMPTS times with backoff: the
// runtime replays a repeated key instead of repeating the effect. Calls without a key are never
// retried, nor is any other failure, and the host (src/) never retries.
import { h } from "./fixtures.ts";

export const APP_ATTEMPTS = 3;
export type Reply = { method: string; path: string; status: number; json: any; isolate: string | null; closure: string | null; entry: string | null };

export async function appCall(base: string, method: string, path: string, body: unknown, { headers, key }: { headers: Record<string, string>; key?: string }): Promise<Reply> {
  const init = { method, headers: key ? { ...headers, "idempotency-key": key } : headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  for (let attempt = 1; ; attempt++) {
    let lost = "";
    try {
      const r = await fetch(`${base}${path}`, init);
      const text = await r.text();
      if (!h.droppedHop(r.status, text)) {
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = text;
        }
        return { method, path, status: r.status, json, isolate: r.headers.get("x-forge-isolate"), closure: r.headers.get("x-forge-closure"), entry: r.headers.get("x-forge-entry") };
      }
      lost = `${r.status} ${text.split("\n")[0]}`;
    } catch (e) {
      if (!h.droppedSocket(e)) throw e;
      lost = `${(e as Error).message} (${(e as { cause?: { code?: string } }).cause?.code})`;
    }
    const retry = key !== undefined && attempt < APP_ATTEMPTS;
    const next = retry ? `retrying with its Idempotency-Key in ${250 * 2 ** (attempt - 1)} ms` : key === undefined ? "no Idempotency-Key, so not retried" : "giving up";
    console.warn(`[app-call] ${method} ${path}: attempt ${attempt} of ${key === undefined ? 1 : APP_ATTEMPTS} lost its connection (${lost}); ${next}.`);
    if (!retry) throw new Error(`${method} ${path} lost its connection: ${lost} (attempt ${attempt})`);
    await new Promise((res) => setTimeout(res, 250 * 2 ** (attempt - 1)));
  }
}
