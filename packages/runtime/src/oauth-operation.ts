/**
 * Publication-bound OAuth operation gate.
 *
 * Only an AuthHost that has independently verified a real OAuth access token
 * may populate VerifiedOAuthAccess. This is a *trusted runtime fact*, not a
 * serialized client payload, a JWT decoder, or an agent's claim about itself.
 */
import {err, type ForgeError} from "./errors.js";
import type {ValidatedApiPublication} from "./api-publication.js";

export interface VerifiedOAuthAccess {
  readonly tokenType: "access-token";
  readonly issuer: string;
  readonly audiences: readonly string[];
  readonly scopes: readonly string[];
  readonly clientId: string;
  /** Unix epoch milliseconds from a verified access token / introspection. */
  readonly expiresAt: number;
}

export function checkPublishedOAuth(
  publication: ValidatedApiPublication,
  operationId: string,
  access: VerifiedOAuthAccess | undefined,
  now = Date.now(),
): ForgeError | null {
  const rule = publication.operations?.[operationId];
  if (!rule) return err("NotPermitted", "unreviewed_operation");
  if (rule.visibility === "private") return err("NotPermitted", "private_operation");
  if (rule.visibility === "public") return null;
  if (rule.visibility !== "oauth2" || !rule.scopes.length) return err("NotPermitted", "invalid_security_publication");
  if (!access || access.tokenType !== "access-token" || !access.clientId || access.clientId.length > 512 ||
      !publication.authorizationServers.includes(access.issuer) ||
      !Array.isArray(access.audiences) || !access.audiences.includes(publication.resource) ||
      !Array.isArray(access.scopes) || !Number.isSafeInteger(access.expiresAt) || access.expiresAt <= now) {
    return err("Unauthenticated", "valid audience-bound OAuth access token required");
  }
  if (!rule.scopes.every(scope => access.scopes.includes(scope))) return err("NotPermitted", "insufficient_scope");
  return null;
}
