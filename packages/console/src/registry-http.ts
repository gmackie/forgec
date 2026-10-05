/**
 * An OCI Distribution server over R2.
 *
 * Scope is deliberate: this serves Forge package artifacts, which the console's own client
 * caps at 8 MB and uploads monolithically. There is no chunked upload, no Range, and no
 * multipart — a `PATCH` is answered with an explicit 405 so a client that needs chunking fails
 * loudly instead of mysteriously.
 *
 * The status codes below are not approximations. The client treats anything other than exactly
 * 201 on a completed upload as failure, and requires HEAD on a blob to be strictly 200 or 404;
 * a generic "ok" helper would return 200 and break publication in a way that only shows up
 * against a real registry.
 *
 * Authentication here is the registry's own Bearer scheme, not Cloudflare Access: the Docker
 * CLI cannot send the headers Access needs. This path is expected to sit behind an Access
 * Bypass rule, and if a request ever arrives carrying an Access assertion that means the
 * bypass is misconfigured — so we say so in the log.
 */
import { DIGEST, R2Oci, sha256Hex } from "./r2-oci.js";

export interface RegistryHttpOptions {
  registry: R2Oci;
  /** Verifies a request and returns the granted scopes, or null to challenge. */
  authorize(request: Request): Promise<{ scopes: string[] } | null>;
  /** Exchanges HTTP Basic credentials for a short-lived bearer token. */
  issueToken?(request: Request): Promise<Response>;
  service: string;
}

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";

function ociError(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ errors: [{ code, message }] }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Split `/v2/<repo>/<verb>...` where the repository itself may contain slashes. */
function parse(path: string): { repository: string; rest: string } | null {
  const after = path.slice("/v2/".length);
  for (const verb of ["/blobs/", "/manifests/", "/tags/list"]) {
    const at = after.lastIndexOf(verb);
    if (at > 0)
      return { repository: after.slice(0, at), rest: after.slice(at + 1) };
  }
  return null;
}

