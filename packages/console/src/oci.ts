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
import { HttpOci, type OciBackend } from "./oci-backend.js";
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
  /** Supply a backend directly, or the HTTP fields below to build the default one. */
  backend?: OciBackend;
  url?: string;
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
  private readonly backend: OciBackend;
  constructor(private readonly options: OciOptions) {
    this.backend =
      options.backend ??
      new HttpOci({
        url: options.url ?? "",
        repository: options.repository,
        ...(options.authorization
          ? { authorization: options.authorization }
          : {}),
        ...(options.blobHosts ? { blobHosts: options.blobHosts } : {}),
        ...(options.allowHttp !== undefined
          ? { allowHttp: options.allowHttp }
          : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    this.url = this.backend.url;
    this.repository = this.backend.repository;
  }
  private descriptor(text: string, mediaType: string): Descriptor {
    return { mediaType, digest: digestOf(text), size: bytes(text) };
  }
  private async upload(text: string, mediaType: string): Promise<Descriptor> {
    const desc = this.descriptor(text, mediaType);
    if (await this.backend.headBlob(desc.digest)) return desc;
    await this.backend.putBlob(desc.digest, text);
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
    if (await this.backend.headManifest(tag))
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
    await this.backend.putManifest(tag, text, MEDIA);
    return { ociDigest: digestOf(text), entry, governance: governanceFrom(pulled.bundle) };
  }
  private async blob(desc: Descriptor): Promise<string> {
    if (
      !/^sha256:[a-f0-9]{64}$/.test(desc.digest) ||
      !Number.isSafeInteger(desc.size) ||
      desc.size < 0 ||
      desc.size > 8_000_000
    )
      throw new Error("Invalid OCI descriptor");
    const text = await this.backend.getBlob(desc.digest, 8_000_000);
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
    const text = await this.backend.getManifest(reference, 8_000_000);
    if (text === null) throw new Problem(404, "OCI artifact was not found.");
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
    // Foreign tags in a shared repository are ignored rather than treated as failures.
    const tags = (await this.backend.listTags()).filter((t) =>
      /^forge-[a-f0-9]{64}$/.test(t),
    );
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
