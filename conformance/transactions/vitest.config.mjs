import { fileURLToPath } from "node:url";
export default {
  root: fileURLToPath(new URL("../../packages/runtime/", import.meta.url)),
  resolve: { conditions: ["source"] },
  test: {
    include: ["test/provider-foundation/transactions.ts"],
    testTimeout: 600000,
    hookTimeout: 600000,
    fileParallelism: false,
  },
};
