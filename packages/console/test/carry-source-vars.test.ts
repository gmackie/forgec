import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error untyped build script
import { carryVars, stampedVars } from "../scripts/carry-source-vars.mjs";

const parse = (text: string) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
const SHA = "0eb833a0d7d3df9e1d1bf9d1e49ddcb5def4dd7c";

describe("carry-source-vars (FORG-52)", () => {
  it("copies the agent's stamped FG_* vars into the deployment config", () => {
    // The agent adds its keys to the top-level vars of wrangler.jsonc.
    const stamped = readFileSync("wrangler.jsonc", "utf8").replace('"vars": {', `"vars": { "FG_COMMIT_HASH": "${SHA}", "FG_APP": "forge-console",`);
    const vars = stampedVars(stamped);
    expect(vars).toEqual({ FG_COMMIT_HASH: SHA, FG_APP: "forge-console" });
    const gmac = readFileSync("wrangler.gmac.jsonc", "utf8");
    const out = carryVars(gmac, vars);
    expect(parse(out).vars).toEqual({ ...parse(gmac).vars, FG_COMMIT_HASH: SHA, FG_APP: "forge-console" });
    // Comments and the rest of the file survive.
    expect(out.replace(/^.*"FG_(COMMIT_HASH|APP)".*\n/gm, "")).toBe(gmac);
  });

  it("is a no-op without stamped vars and never overrides a key the config sets", () => {
    const gmac = readFileSync("wrangler.gmac.jsonc", "utf8");
    expect(carryVars(gmac, stampedVars(readFileSync("wrangler.jsonc", "utf8")))).toBe(gmac);
    expect(carryVars(gmac, { INSTANCE_NAME: "other" })).toBe(gmac);
  });
});
