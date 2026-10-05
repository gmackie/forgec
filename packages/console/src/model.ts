export interface Environment {
  id: string;
  name: string;
  target: "cloudflare" | "docker" | "aws" | "other";
  endpoint: string;
  packageDigest: string;
  config: Record<string, string>;
  secretRefs: Record<string, string>;
}
export interface App {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  environments: Environment[];
  updatedAt: string;
}
export interface Audit {
  id: string;
  at: string;
  action: string;
  subject: string;
  /** Who made the change. Optional so audit logs written before this existed still parse. */
  actor?: string;
}
export interface State {
  /** Storage version: every write increments it, including audit-only appends. */
  revision: number;
  /**
   * The app/environment configuration version clients send as `If-Match`. Only configuration
   * changes increment it, so recording an audit entry (e.g. issuing a registry credential) does
   * not make an editor in another tab look stale. Absent in states written before it existed.
   */
  configRevision?: number;
  apps: App[];
  audit: Audit[];
}
export const configRevision = (state: State): number => state.configRevision ?? state.revision;
export const emptyState = (): State => ({ revision: 0, apps: [], audit: [] });
export interface StateStore {
  reservePublication(key: string): Promise<boolean>;
  read(): Promise<State>;
  save(expected: number, next: State): Promise<boolean>;
}
export interface Instance {
  name: string;
  authority: string;
  runtime: string;
  registry: { url: string; repository: string } | null;
  /** How operators sign in. The UI describes the instance honestly from this. */
  authMode?: "token" | "cloudflare-access";
  /** Whose sign-in, when it is delegated. */
  identityAuthority?: string | null;
}
export interface ViewState extends State {
  instance: Instance;
}
export class Problem extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function stateText(next: State): string {
  const text = JSON.stringify(next);
  if (new TextEncoder().encode(text).length > 900_000)
    throw new Problem(
      413,
      "Instance configuration exceeds 900 KB. Archive unused data or migrate storage.",
    );
  return text;
}
