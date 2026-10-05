// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AppBundle } from "@forgegraph/runtime";
import type { Project } from "../web/editor/language.js";
import { example } from "../web/editor/example.js";
import { canonical, digestOf } from "../web/editor/digest.js";
import { PlaygroundEditor } from "../web/playground.js";
import { inspect } from "./editor-wasm.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function withoutDigest(project: Project): Project {
  const next = structuredClone(project);
  const file = next.files.find((item) => item.path === "operations.forge");
  if (!file) throw new Error("operations.forge missing");
  file.text = file.text.replace(
    "function BuildSupportDigest {\n  purpose CustomerSupport\n  uses { Ticket read }\n}\n\n",
    "",
  );
  return next;
}

it("fires DailySupportDigest from the graph", async () => {
  const { container } = render(
    <PlaygroundEditor initialProject={structuredClone(example)} inspect={inspect} />,
  );
  const source = await screen.findByRole("button", { name: "Open DailySupportDigest" });
  expect(
    container.querySelector(
      '[data-from-name="DailySupportDigest"][data-to-name="BuildSupportDigest"]',
    ),
  ).toBeTruthy();
  fireEvent.click(source);
  const clock = screen.getByLabelText("Clock time");
  fireEvent.change(clock, { target: { value: "2026-10-03T07:00:00.000Z" } });
  fireEvent.click(screen.getByRole("button", { name: "Fire source" }));
  expect(await screen.findByText("Nothing is due at this time.")).toBeTruthy();
  fireEvent.change(clock, { target: { value: "2026-10-03T08:00:00.000Z" } });
  fireEvent.click(screen.getByRole("button", { name: "Fire source" }));
  expect(await screen.findByText("Ran")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Fire source" }));
  expect(await screen.findByText("Duplicate")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reset runtime" }));
  fireEvent.click(screen.getByRole("button", { name: "Fire source" }));
  expect(await screen.findByText("Ran")).toBeTruthy();
});

it("disables fire while the draft has a compiler error", async () => {
  render(<PlaygroundEditor initialProject={withoutDigest(example)} inspect={inspect} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open DailySupportDigest" }));
  expect(
    (screen.getByRole("button", { name: "Fire source" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it("places a saved node and restores its clock and payload", async () => {
  render(
    <PlaygroundEditor
      initialProject={structuredClone(example)}
      initialSession={{
        positions: [{ path: "operations.forge", name: "DailySupportDigest", x: 12, y: 34 }],
        samples: [
          {
            path: "operations.forge",
            name: "DailySupportDigest",
            clock: "2026-10-03T07:00:00.000Z",
            payload: "{\"note\":1}",
          },
        ],
      }}
      inspect={inspect}
    />,
  );
  const source = await screen.findByRole("button", { name: "Open DailySupportDigest" });
  expect(source.getAttribute("data-x")).toBe("12");
  expect(source.getAttribute("data-y")).toBe("34");
  fireEvent.click(source);
  expect((screen.getByLabelText("Clock time") as HTMLInputElement).value).toBe("2026-10-03T07:00:00.000Z");
  expect((screen.getByLabelText("Sample payload") as HTMLTextAreaElement).value).toBe("{\"note\":1}");
});

it("opens a package without source as a read-only contract graph", async () => {
  const analysis = await inspect({ ...structuredClone(example), emit: "ir" });
  if (!analysis.ir) throw new Error("missing ir");
  const { container } = render(
    <PlaygroundEditor
      inspect={inspect}
      readonlyView={{ ir: analysis.ir, reason: "This package has no playground source layer." }}
    />,
  );
  expect(await screen.findByRole("button", { name: "Open DailySupportDigest" })).toBeTruthy();
  expect(
    container.querySelector('[data-from-name="DailySupportDigest"][data-to-name="BuildSupportDigest"]'),
  ).toBeTruthy();
  expect(screen.getByRole("status").textContent).toMatch(/no playground source layer/);
  expect(screen.queryByRole("button", { name: "Fire source" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add declaration" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
  expect(screen.queryByRole("button", { name: "New draft" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete declaration" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Snap wire" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Cut DailySupportDigest runs BuildSupportDigest" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open DailySupportDigest" }));
  expect(screen.queryByLabelText("Declaration name")).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete declaration" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Snap wire" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Use the browser draft" }));
  expect(screen.getByRole("button", { name: "Add declaration" })).toBeTruthy();
});

it("continues a published draft whose source matches the bundle", async () => {
  const analysis = await inspect({ ...example, emit: "ir" });
  if (!analysis.ir) throw new Error("missing ir");
  const bundle = {
    version: "app-bundle/1",
    buildHash: "playground",
    ir: analysis.ir,
    contracts: { version: "contracts/1", resources: [], functions: [] },
    sql: {},
    dynamo: {},
  } as AppBundle;
  render(
    <PlaygroundEditor
      inspect={inspect}
      opened={{
        token: 1,
        bundle,
        playground: {
          version: "playground/1",
          bundleDigest: await digestOf(canonical(bundle)),
          name: example.name,
          currentFile: example.currentFile,
          files: example.files,
          positions: [{ path: "operations.forge", name: "DailySupportDigest", x: 12, y: 34 }],
          samples: [
            {
              path: "operations.forge",
              name: "DailySupportDigest",
              clock: "2026-10-03T08:00:00.000Z",
              payload: { note: "kept" },
            },
          ],
        },
      }}
    />,
  );
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Open DailySupportDigest" }).getAttribute("data-x")).toBe("12");
  });
  fireEvent.click(screen.getByRole("button", { name: "Open DailySupportDigest" }));
  expect((screen.getByLabelText("Sample payload") as HTMLTextAreaElement).value).toBe("{\"note\":\"kept\"}");
  expect(screen.queryByRole("status")).toBeNull();
});

it("starts a blank program, snaps a uses wire, and deletes the declaration", async () => {
  const { container } = render(
    <PlaygroundEditor initialProject={structuredClone(example)} inspect={inspect} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "New draft" }));
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Open DailySupportDigest" })).toBeNull();
  });
  fireEvent.click(screen.getByRole("button", { name: "Resource" }));
  fireEvent.click(screen.getByRole("button", { name: "Function" }));
  fireEvent.click(await screen.findByRole("button", { name: "Open Function" }));
  const select = (await screen.findByLabelText("Snap to")) as HTMLSelectElement;
  const option = [...select.options].find((item) => item.textContent === "resource Resource");
  expect(option, [...select.options].map((item) => item.textContent).join(", ")).toBeTruthy();
  fireEvent.change(select, { target: { value: option?.value } });
  fireEvent.click(screen.getByRole("button", { name: "Snap wire" }));
  await waitFor(() => {
    expect(
      container.querySelector('[data-from-name="Function"][data-to-name="Resource"][data-label="uses"]'),
    ).toBeTruthy();
  });
  fireEvent.click(screen.getByRole("button", { name: "Delete declaration" }));
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Open Function" })).toBeNull();
  });
  expect(screen.getByRole("button", { name: "Open Resource" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Service desk" }));
  expect(await screen.findByRole("button", { name: "Open DailySupportDigest" })).toBeTruthy();
});

it("snaps a wire by clicking the next block and cuts that wire", async () => {
  const blank: Project = {
    name: "@playground/program",
    currentFile: "main.forge",
    files: [{ path: "main.forge", text: "// Click a block to start a Forge program.\n" }],
  };
  const { container } = render(<PlaygroundEditor initialProject={blank} inspect={inspect} />);
  fireEvent.click(await screen.findByRole("button", { name: "Resource" }));
  fireEvent.click(screen.getByRole("button", { name: "Function" }));
  fireEvent.click(await screen.findByRole("button", { name: "Open Function" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Resource" }));
  expect((await screen.findAllByRole("button", { name: "Cut Function uses Resource" })).length).toBeGreaterThan(0);
  expect(
    container.querySelector('[data-from-name="Function"][data-to-name="Resource"][data-label="uses"]'),
  ).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Cut Function uses Resource" })[0]!);
  await waitFor(() => {
    expect(
      container.querySelector('[data-from-name="Function"][data-to-name="Resource"][data-label="uses"]'),
    ).toBeNull();
  });
  expect(screen.getByRole("button", { name: "Open Function" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open Resource" })).toBeTruthy();
});

it("adds a source block that is already wired to a function", async () => {
  const { container } = render(
    <PlaygroundEditor initialProject={structuredClone(example)} inspect={inspect} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Source" }));
  expect(await screen.findByRole("button", { name: "Open Source" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Open RunSource" })).toBeTruthy();
  expect(
    container.querySelector('[data-from-name="Source"][data-to-name="RunSource"][data-label="runs"]'),
  ).toBeTruthy();
});
