import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSigner } from '../../packages/registry/dist/artifacts.js';
import { signManifest, verifyManifest } from '../release-signature.mjs';

test('release evidence binds every manifest field to the configured authority', async () => {
  const signer = await generateSigner('test');
  const trust = {authority:'test.invalid',signers:{test:signer.publicKey}};
  const manifest = {version:'release-manifest/1', generatedAt:new Date().toISOString(), allRequiredProfilesCertified:true, identity:{buildHash:'abc'}, combinations:[{profile:'test',status:'certified',evidence:[{suite:'test',at:new Date().toISOString(),scenarios:15}]}]};
  const evidence = await signManifest(manifest, signer, trust.authority);
  assert.equal((await verifyManifest(manifest,evidence,trust)).ok,true);
  assert.equal((await verifyManifest({...manifest,pins:{changed:true}},evidence,trust)).ok,false);
  assert.equal((await verifyManifest(manifest,evidence,{...trust,authority:'other'})).ok,false);
  assert.equal((await verifyManifest(manifest,evidence,{...trust,signers:{}})).ok,false);
  await assert.rejects(signManifest({...manifest,allRequiredProfilesCertified:false},signer,trust.authority),/incomplete/);
});
