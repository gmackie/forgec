declare module "js-yaml" {
  export function load(input: string): unknown;
  export function dump(value: unknown): string;
}
