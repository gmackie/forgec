import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

for (const [scenario, expected] of [["owned", 0], ["free", 0], ["foreign", 1], ["unavailable", 1], ["owners-unavailable", 1]]) {
  test(`crate-name preflight: ${scenario}`, () => {
    const mock = `globalThis.fetch = async (url) => {
      const scenario = ${JSON.stringify(scenario)};
      if (scenario === "unavailable") throw new Error("offline");
      if (scenario === "free") return new Response("{}", {status: 404});
      if (url.endsWith("/owners")) {
        if (scenario === "owners-unavailable") return new Response("{}", {status: 503});
        return Response.json({users: [{login: scenario === "owned" ? "gmackie" : "someone-else"}]});
      }
      return Response.json({crate: {max_version: "0.3.0"}, versions: [{num: "0.4.0"}]});
    };`;
    const result = spawnSync(process.execPath, ["--import", `data:text/javascript;base64,${Buffer.from(mock).toString("base64")}`, "scripts/check-crate-names.mjs"], {
      encoding: "utf8", env: {...process.env, OWNER: "gmackie"},
    });
    assert.equal(result.status, expected, result.stderr);
  });
}
