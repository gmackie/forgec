// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { emptyState, type StateStore } from "../src/model.js";
import { createApi } from "../src/api.js";

import { Console } from "../web/console.js";
vi.mock("../web/editor/editor.js", () => ({ ForgeEditor: () => <div>Editor placeholder</div> }));
afterEach(cleanup);
it("uses the live API to sign in, register an app, inspect settings, and sign out", async () => {
  const token = "long-test-administrator-token-123456";
  let state = emptyState();
  const store: StateStore = {
    reservePublication: async () => true,
    read: async () => structuredClone(state),
    save: async (revision, next) => {
      if (revision !== state.revision) return false;
      state = structuredClone(next);
      return true;
    },
  };
  const api = createApi({
    store,
    token,
    authority: "my-registry.example",
    name: "Independent Forge",
    runtime: "node",
    registry: null,
  });
  const fetcher: typeof fetch = (url, init) =>
    api(new Request(new URL(String(url), "http://localhost"), init));
  render(<Console fetcher={fetcher} />);
  fireEvent.change(screen.getByLabelText("Administrator token"), {
    target: { value: token },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect to instance" }));
  await screen.findByText("Independent Forge");
  fireEvent.click(screen.getByRole("button", { name: "Apps" }));
  fireEvent.click(screen.getByRole("button", { name: "Register app" }));
  fireEvent.change(screen.getByLabelText("App name"), {
    target: { value: "Commerce" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save app" }));
  await screen.findByRole("button", { name: "Commerce" });
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(await screen.findByText("my-registry.example")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Administrator token")).toHaveValue(""),
  );
});
it("keeps the login form visible on authentication failure", async () => {
  render(
    <Console
      fetcher={async () =>
        Response.json({ error: "Invalid administrator token" }, { status: 401 })
      }
    />,
  );
  fireEvent.change(screen.getByLabelText("Administrator token"), {
    target: { value: "wrong" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect to instance" }));
  expect(await screen.findByText("Invalid administrator token")).toBeVisible();
});
it("does not restore a session when a pending refresh finishes after sign-out", async () => {
  const state = {
    revision: 0,
    apps: [],
    audit: [],
    instance: {
      name: "Delayed Forge",
      authority: "local.test",
      runtime: "node",
      registry: null,
    },
  };
  let complete: ((response: Response) => void) | undefined;
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    if (calls === 1) return Response.json(state);
    return new Promise<Response>((resolve) => {
      complete = resolve;
    });
  };
  render(<Console fetcher={fetcher} />);
  fireEvent.change(screen.getByLabelText("Administrator token"), {
    target: { value: "test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect to instance" }));
  await screen.findByText("Delayed Forge");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(complete).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await act(async () => { complete!(Response.json(state)); });
  expect(screen.getByLabelText("Administrator token")).toBeVisible();
});
it("keeps the revision that was loaded with a dialog draft", async () => {
  const initial = {
    revision: 0,
    apps: [],
    audit: [],
    instance: {
      name: "Draft Forge",
      authority: "local.test",
      runtime: "node",
      registry: null,
    },
  };
  let refreshComplete: ((response: Response) => void) | undefined;
  let calls = 0;
  let sentRevision = "";
  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method === "POST") {
      sentRevision = new Headers(init.headers).get("if-match")!;
      return Response.json({ error: "Conflict" }, { status: 409 });
    }
    if (++calls === 1) return Response.json(initial);
    return new Promise<Response>((resolve) => {
      refreshComplete = resolve;
    });
  };
  render(<Console fetcher={fetcher} />);
  fireEvent.change(screen.getByLabelText("Administrator token"), {
    target: { value: "test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect to instance" }));
  await screen.findByText("Draft Forge");
  fireEvent.click(screen.getByRole("button", { name: "Apps" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  fireEvent.click(screen.getByRole("button", { name: "Register app" }));
  refreshComplete!(Response.json({ ...initial, revision: 1 }));
  fireEvent.change(screen.getByLabelText("App name"), {
    target: { value: "Old draft" },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save app" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save app" }));
  await screen.findByText("Conflict");
  expect(sentRevision).toBe("0");
});
it("shows Forge taxonomy and purpose surfaces from the verified package", async () => {
  const { readFileSync } = await import("node:fs");
  const bundle = JSON.parse(readFileSync("../../conformance/fixtures/acme-next.app.json", "utf8"));
  const pkg = {
    ociDigest: "sha256:test",
    entry: { name: "@acme/commerce-next", version: "0.2.0", authority: "local.test", digest: "test", exports: [], dependencies: [], actions: [], fields: [], effects: [] },
    governance: {
      dataSemantics: bundle.dataSemantics,
      purposes: bundle.ir.modules.flatMap((m: any) => m.purposes ?? []),
      dataClasses: bundle.ir.modules.flatMap((m: any) => m.dataClasses ?? []),
      surfaces: bundle.capabilities.surfaces,
    },
  };
  render(<Console fetcher={async (url) => Response.json(String(url).includes("/api/packages") ? { packages: [pkg], configured: true } : {
    ...emptyState(), instance: { name: "Taxonomy Forge", authority: "local.test", runtime: "node", registry: { url: "https://oci.test", repository: "forge" } },
  })} />);
  fireEvent.change(screen.getByLabelText("Administrator token"), { target: { value: "test" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect to instance" }));
  await screen.findByText("Taxonomy Forge");
  fireEvent.click(screen.getByRole("button", { name: "Registry" }));
  fireEvent.click(await screen.findByRole("button", { name: "@acme/commerce-next" }));
  expect(await screen.findByRole("heading", { name: "Data classification" })).toBeVisible();
  expect(screen.getByText("data-taxonomy/1")).toBeVisible();
  expect(screen.getAllByText("data.contact.email").length).toBeGreaterThan(0);
  expect(screen.getAllByText("inferred-from-type").length).toBeGreaterThan(0);
  expect(screen.getByRole("heading", { name: "Purposes and capability surfaces" })).toBeVisible();
  expect(screen.getAllByText("@acme/governance/_/CustomerSupport").length).toBeGreaterThan(0);
  expect(screen.getAllByText("SupportRecord").length).toBeGreaterThan(0);
});
