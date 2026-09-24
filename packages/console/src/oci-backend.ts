/**
 * Transport for the OCI Distribution operations this console performs.
 *
 * `OciRegistry` owns the domain: signing, canonical serialisation, and the digest/size
 * verification of everything it reads back. A backend owns only how bytes travel. Splitting
 * there means an R2-backed instance and an HTTP-backed one verify artifacts through exactly
 * the same code, so "the registry is reachable a different way" can never become "the registry
 * is trusted a different way".
 *
 * `HttpOci` below is the existing behaviour, moved verbatim.
 */
import { Problem } from "./model.js";

export interface OciBackend {
  /** Origin the registry is reachable at; surfaced in the Settings view. */
  readonly url: string;
  readonly repository: string;
  /** True when the blob is already stored. Must distinguish present from absent, nothing else. */
  headBlob(digest: string): Promise<boolean>;
  putBlob(digest: string, text: string): Promise<void>;
  getBlob(digest: string, limit: number): Promise<string>;
  headManifest(reference: string): Promise<boolean>;
  putManifest(tag: string, text: string, mediaType: string): Promise<void>;
  /** `null` means "not found"; every other failure throws. */
  getManifest(reference: string, limit: number): Promise<string | null>;
  listTags(): Promise<string[]>;
}

export interface HttpOciOptions {
  url: string;
  repository: string;
  authorization?: string;
  blobHosts?: string[];
  allowHttp?: boolean;
  fetch?: typeof fetch;
}

/** Read a response body with a hard ceiling, so a hostile registry cannot exhaust memory. */
async function readBounded(res: Response, limit: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Empty OCI response");
  let length = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.length;
    if (length > limit) {
      await reader.cancel();
      throw new Problem(413, "OCI response exceeds the supported size.");
    }
    chunks.push(item.value);
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(joined);
}

export class HttpOci implements OciBackend {
  readonly url: string;
  readonly repository: string;
  constructor(private readonly options: HttpOciOptions) {
    const url = new URL(options.url);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(options.allowHttp && url.protocol === "http:"))
    )
      throw new Error(
        "OCI URL must be an HTTPS origin (or explicitly allow HTTP for a private local registry).",
      );
    if (
      !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(
        options.repository,
      )
    )
      throw new Error("Invalid OCI repository path");
    this.url = url.origin;
    this.repository = options.repository;
  }

  private path(suffix: string) {
    return `${this.url}/v2/${this.repository}/${suffix}`;
  }

  private async request(
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    if (new URL(url).origin !== this.url)
      throw new Error("OCI refused a cross-origin request");
    const headers = new Headers(init.headers);
    if (this.options.authorization)
      headers.set("authorization", this.options.authorization);
    const res = await (this.options.fetch ?? fetch)(url, {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok && res.status !== 404)
      throw new Problem(
        502,
        `OCI registry returned HTTP ${res.status}. Check the registry connection and credentials.`,
      );
    return res;
  }

  /**
   * Blob reads may be redirected to object storage. Credentials are dropped the moment the
   * chain leaves the registry origin, and the destination must be an HTTPS host the operator
   * listed explicitly — a redirect is not permission to hand the registry's token to whoever
   * answered.
   */
  private async blobResponse(
    initial: string,
    method: "GET" | "HEAD" = "GET",
  ): Promise<Response> {
    let url = new URL(initial);
    let external = false;
    for (let hops = 0; hops < 5; hops++) {
      const headers = new Headers();
      if (!external && this.options.authorization)
        headers.set("authorization", this.options.authorization);
      const res = await (this.options.fetch ?? fetch)(url.href, {
        method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      if (![301, 302, 303, 307, 308].includes(res.status)) return res;
      const location = res.headers.get("location");
      if (!location)
        throw new Problem(502, "OCI blob redirect is missing its location.");
      const next = new URL(location, url);
      await res.body?.cancel();
      if (next.origin !== this.url) {
        if (
          next.protocol !== "https:" ||
          !(this.options.blobHosts ?? []).includes(next.hostname) ||
          next.username ||
          next.password
        )
          throw new Problem(
            502,
            "OCI blob redirects require an HTTPS host explicitly listed in OCI_BLOB_HOSTS.",
          );
        external = true;
      }
      url = next;
    }
    throw new Problem(502, "OCI blob redirect limit exceeded.");
  }

  async headBlob(digest: string): Promise<boolean> {
    const res = await this.blobResponse(this.path(`blobs/${digest}`), "HEAD");
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    throw new Error("Unexpected OCI blob response");
  }

  async putBlob(digest: string, text: string): Promise<void> {
    const begun = await this.request(this.path("blobs/uploads/"), {
      method: "POST",
    });
    const location = begun.headers.get("location");
    if (!location) throw new Error("OCI upload location missing");
    const url = new URL(location, this.url);
    if (url.origin !== this.url)
      throw new Error("OCI upload location has a different origin");
    url.searchParams.set("digest", digest);
    const response = await this.request(url.href, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: text,
    });
    if (response.status !== 201)
      throw new Error("OCI blob upload did not complete");
  }

  async getBlob(digest: string, limit: number): Promise<string> {
    const res = await this.blobResponse(this.path(`blobs/${digest}`));
    if (!res.ok) throw new Problem(404, "OCI artifact was not found.");
    return readBounded(res, limit);
  }

  async headManifest(reference: string): Promise<boolean> {
    const res = await this.request(this.path(`manifests/${reference}`), {
      method: "HEAD",
      headers: { accept: "application/vnd.oci.image.manifest.v1+json" },
    });
    return res.ok;
  }

  async putManifest(
    tag: string,
    text: string,
    mediaType: string,
  ): Promise<void> {
    const response = await this.request(this.path(`manifests/${tag}`), {
      method: "PUT",
      headers: { "content-type": mediaType },
      body: text,
    });
    if (response.status !== 201)
      throw new Error("OCI manifest publication did not complete");
  }

  async getManifest(
    reference: string,
    limit: number,
  ): Promise<string | null> {
    const res = await this.request(this.path(`manifests/${reference}`), {
      headers: { accept: "application/vnd.oci.image.manifest.v1+json" },
    });
    if (!res.ok) return null;
    return readBounded(res, limit);
  }

  async listTags(): Promise<string[]> {
    let url: string | null = this.path("tags/list?n=100");
    const tags: string[] = [];
    const seen = new Set<string>();
    while (url) {
      if (seen.has(url) || seen.size >= 20)
        throw new Error("OCI tag pagination exceeded its limit");
      seen.add(url);
      const response: Response = await this.request(url);
      if (response.status === 404) return [];
      const page = JSON.parse(await readBounded(response, 8_000_000)) as {
        tags: string[] | null;
      };
      tags.push(...(page.tags ?? []));
      const next = response.headers
        .get("link")
        ?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      url = next ? new URL(next, this.url).href : null;
    }
    return tags;
  }
}
