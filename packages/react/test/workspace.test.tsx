/**
 * The workspace renders purely from the UI descriptor and a ForgeClient-shaped
 * `call`. Here the client is the in-memory engine, so this exercises the real
 * flows: list, create via edit buffer -> changeset preview -> commit, patch with
 * revision conflicts, lifecycle actions, reference pickers, CSV import.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Cause, Effect } from "effect";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, ForgeError, MemoryStorage, Model, testLayer, type AppBundle } from "@forgegraph/runtime";
import { Workspace, type ForgeCall } from "../src/index.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const model = new Model(bundle);

function engineCall(engine: Engine): ForgeCall {
  return async (op, input, opts) => {
    const exit = await Effect.runPromiseExit(engine.call(op, input, { tenant: "acme", actor: "operator", requestId: "ui", ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}) }));
    if (exit._tag === "Success") return { ok: true, value: exit.value };
    const e = Cause.squash(exit.cause);
    if (e instanceof ForgeError) return { ok: false, code: e.code, status: e.status, problem: e.problem("ui") as any };
    throw e;
  };
}

let engine: Engine;
let call: ForgeCall;
beforeEach(() => {
  engine = new Engine(model, testLayer(new MemoryStorage()));
  call = engineCall(engine);
});
afterEach(cleanup);

const run = (op: string, input: unknown) => Effect.runPromise(engine.call(op, input, { tenant: "acme", actor: "operator", requestId: "seed" }));

describe("Workspace", () => {
  it("lists resources in the nav and renders a table from the descriptor", async () => {
    await run("@acme/commerce/_/Customer.create", { code: "ACME", name: "Acme", tier: "gold" });
    render(<Workspace descriptor={(bundle as any).ui} call={call} initialRoute="customers" />);
    expect(screen.getByRole("navigation")).toHaveTextContent("Customers");
    expect(screen.getByRole("navigation")).toHaveTextContent("Orders");
    await waitFor(() => expect(screen.getByRole("table")).toHaveTextContent("ACME"));
    expect(screen.getByRole("table")).toHaveTextContent("Gold");
  });

  it("edits rows in the buffer, previews the changeset with a diff, and commits", async () => {
    const c = await run("@acme/commerce/_/Customer.create", { code: "ACME", name: "Acme" });
    render(<Workspace descriptor={(bundle as any).ui} call={call} initialRoute="customers" />);
    await waitFor(() => screen.getByRole("table"));
    const nameCell = screen.getByLabelText(`name of ${c.id}`);
    fireEvent.change(nameCell, { target: { value: "Acme Inc" } });
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    fireEvent.change(screen.getByLabelText("code of new:1"), { target: { value: "beta" } });
    fireEvent.change(screen.getByLabelText("name of new:1"), { target: { value: "Beta" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent("name: Acme → Acme Inc"));
    expect(screen.getByRole("dialog")).toHaveTextContent("create Customer");
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    await waitFor(() => expect(screen.getByRole("table")).toHaveTextContent("BETA"));
    expect(await run("@acme/commerce/_/Customer.get", { id: c.id })).toMatchObject({ name: "Acme Inc", version: 2 });
  });

  it("shows a version conflict from the server without losing the edit", async () => {
    const c = await run("@acme/commerce/_/Customer.create", { code: "ACME", name: "Acme" });
    render(<Workspace descriptor={(bundle as any).ui} call={call} initialRoute="customers" />);
    await waitFor(() => screen.getByRole("table"));
    fireEvent.change(screen.getByLabelText(`name of ${c.id}`), { target: { value: "Mine" } });
    await run("@acme/commerce/_/Customer.update", { id: c.id, expectedVersion: 1, patch: { name: "Theirs" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent("VersionConflict"));
    expect((screen.getByLabelText(`name of ${c.id}`) as HTMLInputElement).value).toBe("Mine");
  });

  it("lifecycle actions appear per row according to the current state and prompt for declared input", async () => {
    const c = await run("@acme/commerce/_/Customer.create", { code: "ACME", name: "Acme" });
    const s = await run("@acme/commerce/_/Site.create", { customer: c.id, code: "hq", name: "HQ", timezone: "UTC" });
    const o = await run("@acme/commerce/_/Order.create", { customer: c.id, site: s.id, subtotal: "1.00", tax: "0.00", requestedOn: "2026-09-20" });
    render(<Workspace descriptor={(bundle as any).ui} call={call} initialRoute="orders" />);
    await waitFor(() => screen.getByRole("table"));
    const row = screen.getByTestId(`row-${o.id}`);
    expect(within(row).queryByRole("button", { name: "Approve" })).toBeNull(); // Draft: approve not allowed
    fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "no longer needed" } });
    fireEvent.click(screen.getByRole("button", { name: "Run cancel" }));
    await waitFor(() => expect(screen.getByTestId(`row-${o.id}`)).toHaveTextContent("Cancelled"));
    expect((await run("@acme/commerce/_/Order.get", { id: o.id })).status).toBe("Cancelled");
  });

  it("reference fields render a picker fed by the referenced resource's bounded list", async () => {
    const c = await run("@acme/commerce/_/Customer.create", { code: "ACME", name: "Acme Corp", tier: "gold" });
    render(<Workspace descriptor={(bundle as any).ui} call={call} initialRoute="sites" />);
    await waitFor(() => screen.getByRole("table"));
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    const picker = screen.getByLabelText("customer of new:1");
    fireEvent.change(picker, { target: { value: "gold" } });
    await waitFor(() => expect(screen.getByRole("listbox")).toHaveTextContent("Acme Corp"));
    fireEvent.click(screen.getByRole("option", { name: "Acme Corp" }));
    expect((picker as HTMLInputElement).value).toBe("Acme Corp");
    expect(screen.getByTestId("ref-new:1-customer")).toHaveTextContent(c.id);
  });
});
