/** Application-owned credentials mapped to a deployment-owned workspace. */
import type { AuthHost, Principal } from "./http.js";
import { err } from "./errors.js";

export interface WorkspaceMembership {
  actor: string;
  workspaceId: string;
  active: boolean;
  /** Explicit invocation purposes granted by the application's policy. */
  purposes: string[];
}
export interface VerifiedApiToken {
  actor: string;
  workspaceId: string;
  expiresAt: Date | string | number;
  revoked: boolean;
  purposes: string[];
}
export interface ApplicationSession {
  user: { id: string };
  session: { userId: string; expiresAt: Date | string | number };
}
export interface WorkspaceAuthOptions {
  /** Trusted deployment configuration, never a request header/query parameter. */
  workspaceId: string;
  issuer: string;
  workload?: string;
  /** Lookup current membership on every invocation, including API token calls. */
  membership(actor: string, workspaceId: string): Promise<WorkspaceMembership | null>;
  /** Compatible with auth.api.getSession; bypass signed cookie session caches. */
  getSession?: (input: { headers: Headers; query: { disableCookieCache: true } }) => Promise<ApplicationSession | null>;
  /** Allowed browser origins for session-authenticated writes; and WebSocket upgrades. */
  sessionOrigins?: readonly string[];
  /** Must verify the opaque token/hash against the authoritative application store. */
  verifyApiToken?: (token: string) => Promise<VerifiedApiToken | null>;
  /** Milliseconds since epoch; injectable for deterministic tests. */
  now?: () => number;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function purposes(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonempty);
}
function unexpired(value: Date | string | number, now: number): boolean {
  const expiry = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(now) && Number.isFinite(expiry) && expiry > now;
}

/** Portable Fetch AuthHost for Node and Workers; explicit bearer never falls back to cookies. */
export function workspaceAuth(options: WorkspaceAuthOptions): AuthHost {
  if (!nonempty(options.workspaceId) || !nonempty(options.issuer)) throw new Error("workspace and issuer are required");
  // Capture immutable deployment identity; application callbacks remain authoritative.
  const { workspaceId, issuer, workload } = options;
  const origins = [...(options.sessionOrigins ?? [])];
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) throw new Error("session origins must be exact HTTP(S) origins");
  }
  return {
    scheme: "application-session-or-bearer",
    async authenticate(request) {
      try {
        const now = () => (options.now ?? Date.now)();
        let expiresAt: Date | string | number;
        let actor: string;
        let tokenPurposes: string[] | undefined;
        const authorization = request.headers.get("authorization");
        if (authorization !== null) {
          const bearer = /^Bearer ([^\s,]+)$/i.exec(authorization);
          if (!bearer || !options.verifyApiToken || bearer[1]!.length > 8192) return err("Unauthenticated", "valid credentials are required");
          const token = await options.verifyApiToken(bearer[1]!);
          if (!token || !nonempty(token.actor) || token.revoked !== false || !unexpired(token.expiresAt, now()) || !purposes(token.purposes)) return err("Unauthenticated", "valid credentials are required");
          if (token.workspaceId !== workspaceId) return err("Forbidden", "credential does not authorize this workspace");
          expiresAt = token.expiresAt;
          actor = token.actor;
          tokenPurposes = token.purposes;
        } else {
          if ((!["GET", "HEAD", "OPTIONS"].includes(request.method) || request.headers.get("upgrade")?.toLowerCase() === "websocket") && !origins.includes(request.headers.get("origin") ?? "")) return err("Forbidden", "trusted session origin is required");
          const cookie = request.headers.get("cookie");
          if (!cookie || cookie.length > 16384 || !options.getSession) return err("Unauthenticated", "valid credentials are required");
          // Only the credential is forwarded. Caller-selected workspace, user and role headers cannot influence session lookup.
          const session = await options.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true } });
          if (!session || !nonempty(session.user.id) || session.session.userId !== session.user.id || !unexpired(session.session.expiresAt, now())) return err("Unauthenticated", "valid credentials are required");
          expiresAt = session.session.expiresAt;
          actor = session.user.id;
        }
        const membership = await options.membership(actor, workspaceId);
        if (!membership || membership.active !== true || membership.actor !== actor || membership.workspaceId !== workspaceId || !purposes(membership.purposes)) return err("Forbidden", "active workspace membership is required");
        if (!unexpired(expiresAt, now())) return err("Unauthenticated", "valid credentials are required");
        const allowed = tokenPurposes === undefined ? membership.purposes : membership.purposes.filter(p => tokenPurposes.includes(p));
        const principal: Principal = { tenant: workspaceId, actor, issuer, purposes: [...new Set(allowed)], ...(workload === undefined ? {} : { workload }) };
        return principal;
      } catch {
        // Provider errors may contain credentials or database details. Never propagate them.
        return err("Unauthenticated", "credential verification failed");
      }
    },
  };
}
