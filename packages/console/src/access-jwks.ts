/**
 * Cloudflare Access signing keys, cached for the life of the isolate.
 *
 * The cache lives at module scope on purpose. The Worker rebuilds its API object on every
 * request, so a cache held inside that object would fetch Cloudflare's key set on every single
 * request — adding a round trip to each one and inviting rate limiting. Module scope survives
 * across requests in an isolate, which is exactly the lifetime wanted.
 *
 * Failure behaviour is deliberate too: if a refresh fails we keep serving the keys we already
 * have for up to a day, because a momentary blip fetching a key set is a much smaller problem
 * than locking every operator out of the console.
 */
const FRESH_MS = 60 * 60 * 1000; // refresh hourly
const STALE_MS = 24 * 60 * 60 * 1000; // but keep serving for a day if refresh fails
const REFETCH_MS = 5 * 60 * 1000; // an unknown kid may force one refetch this often

interface Entry {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
  lastAttempt: number;
  inflight?: Promise<void>;
}

const cache = new Map<string, Entry>();

/** Tests only: forget every cached key set. */
export function resetAccessKeys(): void {
  cache.clear();
}

async function importJwks(json: unknown): Promise<Map<string, CryptoKey>> {
  const keys = new Map<string, CryptoKey>();
  const list = (json as { keys?: (JsonWebKey & { kid?: string })[] }).keys ?? [];
  for (const jwk of list) {
    if (!jwk.kid) continue;
    try {
      keys.set(
        jwk.kid,
        await crypto.subtle.importKey(
          "jwk",
          jwk,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        ),
      );
    } catch {
      // One unusable key must not discard the rest of the set.
    }
  }
  if (keys.size === 0) throw new Error("Access returned no usable signing keys.");
  return keys;
}

async function refresh(
  team: string,
  entry: Entry,
  fetcher: typeof fetch,
): Promise<void> {
  const response = await fetcher(`https://${team}/cdn-cgi/access/certs`);
  if (!response.ok)
    throw new Error(`Access key set returned HTTP ${response.status}`);
  entry.keys = await importJwks(await response.json());
  entry.fetchedAt = Date.now();
}

/**
 * The signing keys for a team, refreshing when stale. `kid` lets an unknown key trigger at most
 * one extra fetch per interval, so a key rotation is picked up without letting an attacker
 * force unbounded outbound requests by presenting junk identifiers.
 */
export async function accessKeys(
  team: string,
  options: { fetch?: typeof fetch; kid?: string } = {},
): Promise<Map<string, CryptoKey>> {
  const fetcher = options.fetch ?? fetch;
  let entry = cache.get(team);
  if (!entry) {
    entry = { keys: new Map(), fetchedAt: 0, lastAttempt: 0 };
    cache.set(team, entry);
  }
  const now = Date.now();
  const empty = entry.keys.size === 0;
  const stale = now - entry.fetchedAt > FRESH_MS;
  const unknownKid =
    !!options.kid &&
    !entry.keys.has(options.kid) &&
    now - entry.lastAttempt > REFETCH_MS;

  if (empty || stale || unknownKid) {
    // Single-flight: concurrent requests in the same isolate share one fetch.
    if (!entry.inflight) {
      entry.lastAttempt = now;
      const current = entry;
      current.inflight = refresh(team, current, fetcher).finally(() => {
        delete current.inflight;
      });
    }
    try {
      await entry.inflight;
    } catch (error) {
      // Serve what we have rather than locking everyone out over a transient failure.
      if (entry.keys.size === 0 || now - entry.fetchedAt > STALE_MS) throw error;
      console.warn(
        "access: could not refresh signing keys; continuing with the cached set",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
  }
  return entry.keys;
}
