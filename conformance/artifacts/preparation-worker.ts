/** Pure preparation probe: no credentials, bindings or external effects. */
import {
  WorkerArtifactWorkspace,
  WorkerGitPackStore,
} from "../../packages/runtime/src/adapters/artifact-workspace-workers.js";
export default {
  async fetch(): Promise<Response> {
    const store = new WorkerGitPackStore();
    const workspace = new WorkerArtifactWorkspace(
      {
        tenant: "probe",
        artifact: "source",
        generation: "one",
        repositoryId: "probe",
        objectFormat: "sha1",
      },
      store,
      async () => true,
    );
    const pin = await workspace.prepare(
      {
        base: null,
        changes: [
          { path: "binary", bytes: new Uint8Array([0, 255, 128]) },
          {
            path: "nested/run",
            bytes: new TextEncoder().encode("#!/bin/sh\n"),
            mode: "100755",
          },
        ],
        message: "Workers preparation",
        at: "2026-10-15T00:00:00Z",
      },
      { tenant: "probe", actor: "qualification", requestId: "probe" },
    );
    const pack = await store.pack();
    return new Response(pack, {
      headers: {
        "content-type": "application/x-git-packed-objects",
        "x-forge-commit": pin.oid,
        "x-forge-tree": pin.tree,
      },
    });
  },
};
