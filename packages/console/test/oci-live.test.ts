import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { generateSigner } from "@forgegraph/registry/artifacts";
import type { AppBundle } from "@forgegraph/runtime";
import { OciRegistry } from "../src/oci.js";
it.skipIf(!process.env.OCI_TEST_URL)(
  "publishes and reads signed packages through a real OCI Distribution server",
  async () => {
    const signer = await generateSigner("live-test");
    const registry = new OciRegistry({
      url: process.env.OCI_TEST_URL!,
      repository: `test-${Date.now()}`,
      authority: "test-independent.example",
      signer,
      allowHttp: true,
    });
    const bundle = JSON.parse(
      readFileSync(
        new URL("../../../conformance/fixtures/acme-next.app.json", import.meta.url),
        "utf8",
      ),
    ) as AppBundle;
    const published = await registry.publish({
      name: "@acme/commerce",
      version: "1.0.0",
      owner: "Acme",
      commit: "test",
      bundle,
    });
    const listed = (await registry.list())[0]!;
    expect(listed.entry.name).toBe("@acme/commerce");
    expect(listed.governance.dataSemantics).toEqual(bundle.dataSemantics);
    expect(listed.governance.surfaces).toEqual((bundle as any).capabilities.surfaces);
    expect(listed.governance.purposes).toEqual(bundle.ir.modules.flatMap(m => m.purposes ?? []));
    expect((await registry.pull(published.ociDigest)).pulled.bundle).toEqual(
      bundle,
    );
    await expect(
      registry.publish({
        name: "@acme/commerce",
        version: "1.0.0",
        owner: "Acme",
        commit: "other",
        bundle,
      }),
    ).rejects.toThrow(/already published/);
  },
);
