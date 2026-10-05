// @vitest-environment jsdom
import React from "react";
import bundle from "../../../conformance/fixtures/acme.app.json";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import type { ForgeCall, UiDescriptor } from "@forgegraph/react";
import { customerDirectory } from "../web/gizmos/customer-directory.js";
const descriptor = bundle.ui as UiDescriptor;
const Directory = customerDirectory.component;
afterEach(cleanup);
it("browses bounded pages, searches the visible page and opens the matching generated forms", async () => {
  const call = vi.fn<ForgeCall>(async (_op, input) => ({
    ok: true,
    value: (input as any).cursor
      ? {
          items: [{ id: "2", name: "Grace", email: "grace@example.com" }],
          next: null,
        }
      : {
          items: [
            { id: "1", name: "Ada", email: "ada@example.com", tier: "gold" },
          ],
          next: "page-2",
        },
  }));
  const openForms = vi.fn();
  render(
    <Directory
      descriptor={descriptor}
      call={call}
      openForms={openForms}
      onDirtyChange={() => {}}
    />,
  );
  expect(await screen.findByRole("heading", { name: "Ada" })).toBeVisible();
  expect(call).toHaveBeenLastCalledWith("@acme/commerce/_/Customer.list.all", {
    params: {},
    limit: 50,
  });
  fireEvent.change(screen.getByLabelText("Search directory page"), {
    target: { value: "none" },
  });
  expect(screen.getByText(/No matching people on this page/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("Search directory page"), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(await screen.findByRole("heading", { name: "Grace" })).toBeVisible();
  expect(call).toHaveBeenLastCalledWith("@acme/commerce/_/Customer.list.all", {
    params: {},
    limit: 50,
    cursor: "page-2",
  });
  expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Manage customers in forms" }),
  );
  expect(openForms).toHaveBeenCalledWith("customers");
});
it("shows runtime errors and supports retry without inventing records", async () => {
  const call = vi
    .fn<ForgeCall>()
    .mockResolvedValueOnce({
      ok: false,
      status: 403,
      code: "NotPermitted",
      problem: { code: "NotPermitted", detail: "Access denied" },
    })
    .mockResolvedValueOnce({ ok: true, value: { items: [], next: null } });
  render(
    <Directory
      descriptor={descriptor}
      call={call}
      openForms={() => {}}
      onDirtyChange={() => {}}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Access denied");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.getByText(/No people yet/)).toBeVisible());
  expect(screen.queryByRole("alert")).toBeNull();
});
it("only advertises this gizmo for a supported resource with a browseable list", () => {
  expect(customerDirectory.supports(descriptor)).toBe(true);
  expect(
    customerDirectory.supports({
      ...descriptor,
      resources: descriptor.resources.filter((r) => r.name !== "Customer"),
    }),
  ).toBe(false);
  expect(
    customerDirectory.supports({
      ...descriptor,
      resources: descriptor.resources.map((r) => ({ ...r, lists: [] })),
    }),
  ).toBe(false);
});
