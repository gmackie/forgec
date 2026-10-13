/** Exact-path POST webhook bindings. HMAC authenticates bytes, not a domain principal. */
import { err, ForgeError } from "./errors.js";
export interface SignedWebhook {
  /** Resolve a private UTF-8 secret on every request; at least 32 bytes. */
  secret: () => Promise<string>;
  /** Default: x-hub-signature-256, sha256=<64 hexadecimal digits>. */
  signatureHeader?: string;
  /** Maximum raw body bytes, default 1 MiB; enforced on streamed bodies too. */
  maxBodyBytes?: number;
  /** Body has been consumed. Use rawBody; no tenant/actor is inferred from it. */
  handle: (request: Request, rawBody: Uint8Array, requestId: string) => Promise<Response>;
}
export function validateWebhooks(webhooks: Record<string, SignedWebhook>): void {
  for (const [path, webhook] of Object.entries(webhooks)) {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("?") || path.includes("#") || new URL(path, "https://forge.invalid").pathname !== path)
      throw new Error("Webhook paths must be exact canonical absolute paths");
    if (!Number.isSafeInteger(webhook.maxBodyBytes ?? 1_048_576) || (webhook.maxBodyBytes ?? 1_048_576) <= 0)
      throw new Error("Webhook maxBodyBytes must be a positive safe integer");
    new Headers({ [webhook.signatureHeader ?? "x-hub-signature-256"]: "sha256=test" });
  }
}
export async function handleSignedWebhook(req: Request, webhook: SignedWebhook, requestId: string): Promise<Response> {
  const problem = (e: ForgeError) => new Response(JSON.stringify(e.problem(requestId)), {
    status: e.status, headers: { "content-type": "application/problem+json", "x-request-id": requestId },
  });
  const signature = req.headers.get(webhook.signatureHeader ?? "x-hub-signature-256");
  if (!signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return problem(err("Unauthenticated", "invalid webhook signature"));
  const limit = webhook.maxBodyBytes ?? 1_048_576;
  const length = req.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > limit) {
    await req.body?.cancel().catch(() => undefined);
    return problem(err("PayloadTooLarge", "webhook body exceeds configured limit"));
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body?.getReader();
  try {
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel().catch(() => undefined);
          return problem(err("PayloadTooLarge", "webhook body exceeds configured limit"));
        }
        chunks.push(value);
      }
    }
  } catch { return problem(err("MalformedRequest", "could not read webhook body")); }
  finally { reader?.releaseLock(); }
  const rawBody = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { rawBody.set(chunk, offset); offset += chunk.byteLength; }
  let valid: boolean;
  try {
    const secret = new TextEncoder().encode(await webhook.secret());
    if (secret.byteLength < 32) return problem(err("DependencyUnavailable", "webhook verification unavailable"));
    const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const digest = Uint8Array.from(signature.slice(7).match(/../g)!, hex => Number.parseInt(hex, 16));
    valid = await crypto.subtle.verify("HMAC", key, digest, rawBody);
  } catch { return problem(err("DependencyUnavailable", "webhook verification unavailable")); }
  if (!valid) return problem(err("Unauthenticated", "invalid webhook signature"));
  try { return await webhook.handle(req, rawBody, requestId); }
  catch { return problem(err("Internal", "webhook handler failed")); }
}
