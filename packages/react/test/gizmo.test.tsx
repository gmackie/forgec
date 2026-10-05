import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  GizmoWorkspace,
  type GizmoDefinition,
  type GizmoProps,
  type ForgeCall,
  type UiDescriptor,
} from "../src/index.js";

const descriptor: UiDescriptor = {
  version: "ui/1",
  package: "@test/desk",
  resources: [
    {
      id: "@test/desk/_/Customer",
      name: "Customer",
      kind: "resource",
      label: "Customer",
      plural: "Customers",
      route: "customers",
      titleField: "name",
      fields: [
        {
          name: "name",
          label: "Name",
          widget: "text",
          required: true,
          editableOnCreate: true,
          editableOnUpdate: true,
          sortable: true,
        },
      ],
      tableColumns: ["name"],
      lists: [{ name: "all", label: "All", op: "customers.list", params: [] }],
      finds: [],
      actions: [],
      softDelete: false,
      versioned: true,
    },
  ],
};
const call: ForgeCall = async () => ({
  ok: true,
  value: { items: [{ id: "1", version: 1, name: "Ada" }] },
});
afterEach(cleanup);
function Custom({ onDirtyChange, openForms, call, descriptor }: GizmoProps) {
  const [value, setValue] = useState("");
  const [message, setMessage] = useState("");
  return (
    <>
      <input
        aria-label="Custom note"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          onDirtyChange(true);
        }}
      />
      <button
        onClick={() => {
          setValue("");
          onDirtyChange(false);
        }}
      >
        Discard note
      </button>
      <button onClick={() => openForms("customers")}>
        Open customer forms
      </button>
      <button
        onClick={async () => {
          const result = await call(descriptor.resources[0]!.lists[0]!.op, {});
          if (result.ok) setMessage(result.value.items[0].name);
        }}
      >
        Read through shared client
      </button>
      <p>{message}</p>
    </>
  );
}
const gizmo: GizmoDefinition = {
  id: "test",
  title: "Task desk",
  description: "A task-specific workflow",
  supports: (d) => d.package === "@test/desk",
  component: Custom,
};
it("keeps generated forms available, opens a compatible custom component and shares its runtime client", async () => {
  const client = vi.fn(call);
  render(
    <GizmoWorkspace descriptor={descriptor} call={client} gizmos={[gizmo]} />,
  );
  expect(await screen.findByLabelText("name of 1")).toHaveValue("Ada");
  fireEvent.click(screen.getByRole("button", { name: "Gizmos" }));
  fireEvent.click(screen.getByRole("button", { name: /Task desk/ }));
  fireEvent.click(
    screen.getByRole("button", { name: "Read through shared client" }),
  );
  expect(await screen.findByText("Ada")).toBeVisible();
  expect(client).toHaveBeenLastCalledWith("customers.list", {});
  fireEvent.click(screen.getByRole("button", { name: "Open customer forms" }));
  expect(await screen.findByLabelText("name of 1")).toHaveValue("Ada");
});
it("protects unsaved changes in both surfaces and lets the gizmo clear its pending state", async () => {
  const dirty = vi.fn();
  render(
    <GizmoWorkspace
      descriptor={descriptor}
      call={call}
      gizmos={[gizmo]}
      onDirtyChange={dirty}
    />,
  );
  fireEvent.change(await screen.findByLabelText("name of 1"), {
    target: { value: "Changed" },
  });
  expect(
    screen.getByRole("button", { name: "Gizmos" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Revert" }));
  fireEvent.click(screen.getByRole("button", { name: "Gizmos" }));
  fireEvent.click(screen.getByRole("button", { name: /Task desk/ }));
  fireEvent.change(screen.getByLabelText("Custom note"), {
    target: { value: "Keep me" },
  });
  expect(dirty).toHaveBeenLastCalledWith(true);
  expect(
    screen.getByRole("button", { name: "Data & forms" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "All gizmos" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Open customer forms" }));
  expect(screen.getByLabelText("Custom note")).toHaveValue("Keep me");
  fireEvent.click(screen.getByRole("button", { name: "Discard note" }));
  expect(dirty).toHaveBeenLastCalledWith(false);
  fireEvent.click(
    screen.getByRole("button", { name: "Data & forms" }),
  );
  expect(await screen.findByLabelText("name of 1")).toBeVisible();
});
it("provides forms even when no compatible gizmo is installed", async () => {
  render(
    <GizmoWorkspace
      descriptor={{ ...descriptor, package: "@other/app" }}
      call={call}
      gizmos={[gizmo]}
    />,
  );
  await screen.findByLabelText("name of 1");
  fireEvent.click(screen.getByRole("button", { name: "Gizmos" }));
  expect(screen.queryByRole("button", { name: /Task desk/ })).toBeNull();
  expect(screen.getByText(/No gizmos are installed/)).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Data & forms" }),
  );
  expect(await screen.findByLabelText("name of 1")).toBeVisible();
});
it("a failed custom UI cannot take down the standard forms", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(
      <GizmoWorkspace
        descriptor={descriptor}
        call={call}
        gizmos={[
          {
            ...gizmo,
            component: () => {
              throw Error("broken");
            },
          },
        ]}
      />,
    );
    await screen.findByLabelText("name of 1");
    fireEvent.click(
      screen.getByRole("button", { name: "Gizmos" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Task desk/ }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "This gizmo could not open",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Data & forms" }),
    );
    expect(await screen.findByLabelText("name of 1")).toBeVisible();
  } finally {
    errors.mockRestore();
  }
});
