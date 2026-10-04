// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { example } from "../web/editor/example.js";
import billing from "../web/editor/samples/billing.openapi.json";
import { PlaygroundEditor } from "../web/playground.js";
import { inspect } from "./editor-wasm.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("discovers Vendor Billing operations as external functions", async () => {
  const { container } = render(
    <PlaygroundEditor initialProject={structuredClone(example)} inspect={inspect} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Vendor Billing" }));
  expect(await screen.findByText(/POST\s+\/invoices/)).toBeTruthy();
  expect(screen.getByText(/Foreign ids stay text:.*customer_id/)).toBeTruthy();
  expect(screen.getByText(/The browser did not call it/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Use this API" }));
  const created = await screen.findByRole("button", { name: "Open CreateInvoice" });
  expect(created.getAttribute("data-external")).toBe("true");
  expect(screen.getByRole("button", { name: "Open GetInvoice" }).getAttribute("data-external")).toBe(
    "true",
  );
  expect(screen.queryByRole("button", { name: "Open Invoice" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open Currency" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open DailySupportDigest" })).toBeNull();
  expect(container.querySelector(".playground-diagnostics")).toBeNull();
});

it("adds a discovered API beside the current program", async () => {
  render(<PlaygroundEditor initialProject={structuredClone(example)} inspect={inspect} />);
  fireEvent.click(await screen.findByRole("button", { name: "Support Directory" }));
  expect(await screen.findByText(/GET\s+\/contacts\/\{contactId\}/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add to this program" }));
  const contact = await screen.findByRole("button", { name: "Open GetContact" });
  expect(contact.getAttribute("data-external")).toBe("true");
  expect(screen.getByRole("button", { name: "Open DailySupportDigest" })).toBeTruthy();
});

it("refuses a pasted spec whose server is a private host", async () => {
  render(<PlaygroundEditor initialProject={structuredClone(example)} inspect={inspect} />);
  const spec = JSON.stringify(billing).replace(
    "https://billing.vendor.example/v1",
    "http://127.0.0.1/",
  );
  fireEvent.change(screen.getByLabelText("OpenAPI document"), { target: { value: spec } });
  fireEvent.click(screen.getByRole("button", { name: "Discover pasted spec" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/private|forbidden/i);
  expect(screen.queryByRole("button", { name: "Use this API" })).toBeNull();
});
