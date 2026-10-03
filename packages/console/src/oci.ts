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
import {
  PLAYGROUND_BYTES,
  PLAYGROUND_MEDIA,
  parsePlayground,
  type PlaygroundAttachment,
  type PlaygroundDocument,
} from "./playground-document.js";
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
  /** Unsigned draft layer. Omitted publishes keep the previous five-or-six layer manifest. */
  playground?: PlaygroundAttachment | undefined;
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

function playgroundText(bundle: AppBundle, input: PlaygroundAttachment): string {
  if (input.version !== "playground/1") throw new Problem(400, "Unsupported playground document.");
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 50) {
    throw new Problem(400, "Playground document is not a Forge draft.");
  }
  if (
    typeof input.name !== "string" ||
    typeof input.currentFile !== "string" ||
    !input.files.every((file) => file && typeof file.path === "string" && typeof file.text === "string" && file.path.length > 0 && file.path.length <= 500) ||
    !input.files.some((file) => file.path === input.currentFile)
  ) {
    throw new Problem(400, "Playground document is not a Forge draft.");
  }
  const document: PlaygroundDocument = {
    version: "playground/1",
    bundleDigest: digestOf(canonical(bundle)),
    name: input.name,
    currentFile: input.currentFile,
    files: input.files.map((file) => ({ path: file.path, text: file.text })),
    positions: (input.positions ?? []).flatMap((item) =>
      item &&
      typeof item.path === "string" &&
      typeof item.name === "string" &&
      Number.isFinite(item.x) &&
      Number.isFinite(item.y)
        ? [{ path: item.path, name: item.name, x: item.x, y: item.y }]
        : [],
    ),
    samples: (input.samples ?? []).flatMap((item) =>
      item && typeof item.path === "string" && typeof item.name === "string" && typeof item.clock === "string"
        ? [{ path: item.path, name: item.name, clock: item.clock, payload: item.payload ?? null }]
        : [],
    ),
  };
  const text = canonical(document);
  if (bytes(text) > PLAYGROUND_BYTES) {
    throw new Problem(400, "Playground document must be smaller than 8 MB.");
  }
  return text;
}
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
    const playground = input.playground ? playgroundText(input.bundle, input.playground) : null;
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
    // One extra unsigned layer. It is not named by the signed Forge manifest,
    // so a layout or sample change does not change the signed package digest.
    if (playground) layers.push(await this.upload(playground, PLAYGROUND_MEDIA));
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
  async pull(
    reference: string,
  ): Promise<PackageSummary & { pulled: Pulled; playground: PlaygroundDocument | null }> {
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
    let playground: PlaygroundDocument | null = null;
    for (const layer of manifest.layers) {
      if (layer.mediaType === PLAYGROUND_MEDIA) {
        // A missing, oversized, or damaged playground layer never blocks the signed package.
        try {
          if (layer.size <= PLAYGROUND_BYTES) {
            playground = parsePlayground(await this.blob(layer)) ?? playground;
          }
        } catch {
          playground = playground ?? null;
        }
        continue;
      }
      await store.putBlob(layer.digest, await this.blob(layer));
    }
    await store.putSignature(config.manifest, config.signature);
    const pulled = await this.registry(store).pull(config.manifest);
    return {
      ociDigest,
      entry: entryFrom(this.options.authority, pulled),
      governance: governanceFrom(pulled.bundle),
      pulled,
      playground,
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
