import { DatabaseSync } from "node:sqlite";
import { it, expect } from "vitest";
import { DeploymentController } from "../src/runner/controller.js";
it("persists idempotent actions, guards concurrent rollouts, activates only a healthy release and supports rollback", async () => {
  const db = new DatabaseSync(":memory:");
  let finish!: () => void;
  const gate = new Promise<void>((r) => (finish = r));
  let calls = 0;
  const provider = {
    deploy: async (release: any, id: string) => {
      calls++;
      if (calls === 1) await gate;
      return { url: "http://container:8080", handle: id };
    },
    stop: async () => {},
    restart: async () => {},
  };
  const target = {
    id: "desk",
    name: "Desk",
    releases: [
      {
        id: "v1",
        name: "1.0",
        artifact: "sha256:1",
        createdAt: "2026-01-01",
        image: "image-1",
      },
      {
        id: "v2",
        name: "2.0",
        artifact: "sha256:2",
        createdAt: "2026-01-02",
        image: "image-2",
      },
    ],
  };
  const controller = new DeploymentController(db, [target], provider);
  const action = {
    action: "deploy" as const,
    release: "v1",
    requestId: "request-1",
    expectedDeployment: null,
  };
  const first = controller.action("desk", action);
  expect(controller.action("desk", action).id).toBe(first.id);
  expect(() =>
    controller.action("desk", { ...action, requestId: "request-2" }),
  ).toThrow(/progress/);
  expect(controller.inspect("desk").activeDeployment).toBeNull();
  finish();
  await controller.idle();
  expect(controller.inspect("desk").activeDeployment).toBe(first.id);
  expect(calls).toBe(1);
  const second = controller.action("desk", {
    ...action,
    release: "v2",
    requestId: "request-3",
    expectedDeployment: first.id,
  });
  await controller.idle();
  const rollback = controller.action("desk", {
    ...action,
    action: "rollback",
    requestId: "request-4",
    expectedDeployment: second.id,
  });
  await controller.idle();
  expect(controller.inspect("desk").activeDeployment).toBe(rollback.id);
  expect(
    new DeploymentController(db, [target], provider).inspect("desk")
      .deployments,
  ).toHaveLength(3);
});
it("retains the last healthy deployment after provider failure", async () => {
  const db = new DatabaseSync(":memory:");
  let fail = false;
  const provider = {
    deploy: async () => {
      if (fail) throw Error("Health check failed");
      return { url: "http://live", handle: "one" };
    },
    stop: async () => {},
    restart: async () => {},
  };
  const controller = new DeploymentController(
    db,
    [
      {
        id: "desk",
        name: "Desk",
        releases: [
          {
            id: "v1",
            name: "1",
            image: "image",
            artifact: "sha256:1",
            createdAt: "now",
          },
        ],
      },
    ],
    provider,
  );
  const first = controller.action("desk", {
    action: "deploy",
    release: "v1",
    requestId: "request-1",
    expectedDeployment: null,
  });
  await controller.idle();
  fail = true;
  controller.action("desk", {
    action: "deploy",
    release: "v1",
    requestId: "request-2",
    expectedDeployment: first.id,
  });
  await controller.idle();
  expect(controller.inspect("desk").activeDeployment).toBe(first.id);
  expect(controller.inspect("desk").deployments[0]?.status).toBe("failed");
});
it("cannot relabel an active instance by supplying another release to restart", async () => {
  const controller = new DeploymentController(
    new DatabaseSync(":memory:"),
    [
      {
        id: "demo",
        name: "Demo",
        releases: [
          {
            id: "v1",
            name: "1",
            image: "one",
            artifact: "one",
            createdAt: "now",
          },
          {
            id: "v2",
            name: "2",
            image: "two",
            artifact: "two",
            createdAt: "now",
          },
        ],
      },
    ],
    {
      deploy: async () => ({ url: "http://one", handle: "one" }),
      stop: async () => {},
      restart: async () => {},
    },
  );
  const first = controller.action("demo", {
    action: "deploy",
    release: "v1",
    requestId: "request-1",
    expectedDeployment: null,
  });
  await controller.idle();
  expect(() =>
    controller.action("demo", {
      action: "restart",
      release: "v2",
      requestId: "request-2",
      expectedDeployment: first.id,
    }),
  ).toThrow(/release/i);
});
it("retains a stopped instance across recovery and protects newly reserved bindings on rollback", async () => {
  const db = new DatabaseSync(":memory:");
  const environments: unknown[] = [];
  let restarted = "";
  const target = {
    id: "demo",
    name: "Demo",
    environment: {} as Record<string, string>,
    releases: [
      { id: "v1", name: "1", image: "one", artifact: "one", createdAt: "now" },
    ],
  };
  const provider = {
    deploy: async (_r: any, id: string, t: any) => {
      environments.push(t.environment);
      return { url: "http://one", handle: id };
    },
    stop: async () => {},
    restart: async (i: any) => {
      restarted = i.handle;
    },
  };
  let controller = new DeploymentController(db, [target], provider);
  const first = controller.action("demo", {
    action: "deploy",
    release: "v1",
    config: { REGION: "old" },
    requestId: "request-1",
    expectedDeployment: null,
  });
  await controller.idle();
  const stopped = controller.action("demo", {
    action: "stop",
    requestId: "request-2",
    expectedDeployment: first.id,
  });
  await controller.idle();
  controller = new DeploymentController(db, [target], provider);
  expect(controller.runtime("demo")).toBeNull();
  expect(controller.retainedInstance("demo")?.handle).toBe(first.id);
  const restart = controller.action("demo", {
    action: "restart",
    requestId: "request-3",
    expectedDeployment: stopped.id,
  });
  await controller.idle();
  expect(restarted).toBe(first.id);
  target.environment = { REGION: "protected" };
  controller.action("demo", {
    action: "rollback",
    release: "v1",
    requestId: "request-4",
    expectedDeployment: restart.id,
  });
  await controller.idle();
  expect(environments.at(-1)).toEqual({ REGION: "protected" });
  expect(controller.inspect("demo").deployments[0]?.config).toEqual({});
});
