/** Compiler-visible external functions; trusted composition supplies providers. */
import type { ExternalBinding, ExternalResult } from "./functions.js";
import type {
  VersionedArtifactReader,
  ArtifactRevisionPin,
} from "./versioned-artifacts.js";
import type {
  ArtifactPublisher,
  ArtifactPublicationRequest,
} from "./artifact-publication.js";
import { ForgeError, err } from "./errors.js";

const prefix = "@forgegraph/versioned-artifacts/_/";
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw err("ValidationFailed");
  return input as Record<string, unknown>;
}
function text(input: unknown): string {
  if (typeof input !== "string") throw err("ValidationFailed");
  return input;
}
function pin(input: unknown): ArtifactRevisionPin {
  const p = record(input);
  if (p.objectFormat !== "sha1" && p.objectFormat !== "sha256")
    throw err("ValidationFailed");
  return {
    tenant: text(p.tenant),
    artifact: text(p.artifact),
    generation: text(p.generation),
    repositoryId: text(p.repositoryId),
    objectFormat: p.objectFormat,
    oid: text(p.oid),
    tree: text(p.tree),
  };
}
function publication(input: unknown): ArtifactPublicationRequest {
  const p = record(input);
  // Missing expected is invalid: creating a ref requires explicit null.
  return {
    key: text(p.key),
    ref: text(p.ref),
    expected: p.expected === null ? null : text(p.expected),
    revision: pin(p.revision),
  };
}
/** External calls return only typed error codes, never provider messages. The
 * Engine does not decode external dependency inputs, so validate at this boundary. */
export function artifactFunctionBindings(services: {
  reader?: VersionedArtifactReader;
  publisher?: ArtifactPublisher;
}): Record<string, ExternalBinding> {
  const { reader, publisher } = services;
  const wrap =
    (f: ExternalBinding): ExternalBinding =>
    async (input, ctx): Promise<ExternalResult> => {
      try {
        return await f(input, { ...ctx });
      } catch (error) {
        return {
          ok: false,
          code:
            error instanceof ForgeError ? error.code : "DependencyUnavailable",
        };
      }
    };
  return {
    [prefix + "Resolve"]: wrap(async (input, ctx) => {
      if (!reader) return { ok: false, code: "DependencyUnavailable" };
      const p = record(input);
      return {
        ok: true,
        value: await reader.resolve(text(p.artifact), text(p.selector), ctx),
      };
    }),
    [prefix + "ReadFile"]: wrap(async (input, ctx) => {
      if (!reader) return { ok: false, code: "DependencyUnavailable" };
      const p = record(input),
        maxBytes = p.maxBytes;
      if (
        typeof maxBytes !== "number" ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > 1048576
      )
        throw err("ValidationFailed");
      const file = await reader.readFile(pin(p.revision), text(p.path), ctx, {
        maxBytes,
      });
      // Web-standard encoding also works in Workers; no Node Buffer dependency.
      let binary = "";
      for (const byte of file.bytes) binary += String.fromCharCode(byte);
      if (file.mediaType.length > 1024) throw err("ValidationFailed");
      return {
        ok: true,
        value: { base64: btoa(binary), mediaType: file.mediaType },
      };
    }),
    ...Object.fromEntries(
      (["Publish", "Recover"] as const).map((name) => [
        prefix + name,
        wrap(async (input, ctx) => {
          if (!publisher) return { ok: false, code: "DependencyUnavailable" };
          const request = publication(input);
          const receipt = await (name === "Publish"
            ? publisher.publish(request, ctx)
            : publisher.recover(request, ctx));
          return { ok: true, value: { outcome: receipt.outcome } };
        }),
      ]),
    ),
  };
}
