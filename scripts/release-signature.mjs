import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digestOf } from '../packages/registry/dist/artifacts.js';
import { signEvidence, verifyEvidence } from '../packages/registry/dist/evidence.js';

export async function signManifest(manifest, signer, authority) {
  if (manifest.allRequiredProfilesCertified !== true || !manifest.combinations?.length || manifest.combinations.some(c => c.status !== 'certified')) throw new Error('Cannot sign an incomplete release manifest');
  const payload = {
    version: 'deployment-evidence/1', deployment: 'forgegraph-release',
    hashes: { build: manifest.identity.buildHash, contracts: digestOf(canonical(manifest.pins ?? {})), adapters: { releaseManifest: digestOf(canonical(manifest)) } },
    tests: manifest.combinations.map(c => ({ suite: 'release profile certification', profile: c.profile, passed: 1, failed: 0, skipped: 0, window: { from: manifest.generatedAt, to: manifest.generatedAt }, ref: 'RELEASE_MANIFEST.json' })),
    migrations: [], coverage: { telemetry: { from: manifest.generatedAt, to: manifest.generatedAt, emitted: 0, dropped: 0, sampledTraces: false } }, producedAt: new Date().toISOString(),
  };
  return signEvidence(payload, signer, authority);
}
export async function verifyManifest(manifest, evidence, trust) {
  const verified = await verifyEvidence(evidence, trust);
  if (!verified.ok) return verified;
  if (evidence.payload.hashes.adapters?.releaseManifest !== digestOf(canonical(manifest))) return { ok: false, reason: 'Manifest digest differs from signed evidence' };
  return { ok: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync('RELEASE_MANIFEST.json','utf8'));
  const trust = JSON.parse(readFileSync('conformance/certification/release-trust.json','utf8'));
  const path = 'conformance/certification/release-signature.json';
  if (process.argv.includes('--verify')) {
    const result = await verifyManifest(manifest, JSON.parse(readFileSync(path,'utf8')), trust);
    if (!result.ok) throw new Error(result.reason);
    console.log('Release manifest signature verified');
  } else {
    const jwk = JSON.parse(process.env.FORGE_RELEASE_SIGNING_JWK ?? 'null');
    delete process.env.FORGE_RELEASE_SIGNING_JWK;
    if (!jwk?.d || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') throw new Error('FORGE_RELEASE_SIGNING_JWK must reference a private Ed25519 JWK');
    const keyId = process.env.FORGE_RELEASE_SIGNING_KEY_ID ?? 'instance-v1';
    const privateKey = await crypto.subtle.importKey('jwk',jwk,{name:'Ed25519'},false,['sign']);
    const evidence = await signManifest(manifest,{keyId,privateKey,publicKey:trust.signers[keyId]},trust.authority);
    const verified = await verifyManifest(manifest,evidence,trust);
    if (!verified.ok) throw new Error(verified.reason);
    writeFileSync(path,JSON.stringify(evidence,null,2)+'\n');
    console.log('Signed release manifest with configured authority');
  }
}
