import {
  canonical,
  digestOf,
  MemoryArtifactStore,
  Registry,
  type Signer,
  type Signature,
  type Pulled,
} from "@forgegraph/registry/artifacts";
import { entryFrom, type PackageEntry } from "@forgegraph/registry/catalog";
import type { AppBundle, CapabilitiesPlan, DataClassDecl, PurposeDecl } from "@forgegraph/runtime";
import { Problem } from "./model.js";
const MEDIA = "application/vnd.oci.image.manifest.v1+json";
const TYPE = "application/vnd.forgegraph.package.v1";
interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
}
interface Manifest {
  schemaVersion: number;
  mediaType: string;
  artifactType: string;
  config: Descriptor;
  layers: Descriptor[];
  annotations: Record<string, string>;
}
export interface PackageSummary {
  ociDigest: string;
  entry: PackageEntry;
  governance: {
    dataSemantics: AppBundle["dataSemantics"] | null;
    dataClasses: DataClassDecl[];
    purposes: PurposeDecl[];
    surfaces: CapabilitiesPlan["surfaces"];
  };
}
function governanceFrom(bundle: AppBundle): PackageSummary["governance"] {
  return {
    dataSemantics: bundle.dataSemantics ?? null,
    dataClasses: bundle.ir.modules.flatMap(m => m.dataClasses ?? []),
    purposes: bundle.ir.modules.flatMap(m => m.purposes ?? []),
    surfaces: (bundle as AppBundle & { capabilities?: CapabilitiesPlan }).capabilities?.surfaces ?? [],
  };
}
export interface PublishInput {
  name: string;
  version: string;
  bundle: AppBundle;
  owner: string;
  commit: string;
}
export interface OciOptions {
  url: string;
  repository: string;
  authority: string;
  signer: Signer;
  authorization?: string;
  blobHosts?: string[];
  allowHttp?: boolean;
  fetch?: typeof fetch;
}
const bytes = (text: string) => new TextEncoder().encode(text).length;
export class OciRegistry {
  readonly url: string;
  readonly repository: string;
  constructor(private readonly options: OciOptions) {
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
  private async text(res: Response, limit = 8_000_000): Promise<string> {
    if (!res.ok) throw new Problem(404, "OCI artifact was not found.");
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
  private descriptor(text: string, mediaType: string): Descriptor {
    return { mediaType, digest: digestOf(text), size: bytes(text) };
  }
  private async upload(text: string, mediaType: string): Promise<Descriptor> {
    const desc = this.descriptor(text, mediaType);
    const exists = await this.blobResponse(
      this.path(`blobs/${desc.digest}`),
      "HEAD",
    );
    if (exists.status === 200) return desc;
    if (exists.status !== 404) throw new Error("Unexpected OCI blob response");
    const begun = await this.request(this.path("blobs/uploads/"), {
      method: "POST",
    });
    const location = begun.headers.get("location");
    if (!location) throw new Error("OCI upload location missing");
    const url = new URL(location, this.url);
    if (url.origin !== this.url)
      throw new Error("OCI upload location has a different origin");
    url.searchParams.set("digest", desc.digest);
    const response = await this.request(url.href, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: text,
    });
    if (response.status !== 201)
      throw new Error("OCI blob upload did not complete");
    return desc;
  }
  private registry(store: MemoryArtifactStore) {
    const { authority, signer } = this.options;
    return new Registry({
      authority,
      store,
      trust: { authority, signers: { [signer.keyId]: signer.publicKey } },
    });
  }
  async publish(
    input: PublishInput,
    reserve?: (key: string) => Promise<boolean>,
  ): Promise<PackageSummary> {
    Registry.checkSchema(input.bundle);
    // Hash the qualified package/version into an OCI-compatible discovery tag; human names remain signed metadata.
    const tag = `forge-${digestOf(`${input.name}\n${input.version}`).slice(7)}`;
    const prior = await this.request(this.path(`manifests/${tag}`), {
      method: "HEAD",
      headers: { accept: MEDIA },
    });
    if (prior.ok)
      throw new Problem(
        409,
        "This package version is already published. Publish a new version.",
      );
    const store = new MemoryArtifactStore(),
      registry = this.registry(store);
    const published = await registry.publish({
      name: input.name,
      version: input.version,
      bundle: input.bundle,
      signer: this.options.signer,
      provenance: {
        owner: input.owner,
        commit: input.commit,
        builder: "forge-console",
        built_at: new Date().toISOString(),
      },
    });
    // Derive the catalog before any publication, ensuring the bundle can actually be interpreted.
    const pulled = await registry.pull(published.digest);
    const entry = entryFrom(this.options.authority, pulled);
    const reservation = digestOf(
      `${this.url}/${this.repository}\n${this.options.authority}\n${input.name}\n${input.version}`,
    );
    const layers: Descriptor[] = [];
    for (const [digest, text] of store.blobs)
      layers.push(
        await this.upload(
          text,
          digest === published.digest
            ? "application/vnd.forgegraph.manifest.v1+json"
            : "application/vnd.forgegraph.layer.v1+json",
        ),
      );
    const config = await this.upload(
      canonical({
        version: "forge-oci/1",
        manifest: published.digest,
        signature: await store.getSignature(published.digest),
      }),
      "application/vnd.forgegraph.config.v1+json",
    );
    const manifest: Manifest = {
      schemaVersion: 2,
      mediaType: MEDIA,
      artifactType: TYPE,
      config,
      layers,
      annotations: {
        "org.opencontainers.image.title": input.name,
        "org.opencontainers.image.version": input.version,
        "org.opencontainers.image.revision": input.commit,
      },
    };
    const text = canonical(manifest);
    if (reserve && !(await reserve(reservation)))
      throw new Problem(
        409,
        "This package version is already published or has a pending publication. Inspect OCI before releasing a failed reservation.",
      );
    const response = await this.request(this.path(`manifests/${tag}`), {
      method: "PUT",
      headers: { "content-type": MEDIA },
      body: text,
    });
    if (response.status !== 201)
      throw new Error("OCI manifest publication did not complete");
    return { ociDigest: digestOf(text), entry, governance: governanceFrom(pulled.bundle) };
  }
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
  private async blob(desc: Descriptor): Promise<string> {
    if (
      !/^sha256:[a-f0-9]{64}$/.test(desc.digest) ||
      !Number.isSafeInteger(desc.size) ||
      desc.size < 0 ||
      desc.size > 8_000_000
    )
      throw new Error("Invalid OCI descriptor");
    const text = await this.text(
      await this.blobResponse(this.path(`blobs/${desc.digest}`)),
    );
    if (bytes(text) !== desc.size || digestOf(text) !== desc.digest)
      throw new Error("OCI blob digest or size mismatch");
    return text;
  }
  async pull(reference: string): Promise<PackageSummary & { pulled: Pulled }> {
    if (
      !/^sha256:[a-f0-9]{64}$/.test(reference) &&
      !/^forge-[a-f0-9]{64}$/.test(reference)
    )
      throw new Problem(400, "Invalid OCI manifest reference");
    const text = await this.text(
      await this.request(this.path(`manifests/${reference}`), {
        headers: { accept: MEDIA },
      }),
    );
    const ociDigest = digestOf(text);
    if (reference.startsWith("sha256:") && ociDigest !== reference)
      throw new Error("OCI manifest digest mismatch");
    const manifest = JSON.parse(text) as Manifest;
    if (
      manifest.schemaVersion !== 2 ||
      manifest.mediaType !== MEDIA ||
      manifest.artifactType !== TYPE ||
      !Array.isArray(manifest.layers) ||
      manifest.layers.length > 8
    )
      throw new Error("Unsupported OCI Forge manifest");
    const config = JSON.parse(await this.blob(manifest.config)) as {
      version: string;
      manifest: string;
      signature: Signature;
    };
    if (config.version !== "forge-oci/1")
      throw new Error("Unsupported Forge OCI config");
    const store = new MemoryArtifactStore();
    for (const layer of manifest.layers)
      await store.putBlob(layer.digest, await this.blob(layer));
    await store.putSignature(config.manifest, config.signature);
    const pulled = await this.registry(store).pull(config.manifest);
    return {
      ociDigest,
      entry: entryFrom(this.options.authority, pulled),
      governance: governanceFrom(pulled.bundle),
      pulled,
    };
  }
  async list(): Promise<PackageSummary[]> {
    let url: string | null = this.path("tags/list?n=100");
    const tags: string[] = [];
    const seen = new Set<string>();
    while (url) {
      if (seen.has(url) || seen.size >= 20)
        throw new Error("OCI tag pagination exceeded its limit");
      seen.add(url);
      const response = await this.request(url);
      if (response.status === 404) return [];
      const page = JSON.parse(await this.text(response)) as {
        tags: string[] | null;
      };
      tags.push(
        ...(page.tags ?? []).filter((t) => /^forge-[a-f0-9]{64}$/.test(t)),
      );
      const next = response.headers
        .get("link")
        ?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      url = next ? new URL(next, this.url).href : null;
    }
    const results: PackageSummary[] = [];
    // Bounded parallelism: no unbounded fan-out against an independently hosted registry.
    for (let i = 0; i < tags.length; i += 4)
      results.push(
        ...(await Promise.all(
          tags.slice(i, i + 4).map(async (tag) => {
            const { entry, ociDigest, governance } = await this.pull(tag);
            return { entry, ociDigest, governance };
          }),
        )),
      );
    return results.sort((a, b) => a.entry.id.localeCompare(b.entry.id));
  }
}
