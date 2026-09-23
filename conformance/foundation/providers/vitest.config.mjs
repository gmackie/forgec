import { fileURLToPath } from 'node:url';
export default {
  root: fileURLToPath(new URL('../../../packages/runtime/', import.meta.url)),
  test: { include: ['test/provider-foundation/traces.ts'], testTimeout: 120000, hookTimeout: 120000, fileParallelism: false },
};
