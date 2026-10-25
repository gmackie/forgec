/**
 * The portable error taxonomy (specs/portable-profile/errors.md). One class,
 * one `code`; HTTP status and retryability derive from the code.
 */
import { Data } from "effect";

export interface ProblemField {
  path: string;
  code: string;
  message: string;
}

export const ERROR_STATUS: Record<string, { status: number; retryable: boolean; title: string }> = {
  MalformedRequest: { status: 400, retryable: false, title: "Malformed request" },
  Unauthenticated: { status: 401, retryable: false, title: "Unauthenticated" },
  Forbidden: { status: 403, retryable: false, title: "Forbidden" },
  NotFound: { status: 404, retryable: false, title: "Not found" },
  MethodNotAllowed: { status: 405, retryable: false, title: "Method not allowed" },
  SequenceExhausted: { status: 409, retryable: false, title: "Sequence exhausted" },
  SequencePreviewUnsupported: { status: 422, retryable: false, title: "Sequence preview unsupported" },
  ValidationFailed: { status: 422, retryable: false, title: "Validation failed" },
  UnknownField: { status: 422, retryable: false, title: "Unknown field" },
  PreconditionRequired: { status: 428, retryable: false, title: "Precondition required" },
  VersionConflict: { status: 412, retryable: false, title: "Version conflict" },
  PreconditionContradiction: { status: 400, retryable: false, title: "Precondition contradiction" },
  UniqueConflict: { status: 409, retryable: false, title: "Unique conflict" },
  ReferenceMissing: { status: 422, retryable: false, title: "Reference missing" },
  HasDependents: { status: 409, retryable: false, title: "Has dependents" },
  InvalidTransition: { status: 409, retryable: false, title: "Invalid transition" },
  AlreadyDeleted: { status: 409, retryable: false, title: "Already deleted" },
  NotDeleted: { status: 409, retryable: false, title: "Not deleted" },
  IdempotencyMismatch: { status: 409, retryable: false, title: "Idempotency mismatch" },
  InvalidCursor: { status: 400, retryable: false, title: "Invalid cursor" },
  BudgetExceeded: { status: 422, retryable: false, title: "Budget exceeded" },
  ProjectionNotReady: { status: 503, retryable: true, title: "Projection not ready" },
  NotPermitted: { status: 403, retryable: false, title: "Not permitted" },
  CapabilityDenied: { status: 403, retryable: false, title: "Capability denied" },
  InspectionPending: { status: 409, retryable: true, title: "Content inspection pending" },
  InspectionBlocked: { status: 403, retryable: false, title: "Content blocked by inspection" },
  WriteFenced: { status: 503, retryable: true, title: "Writes fenced" },
  Suppressed: { status: 410, retryable: false, title: "Subject suppressed" },
  WorkflowVersionMismatch: { status: 409, retryable: false, title: "Workflow version mismatch" },
  PayloadTooLarge: { status: 413, retryable: false, title: "Payload too large" },
  RateLimited: { status: 429, retryable: true, title: "Rate limited" },
  TransientConflict: { status: 503, retryable: true, title: "Transient conflict" },
  StorageUnavailable: { status: 503, retryable: true, title: "Storage unavailable" },
  DeliveryOutcomeUnknown: { status: 409, retryable: false, title: "Delivery outcome unknown" },
  DependencyUnavailable: { status: 503, retryable: true, title: "Dependency unavailable" },
  Internal: { status: 500, retryable: false, title: "Internal error" },
};

/** The status of a declared domain error without a `status` clause. */
const DEFAULT_DECLARED_STATUS = 409;

