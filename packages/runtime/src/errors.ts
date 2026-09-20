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
  PayloadTooLarge: { status: 413, retryable: false, title: "Payload too large" },
  RateLimited: { status: 429, retryable: true, title: "Rate limited" },
  TransientConflict: { status: 503, retryable: true, title: "Transient conflict" },
  StorageUnavailable: { status: 503, retryable: true, title: "Storage unavailable" },
  DependencyUnavailable: { status: 503, retryable: true, title: "Dependency unavailable" },
  Internal: { status: 500, retryable: false, title: "Internal error" },
};

export class ForgeError extends Data.TaggedError("ForgeError")<{
  code: string;
  detail?: string;
  fields?: ProblemField[];
  constraint?: string;
}> {
  /** Declared domain errors (`<function id>.<Name>`) are 409 unless declared otherwise. */
  get status(): number {
    return ERROR_STATUS[this.code]?.status ?? (this.code.includes("/") ? 409 : 500);
  }
  get retryable(): boolean {
    return ERROR_STATUS[this.code]?.retryable ?? false;
  }
  /** RFC 9457 body with the stable Forge extensions. */
  problem(requestId: string): Record<string, unknown> {
    const meta = ERROR_STATUS[this.code] ?? (this.code.includes("/") ? { status: 409, retryable: false, title: this.code.split(".").pop() ?? this.code } : ERROR_STATUS["Internal"]!);
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
    };
  }
}

function kebab(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

export const err = (code: string, detail?: string, extra: { fields?: ProblemField[]; constraint?: string } = {}) =>
  new ForgeError({ code, ...(detail !== undefined ? { detail } : {}), ...extra });
