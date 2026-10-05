import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
const root = fileURLToPath(new URL('../../../packages/runtime/', import.meta.url));
const profiles = JSON.parse(readFileSync(new URL('./profiles.json', import.meta.url), 'utf8'));
const profile = process.env.FORGE_PROVIDER_PROFILE ?? 'core';
if (profile !== 'core' && !profiles[profile]) throw new Error('Unknown provider profile');
export default {
  root,
  resolve: { alias: profile === 'core' ? [] : [
    { find: /^\.\/helpers\/foundation\.js$/, replacement: root + 'test/provider-foundation/profile-fixture.ts' },
  ] },
  test: { include: [profile === 'core' ? 'test/provider-foundation/traces.ts' : profiles[profile].test], testTimeout: 600000, hookTimeout: 600000, fileParallelism: false },
};