export function createRegistryHttp(options: RegistryHttpOptions) {
  const { registry, service } = options;
  const challenge = () =>
    ociError(401, "UNAUTHORIZED", "Authentication required.", {
      "www-authenticate": `Bearer realm="https://${service}/v2/token",service="${service}",scope="repository:${registry.repository}:pull"`,
    });

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith("/v2/") && path !== "/v2") return ociError(404, "NOT_FOUND", "Not found.");

    // Access must not be in front of /v2 — docker cannot satisfy it. If it is, say so.
    if (request.headers.get("cf-access-jwt-assertion"))
      console.warn(
        "registry: a Cloudflare Access assertion reached /v2, which means the Access bypass for this path is missing or mis-scoped; container clients will receive HTML.",
      );

    if (options.issueToken && (path === "/v2/token" || path === "/v2/token/"))
      return options.issueToken(request);

    const granted = await options.authorize(request);
    if (!granted) return challenge();
    const needs = request.method === "GET" || request.method === "HEAD" ? "pull" : "push";
    if (!granted.scopes.includes(needs))
      return ociError(403, "DENIED", `This credential does not grant ${needs}.`);

    // Version check: clients ping this before anything else.
    if (path === "/v2/" || path === "/v2")
      return new Response("{}", {
        headers: {
          "content-type": "application/json",
          "docker-distribution-api-version": "registry/2.0",
        },
      });

    const parsed = parse(path);
    if (!parsed) return ociError(404, "NOT_FOUND", "Not found.");
    if (parsed.repository !== registry.repository)
      return ociError(404, "NAME_UNKNOWN", "Unknown repository.");
    const rest = parsed.rest;

    // ---- blobs -----------------------------------------------------------------
    if (rest.startsWith("blobs/uploads/") || rest === "blobs/uploads") {
      if (request.method === "POST") {
        // Stateless session: the digest arrives on the PUT, so the id carries no meaning.
        const id = crypto.randomUUID();
        return new Response(null, {
          status: 202,
          headers: {
            // Origin-absolute: the client resolves this against the origin root, not the request.
            location: `/v2/${registry.repository}/blobs/uploads/${id}`,
            "docker-upload-uuid": id,
            range: "0-0",
          },
        });
      }
      if (request.method === "PUT") {
        const digest = url.searchParams.get("digest") ?? "";
        if (!DIGEST.test(digest))
          return ociError(400, "DIGEST_INVALID", "A sha256 digest is required.");
        const text = await request.text();
        if (`sha256:${await sha256Hex(text)}` !== digest)
          return ociError(400, "DIGEST_INVALID", "The content does not match the digest.");
        await registry.putBlob(digest, text);
        return new Response(null, {
          status: 201,
          headers: {
            location: `/v2/${registry.repository}/blobs/${digest}`,
            "docker-content-digest": digest,
          },
        });
      }
      if (request.method === "PATCH")
        return ociError(
          405,
          "UNSUPPORTED",
          "Chunked upload is not supported; this registry accepts monolithic uploads only.",
        );
      return ociError(405, "UNSUPPORTED", "Method not allowed.");
    }

    if (rest.startsWith("blobs/")) {
      const digest = rest.slice("blobs/".length);
      if (!DIGEST.test(digest))
        return ociError(400, "DIGEST_INVALID", "A sha256 digest is required.");
      if (request.method === "HEAD") {
        // Strictly 200 or 404 — the client treats anything else as a protocol failure.
        return (await registry.headBlob(digest))
          ? new Response(null, { status: 200, headers: { "docker-content-digest": digest } })
          : new Response(null, { status: 404 });
      }
      if (request.method !== "GET")
        return ociError(405, "UNSUPPORTED", "Method not allowed.");
      if (!(await registry.headBlob(digest)))
        return ociError(404, "BLOB_UNKNOWN", "Unknown blob.");
      const text = await registry.getBlob(digest, 8_000_000);
      return new Response(text, {
        headers: {
          "content-type": "application/octet-stream",
          "docker-content-digest": digest,
        },
      });
    }

    // ---- manifests -------------------------------------------------------------
    if (rest.startsWith("manifests/")) {
      const reference = decodeURIComponent(rest.slice("manifests/".length));
      if (request.method === "PUT") {
        const text = await request.text();
        // Stored verbatim: the client re-digests exactly these bytes on the way back.
        await registry.putManifest(
          reference,
          text,
          request.headers.get("content-type") ?? OCI_MANIFEST,
        );
        const digest = `sha256:${await sha256Hex(text)}`;
        return new Response(null, {
          status: 201,
          headers: {
            location: `/v2/${registry.repository}/manifests/${digest}`,
            "docker-content-digest": digest,
          },
        });
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        return ociError(405, "UNSUPPORTED", "Method not allowed.");
      const text = await registry.getManifest(reference, 8_000_000);
      // Absent is 404, never 401 — authentication already succeeded above.
      if (text === null) return ociError(404, "MANIFEST_UNKNOWN", "Unknown manifest.");
      const digest = `sha256:${await sha256Hex(text)}`;
      const headers = {
        "content-type": OCI_MANIFEST,
        "docker-content-digest": digest,
      };
      return request.method === "HEAD"
        ? new Response(null, { status: 200, headers })
        : new Response(text, { headers });
    }

    // ---- tags ------------------------------------------------------------------
    if (rest === "tags/list") {
      if (request.method !== "GET")
        return ociError(405, "UNSUPPORTED", "Method not allowed.");
      const n = Math.min(Number(url.searchParams.get("n") ?? 100) || 100, 1000);
      const last = url.searchParams.get("last") ?? undefined;
      const all = (await registry.listTags()).sort();
      const from = last ? all.findIndex((t) => t > last) : 0;
      const page = from < 0 ? [] : all.slice(from, from + n);
      const headers: Record<string, string> = { "content-type": "application/json" };
      const more = from >= 0 && from + n < all.length;
      if (more) {
        const next = `/v2/${registry.repository}/tags/list?n=${n}&last=${encodeURIComponent(page[page.length - 1]!)}`;
        // Origin-absolute with a double-quoted rel: exactly what the client's parser expects.
        headers["link"] = `<${next}>; rel="next"`;
      }
      return new Response(
        JSON.stringify({ name: registry.repository, tags: page }),
        { headers },
      );
    }

    return ociError(404, "NOT_FOUND", "Not found.");
  };
}
