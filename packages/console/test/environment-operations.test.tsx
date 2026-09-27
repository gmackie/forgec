// @vitest-environment jsdom
import React from "react";
import { afterEach, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { EnvironmentOperations } from "../web/environment-operations.js";
afterEach(cleanup);
const app = {
  id: "app-1",
  name: "Support",
  description: "",
  archived: false,
  updatedAt: "now",
  environments: [
    {
      id: "prod",
      name: "Production",
      target: "cloudflare" as const,
      endpoint: "https://example.com",
      packageDigest: "sha256:one",
      config: { REGION: "west" },
      secretRefs: {},
    },
  ],
};
const target = {
  id: "workers",
  name: "Workers production",
  kind: "cloudflare",
  appId: "app-1",
  environmentId: "prod",
  runtimeId: "runtime",
};
const status = {
  releases: [{ id: "v1", name: "1.0", artifact: "sha256:one" }],
  activeDeployment: "run",
  deployments: [
    {
      id: "run",
      release: "v1",
      status: "healthy",
      config: { REGION: "east" },
      createdAt: "2026-09-27T00:00:00Z",
    },
  ],
};
const callbacks = {
  onConfigure: vi.fn(),
  onRemove: vi.fn(),
  onManage: vi.fn(),
  onTest: vi.fn(),
};
it("shows explicit connections, configuration differences and navigation context", async () => {
  const api = vi.fn(async (path: string) =>
    path === "/deployments/targets" ? { targets: [target] } : status,
  );
  render(<EnvironmentOperations app={app} api={api as any} {...callbacks} />);
  expect(await screen.findByText("1.0")).toBeVisible();
  expect(screen.getByText("1 configuration value differs")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Manage deployment" }));
  expect(callbacks.onManage).toHaveBeenCalledWith("workers");
  fireEvent.click(screen.getByRole("button", { name: "Test functions" }));
  expect(callbacks.onTest).toHaveBeenCalledWith("runtime");
});
it("does not infer a connection from another app or hide unavailable status", async () => {
  const api = vi.fn(async () => ({ targets: [{ ...target, appId: "other" }] }));
  const view = render(
    <EnvironmentOperations app={app} api={api as any} {...callbacks} />,
  );
  expect(await screen.findByText("Deployment unverified")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Manage deployment" }),
  ).toBeNull();
  view.unmount();
  const broken = vi.fn(async (path: string) => {
    if (path === "/deployments/targets") return { targets: [target] };
    throw Error("Controller unavailable");
  });
  render(
    <EnvironmentOperations app={app} api={broken as any} {...callbacks} />,
  );
  expect(await screen.findByText("Controller unavailable")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Manage deployment" }),
  ).toBeVisible();
});
it("surfaces duplicate environment connections without choosing one", async () => {
  const api = vi.fn(async () => ({
    targets: [target, { ...target, id: "duplicate" }],
  }));
  render(<EnvironmentOperations app={app} api={api as any} {...callbacks} />);
  expect(
    await screen.findByText("Multiple deployment connections"),
  ).toBeVisible();
  expect(api).toHaveBeenCalledTimes(1);
});
