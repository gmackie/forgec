/**
 * Validate `contract.json` files with ForgeGraph's own `validateContract`
 * (vendored under ./vendor): the Zod wire schema, operation ids, both
 * fingerprint levels and `$ref` resolution, exactly as `fg contract publish`
 * is checked on ingest.
 *
 *   node --import ./conformance/contract-ir/ts-resolve.mjs \
 *     --experimental-strip-types conformance/contract-ir/validate.ts <contract.json>...
 *
 * Exit 1 when any file does not validate.
 */
import { readFileSync } from "node:fs";

import { validateContract } from "./vendor/ir/index.js";

export interface FileResult {
  readonly file: string;
  readonly ok: boolean;
  readonly operations: number;
  readonly issues: ReadonlyArray<string>;
}

export function validateFile(file: string): FileResult {
  const input: unknown = JSON.parse(readFileSync(file, "utf8"));
  const result = validateContract(input);
  if (result.ok) {
    return { file, ok: true, operations: result.contract.operations.length, issues: [] };
  }
  return {
    file,
    ok: false,
    operations: 0,
    issues: result.issues.map((i) => `${i.code} ${i.path}: ${i.message}`),
  };
}

if (import.meta.main) {
  // `--summary`: print failures and one line of totals instead of a line per file.
  const summary = process.argv.includes("--summary");
  const files = process.argv.slice(2).filter((a) => a !== "--summary");
  if (files.length === 0) {
    console.error("usage: validate.ts [--summary] <contract.json>...");
    process.exit(2);
  }
  let failed = 0;
  let operations = 0;
  for (const file of files) {
    const r = validateFile(file);
    operations += r.operations;
    if (r.ok) {
      if (!summary) console.log(`ok   ${file} (${r.operations} operations)`);
    } else {
      failed += 1;
      console.log(`FAIL ${file}`);
      for (const issue of r.issues.slice(0, 20)) console.log(`     ${issue}`);
    }
  }
  if (summary) {
    console.log(`validateContract: ${files.length} contracts, ${operations} operations, ${failed} failures`);
  }
  process.exit(failed > 0 ? 1 : 0);
}
