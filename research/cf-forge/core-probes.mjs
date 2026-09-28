// Executable observations of pinned upstream code. Failures are evidence, not patched away.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
const root = import.meta.dirname;
const upstream = process.env.CF_FORGE_ROOT;
if (!upstream) throw new Error("Set CF_FORGE_ROOT to the pinned source worktree");
const { init, applyForgeOverlays } = await import(
  pathToFileURL(resolve(upstream, "packages/forge/index.ts"))
);
const { unwrapCloudflareEnvelope } = await import(
  pathToFileURL(
    resolve(
      upstream,
      "packages/cloudflare-forge-sdk-ts/custom/core/fetcher/unwrapCloudflareEnvelope.ts",
    ),
  )
);
const observations = [];
const hash = (x) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
async function probe(name, fn) {
  try {
    observations.push({ name, ...(await fn()) });
  } catch (e) {
    observations.push({ name, status: "error", error: e.message });
  }
}
function spec(description = "first") {
  return {
    openapi: "3.0.3",
    info: { title: "Fixture", version: "1" },
    paths: {
      "/items": {
        get: {
          operationId: "listItems",
          summary: "List items",
          responses: {
            200: {
              description,
              content: {
                "application/json": {
                  schema: { type: "object", properties: { label: { type: "string" } } },
                },
              },
            },
          },
        },
      },
    },
    components: { schemas: {} },
  };
}
await probe("plain OpenAPI resolves operations but has no command surface", async () => {
  const f = await init(spec());
  return {
    status: f.methodStats().total === 0 ? "observed" : "unexpected",
    route: f.getVerbPath("listItems"),
    commands: f.methodStats().total,
  };
});
await probe("overlay names surface methods without changing operation identity", async () => {
  const source = spec(),
    before = hash(source);
  const overlay = {
    overlay: "1.0.0",
    info: { title: "Research naming", version: "1" },
    actions: [
      {
        target: "$",
        update: {
          "x-forge-commands": {
            items: {
              description: "Item operations",
              methods: [
                {
                  operationId: "listItems",
                  "x-fern-sdk-method-name": "list",
                  "x-fern-availability": "generally-available",
                },
              ],
            },
          },
        },
      },
    ],
  };
  const a = await applyForgeOverlays(structuredClone(source), [{ name: "items", overlay }], {
    writeArtifacts: false,
  });
  const b = await applyForgeOverlays(structuredClone(source), [{ name: "items", overlay }], {
    writeArtifacts: false,
  });
  const f = await init(a);
  const files = await f.transform(async (host) =>
    host.emit(
      "binding-map.json",
      JSON.stringify({
        id: "listItems",
        route: host.getVerbPath("listItems"),
        surface: host.methodMap(),
      }),
    ),
  );
  return {
    status: f.methodStats().total === 1 && hash(a) === hash(b) ? "pass" : "fail",
    sourceUnchanged: before === hash(source),
    normalizedHash: hash(a),
    methodMap: f.methodMap(),
    generated: files,
  };
});
await probe("independent Forge instances preserve their response metadata", async () => {
  const a = await init(spec("first API"));
  const before = a.matchResponseStatus("listItems", 200);
  await init(spec("second API"));
  const after = a.matchResponseStatus("listItems", 200);
  return { status: isDeepStrictEqual(before, after) ? "pass" : "fail", before, after };
});
await probe("generic business response must remain intact", async () => {
  const input = { success: true, result: { id: "issue-1" }, audit: "business-data" };
  const output = unwrapCloudflareEnvelope(input);
  return { status: isDeepStrictEqual(input, output) ? "pass" : "fail", input, output };
});
await probe("generic negative business result is not transport failure", async () => {
  const input = { success: false, result: null, reason: "not-yet-complete" };
  try {
    return { status: isDeepStrictEqual(input, unwrapCloudflareEnvelope(input)) ? "pass" : "fail" };
  } catch (e) {
    return { status: "fail", input, error: e.name, message: e.message };
  }
});
await probe("duplicate canonical operation IDs are rejected", async () => {
  const d = spec();
  d.paths["/other"] = structuredClone(d.paths["/items"]);
  try {
    await init(d);
    return { status: "fail" };
  } catch (e) {
    return { status: e.message.includes("Duplicate") ? "pass" : "fail", error: e.message };
  }
});
for (const name of ["cloudflare", "github"])
  await probe(name + " real selected API surface", async () => {
    const d = JSON.parse(await readFile(resolve(root, "fixtures", name + ".json"), "utf8"));
    const f = await init(d);
    return {
      status: "pass",
      methodStats: f.methodStats(),
      operations: Object.values(d.paths).flatMap((path) =>
        Object.values(path)
          .filter((o) => o.operationId)
          .map((o) => ({ id: o.operationId, route: f.getVerbPath(o.operationId) })),
      ),
    };
  });
await writeFile(
  resolve(root, "results/core-probes.json"),
  JSON.stringify({ node: process.version, upstream, observations }, null, 2) + "\n",
);
console.log(JSON.stringify(observations, null, 2));
