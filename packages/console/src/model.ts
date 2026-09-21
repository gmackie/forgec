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
}
export interface State {
  revision: number;
  apps: App[];
  audit: Audit[];
}
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
