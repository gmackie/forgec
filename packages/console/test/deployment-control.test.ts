import { it, expect } from "vitest";
import { DeploymentConnection } from "../src/deployment-control.js";
it("dispatches a pinned release with an idempotent request and never returns controller credentials", async () => {
  const requests: Request[] = [];
  const connection = new DeploymentConnection(
    {
      id: "desk-docker",
      name: "Desk Docker",
      kind: "docker",
      endpoint: "https://runner.example/targets/desk",
      token: "controller-secret",
    },
    async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json(
        request.method === "GET"
          ? {
              releases: [{ id: "r1", artifact: "sha256:abc" }],
              deployments: [],
            }
          : { id: "run-1", status: "queued" },
        { status: request.method === "GET" ? 200 : 202 },
      );
    },
  );
  expect((await connection.inspect()).releases).toHaveLength(1);
  await connection.action({
    action: "deploy",
    release: "r1",
    requestId: "idempotent-1",
    expectedDeployment: null,
  });
  expect(await requests.at(-1)!.json()).toMatchObject({
    release: "r1",
    requestId: "idempotent-1",
    expectedDeployment: null,
  });
  expect(requests.at(-1)!.headers.get("authorization")).toBe(
    "Bearer controller-secret",
  );
  expect(JSON.stringify(connection.public)).not.toContain("controller-secret");
});
it("surfaces rejected rollouts and refuses redirects", async () => {
  const target = {
    id: "desk",
    name: "Desk",
    kind: "docker" as const,
    endpoint: "https://runner.example",
    token: "secret",
  };
  const conflict = new DeploymentConnection(target, async () =>
    Response.json({ error: "Deployment changed" }, { status: 409 }),
  );
  await expect(
    conflict.action({
      action: "rollback",
      release: "r1",
      requestId: "once-only",
      expectedDeployment: "old",
    }),
  ).rejects.toThrow("Deployment changed");
  const redirect = new DeploymentConnection(
    target,
    async () => new Response(null, { status: 302 }),
  );
  await expect(redirect.inspect()).rejects.toThrow(/redirect/i);
});
