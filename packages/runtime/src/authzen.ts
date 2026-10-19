/**
 * AuthZEN Authorization API 1.0 PDP client for ForgeGraph's existing
 * Authorizer boundary. This adapter is deliberately opt-in and fail-closed.
 *
 * The PEP MUST authenticate callers before creating CallContext; this adapter
 * does not verify OAuth access tokens. PDP credentials are server-owned only.
 * The PDP must resolve resource/tenant facts authoritatively from the stable
 * resource identity below, not trust applicant-supplied policy attributes.
 */
import { Effect } from "effect";
import { err, type ForgeError } from "./errors.js";
import type { AuthzRequest, Authorizer, Decision } from "./gatekeeper.js";

export interface AuthzenAuthorizerOptions {
  /** Exact, reviewed HTTPS AuthZEN evaluation endpoint, not a discovery URL. */
  endpoint: string;
  /** Returns a server-held access token for the PDP; never supplied by the API caller. */
  credential: () => Promise<string>;
  /** Configuration revision, used for diagnostics only; live results are never cached. */
  epoch: number;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  /** Stable resource identifier used when no row ID exists. */
  resourceType?: string;
}

const urlIsSafe = (value: string) => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password ||
      url.hash || url.search || (value !== url.href && value !== url.origin)) {
    throw new Error("AuthZEN endpoint must be canonical HTTPS without credentials or query");
  }
  return url;
};

async function boundedDecision(response: Response): Promise<boolean> {
  if (response.status !== 200 || !/\bapplication\/json\b/i.test(response.headers.get("content-type") ?? "") ||
      response.redirected) throw new Error("AuthZEN transport or MIME mismatch");
  if (Number(response.headers.get("content-length") ?? 0) > 16384) throw new Error("oversized AuthZEN response");
  if (!response.body) throw new Error("missing AuthZEN response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) throw new Error("oversized AuthZEN response");
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      typeof (parsed as {decision?: unknown}).decision !== "boolean") {
    throw new Error("invalid AuthZEN decision");
  }
  // A positive response must not carry unimplemented obligations or advice.
  // AuthZEN 1.0 core decisions are boolean; future extensions require an
  // explicit, versioned handler, never silent admission.
  if ((parsed as {decision: boolean}).decision &&
      Object.keys(parsed).some(k => k !== "decision"))
    throw new Error("unsupported positive AuthZEN response extensions");
  return (parsed as {decision: boolean}).decision;
}

/** Standard AuthZEN evaluation client; no proprietary decision wire schema. */
export function authzenAuthorizer(options: AuthzenAuthorizerOptions): Authorizer {
  const endpoint = urlIsSafe(options.endpoint).href;
  if (!Number.isSafeInteger(options.epoch) || options.epoch < 0) throw new Error("invalid policy epoch");
  const timeoutMs = options.timeoutMs ?? 3000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) throw new Error("invalid PDP timeout");
  const fetcher = options.fetcher ?? fetch;
  return {
    epoch: options.epoch,
    knownObligations: [],
    liveAttributes: true,
    requirements: () => [],
    // Remote PDPs resolve their own authoritative record facts. Never
    // claim a row predicate can be pushed into a local query.
    rowFilterFor: () => null,
    decide(request: AuthzRequest): Effect.Effect<Decision, ForgeError> {
      return Effect.tryPromise({
        try: async () => {
          const id = request.current?.["id"] ?? request.candidate?.["id"];
          const resourceId = typeof id === "string" && id.length <= 512 ? id : request.action;
          const payload = {
            subject: {
              type: request.principal.workload ? "service" : "user",
              id: request.principal.actor,
              properties: {
                tenant: request.principal.tenant,
                ...(request.principal.issuer ? {issuer: request.principal.issuer} : {}),
              },
            },
            action: {name: request.action},
            resource: {
              type: options.resourceType ?? request.resource ?? "forge-operation",
              id: resourceId,
            },
            context: {
              tenant: request.principal.tenant,
              operation: request.action,
              kind: request.kind,
              ...(request.purpose ? {purpose: request.purpose} : {}),
            },
          };
          const credential = await options.credential();
          if (!credential || /[\r\n]/.test(credential)) throw new Error("missing server PDP credential");
          const response = await fetcher(endpoint, {
            method: "POST",
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
            headers: {"content-type": "application/json", accept: "application/json", authorization: "Bearer " + credential},
            body: JSON.stringify(payload),
          });
          if (response.url && response.url !== endpoint) throw new Error("unexpected PDP response origin");
          const allow = await boundedDecision(response);
          return {
            effect: allow ? "allow" : "deny",
            decisionId: crypto.randomUUID(),
            obligations: [],
            epoch: options.epoch,
            // No authorizer-side cache: a later call always consults PDP.
            expiresAt: new Date(Date.now() + 1000).toISOString(),
            ...(!allow ? {reason: "AuthZEN policy denied"} : {}),
          } satisfies Decision;
        },
        catch: () => err("DependencyUnavailable", "AuthZEN policy decision unavailable or invalid"),
      });
    },
  };
}
