export function completeSuite(report: unknown): boolean;
export function currentScenarios(report: unknown, ids: string[]): boolean;
export function verifyEndpointBuild(url: string, expected: string, fetcher?: typeof fetch): Promise<string>;
