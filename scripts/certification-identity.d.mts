export interface CertificationIdentity { buildHash: string; sourceFingerprint: string; node: string; scenarioIds: string[] }
export function certificationIdentity(root: string): CertificationIdentity;
export function lockedVersion(root: string, importer: string, name: string): string | null;
