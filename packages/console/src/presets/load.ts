/**
 * A preset spec is accepted only when its bytes match the pinned sha256.
 * The browser never fetches it: the console does, then refuses redirects and
 * anything over 1.5 MB.
 */
import { Problem } from "../model.js";
import { parseOpenApiText, type ParsedSpec } from "./parse.js";

export const SPEC_BYTE_CAP = 1_500_000;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function loadSpecBytes(bytes: Uint8Array, expectedSha256: string): Promise<ParsedSpec> {
  const actual = await sha256Hex(bytes);
  const expected = expectedSha256.toLowerCase();
  if (actual !== expected) throw new Problem(502, `Spec digest mismatch (pinned ${expected}, got ${actual}).`);
  return parseOpenApiText(new TextDecoder().decode(bytes));
}

export async function loadSpecText(text: string, expectedSha256: string): Promise<ParsedSpec> {
  return loadSpecBytes(new TextEncoder().encode(text), expectedSha256);
}

async function readCapped(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > SPEC_BYTE_CAP) throw new Problem(502, "The preset spec exceeds 1.5 MB.");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > SPEC_BYTE_CAP) {
      await reader.cancel();
      throw new Problem(502, "The preset spec exceeds 1.5 MB.");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Fetch `specUrl`, check its digest, and parse it. The URL must be a public https URL. */
export async function fetchSpec(specUrl: string, expectedSha256: string, fetcher: typeof fetch): Promise<ParsedSpec> {
  // Imported lazily: the integration catalog calls back into this module.
  const { publicBaseUrl } = await import("../integrations.js");
  let url: string;
  try {
    url = publicBaseUrl(specUrl);
  } catch (error) {
    throw new Problem(502, error instanceof Error ? error.message : "Invalid preset spec URL.");
  }
  let response: Response;
  try {
    response = await fetcher(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      headers: { accept: "application/yaml, application/json, text/yaml;q=0.9, */*;q=0.1" },
    });
  } catch {
    throw new Problem(502, "The preset spec did not respond within 15 seconds.");
  }
  if (response.status >= 300 && response.status < 400)
    throw new Problem(502, `The preset spec redirected (${response.status}); redirects are not followed.`);
  if (!response.ok) throw new Problem(502, `The preset spec returned ${response.status}.`);
  return loadSpecBytes(await readCapped(response), expectedSha256);
}
