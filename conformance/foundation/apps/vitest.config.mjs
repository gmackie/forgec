import {fileURLToPath} from 'node:url';
const test = process.env.FORGE_FOUNDATION_APP_TEST;
if (!test || !/^test\/foundation-app-[a-z-]+\.traces\.ts$/.test(test)) throw new Error('Explicit app trace file required');
export default {
  root: fileURLToPath(new URL('../../../packages/runtime/', import.meta.url)),
  resolve: {conditions:['source']},
  test: {include:[test], testTimeout:120000, hookTimeout:120000, fileParallelism:false},
};