export class ForgeError extends Data.TaggedError("ForgeError")<{
  code: string;
  detail?: string;
  fields?: ProblemField[];
  constraint?: string;
  /** Structured, provider-specific detail (e.g. the physical atomic budget); never free text. */
  budget?: Record<string, number>;
  /** `CapabilityDenied` only: what the gate refused and where. */
  denial?: CapabilityDenial;
  /** Declared domain errors only: the status the declaration chose (`Name status 422`, FORG-44). */
  declaredStatus?: number;
}> {
  /** Declared domain errors (`<function id>.<Name>`) are 409 unless declared otherwise. */
  get status(): number {
    return ERROR_STATUS[this.code]?.status ?? (this.code.includes("/") ? (this.declaredStatus ?? DEFAULT_DECLARED_STATUS) : 500);
  }
  get retryable(): boolean {
    return ERROR_STATUS[this.code]?.retryable ?? false;
  }
  /** RFC 9457 body with the stable Forge extensions. */
  problem(requestId: string): Record<string, unknown> {
    const meta = ERROR_STATUS[this.code] ?? (this.code.includes("/") ? { status: this.status, retryable: false, title: this.code.split(".").pop() ?? this.code } : ERROR_STATUS["Internal"]!);
    return {
      type: this.code.includes("/") ? `urn:forge:error:${this.code}` : `https://forge.dev/errors/${kebab(this.code)}`,
      title: meta.title,
      status: meta.status,
      code: this.code,
      ...(this.detail ? { detail: this.detail } : {}),
      requestId,
      retryable: meta.retryable,
      ...(this.fields ? { fields: this.fields } : {}),
      ...(this.constraint ? { constraint: this.constraint } : {}),
      ...(this.budget ? { budget: this.budget } : {}),
      ...(this.denial ? { capability: this.denial.capability, ...(this.denial.unit ? { unit: this.denial.unit } : {}), ...(this.denial.entryPoint ? { entryPoint: this.denial.entryPoint } : {}) } : {}),
    };
  }
}

function kebab(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

export const err = (code: string, detail?: string, extra: { fields?: ProblemField[]; constraint?: string; budget?: Record<string, number> } = {}) =>
  new ForgeError({ code, ...(detail !== undefined ? { detail } : {}), ...extra });

/**
 * A capability gate's refusal (FORG-34): the closure was linked without the capability it reached
 * for. `capability` names it in Closure Manifest terms where the gate can (`resource:<id>#write`,
 * `binding:<type>:<name>`, `egress:<origin>`); `unit` and `entryPoint` say who reached, when known.
 */
export interface CapabilityDenial {
  capability: string;
  unit?: string;
  entryPoint?: string;
  detail?: string;
}

const DENIAL_MARK = "forge.capability-denied:";

const denialDetail = (d: CapabilityDenial) => d.detail ?? `${d.capability} is not granted to ${d.entryPoint ?? d.unit ?? "this closure"}`;

/** The 403 `CapabilityDenied` error for a denial. */
export function capabilityDenied(d: CapabilityDenial): ForgeError {
  const denial: CapabilityDenial = { capability: d.capability, ...(d.unit ? { unit: d.unit } : {}), ...(d.entryPoint ? { entryPoint: d.entryPoint } : {}) };
  return new ForgeError({ code: "CapabilityDenied", detail: denialDetail(d), denial });
}

/**
 * What a gate throws. A Workers RPC hop keeps only an error's message, and adapters may prefix it,
 * so the denial travels in the message, after the readable detail; `asCapabilityDenied` recovers it.
 */
export function capabilityDeniedError(d: CapabilityDenial): Error {
  const e = new Error(`${denialDetail(d)} ${DENIAL_MARK}${JSON.stringify(d)}`);
  e.name = "CapabilityDenied";
  return e;
}

/** The `CapabilityDenied` error `e` carries (thrown by a gate, possibly across RPC), or null. */
export function asCapabilityDenied(e: unknown): ForgeError | null {
  if (e instanceof ForgeError) return e.code === "CapabilityDenied" ? e : null;
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : null;
  const at = msg?.indexOf(DENIAL_MARK) ?? -1;
  if (!msg || at < 0) return null;
  const rest = msg.slice(at + DENIAL_MARK.length);
  for (let end = rest.lastIndexOf("}"); end > 0; end = rest.lastIndexOf("}", end - 1)) {
    try {
      const d = JSON.parse(rest.slice(0, end + 1)) as Partial<CapabilityDenial>;
      if (typeof d.capability === "string") return capabilityDenied({ capability: d.capability, ...(typeof d.unit === "string" ? { unit: d.unit } : {}), ...(typeof d.entryPoint === "string" ? { entryPoint: d.entryPoint } : {}), ...(typeof d.detail === "string" ? { detail: d.detail } : {}) });
    } catch {
      // not the end of the encoded denial; try an earlier brace
    }
  }
  return capabilityDenied({ capability: "unknown" });
}

/** Maps a provider failure: a gate's denial stays a denial, anything else is `fallback`. */
export const deniedOr = (e: unknown, fallback: () => ForgeError): ForgeError => asCapabilityDenied(e) ?? fallback();
