/** Opaque, integrity-protected pagination cursors (specs/portable-profile/wire-format.md). */
import { Effect } from "effect";
import { err, type ForgeError } from "./errors.js";

export interface CursorState {
  q: string; // operation id
  v: number; // contract version
  t: string; // tenant fingerprint
  k: string[]; // encoded sort keys of the last item
  id: string; // tie-breaker
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64url(new Uint8Array(sig)).slice(0, 32);
}

export function encodeCursor(secret: string, state: CursorState): Effect.Effect<string, never> {
  return Effect.promise(async () => {
    const payload = b64url(enc.encode(JSON.stringify(state)));
    return `${payload}.${await hmac(secret, payload)}`;
  });
}

export function decodeCursor(secret: string, cursor: string, expect: { q: string; t: string }): Effect.Effect<CursorState, ForgeError> {
  return Effect.promise(async () => {
    const [payload, sig] = cursor.split(".");
    if (!payload || !sig || sig !== (await hmac(secret, payload))) return null;
    try {
      return JSON.parse(new TextDecoder().decode(unb64url(payload))) as CursorState;
    } catch {
      return null;
    }
  }).pipe(
    Effect.flatMap((state) => {
      if (!state || state.q !== expect.q || state.t !== expect.t || !Array.isArray(state.k)) {
        return Effect.fail(err("InvalidCursor", "cursor is invalid, expired, or for another query"));
      }
      return Effect.succeed(state);
    }),
  );
}
