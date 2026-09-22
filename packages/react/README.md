# @forgegraph/react

Generated record forms and purpose-built gizmos over the same Forge runtime.

```bash
npm install @forgegraph/react
```

## Generated forms

`Workspace` renders tables, field editors, lifecycle actions, and CSV import
from the compiled `ui/1` descriptor. Record edits use an edit buffer followed by
changeset preview, approval, and commit. A `ForgeCall` supplies the authenticated
transport; storage and credentials are not part of the UI.

```tsx
import { Workspace, type ForgeCall } from "@forgegraph/react";

// descriptor comes from the deployed bundle; call is your generated client's call.
<Workspace descriptor={descriptor} call={call} />;
```

## Gizmos alongside the forms

A **gizmo** is an application-owned interface for a specific business task:
a customer directory, approval queue, support inbox, or scheduling board.
Its layout, navigation, visual treatment, and interactions are ordinary React,
so they can be customized independently of the generated forms.

`GizmoWorkspace` supplies the Data & forms / Gizmos switch and a launcher. The
generated forms remain available whether or not a compatible gizmo is installed.

```tsx
import {
  GizmoWorkspace,
  type GizmoDefinition,
  type GizmoProps,
} from "@forgegraph/react";

function SupportInbox({ descriptor, call, openForms, onDirtyChange }: GizmoProps) {
  // Load through call(operationId, input, options).
  // Render your own queue, cards, filters, dialogs, and actions.
  // Set onDirtyChange(true) for unsaved input or an in-flight write;
  // clear it only after saving or explicitly discarding the input.
  return <button onClick={() => openForms("tickets")}>Open ticket forms</button>;
}

const supportInbox: GizmoDefinition = {
  id: "support-inbox",
  title: "Support inbox",
  description: "Work through tickets and escalations.",
  supports: d => d.package === "@example/support" &&
    d.resources.some(r => r.route === "tickets"),
  component: SupportInbox,
};

<GizmoWorkspace descriptor={descriptor} call={call} gizmos={[supportInbox]} />;
```

The example above illustrates registration; the console's customer directory
(`packages/console/web/gizmos/customer-directory.tsx`) is a working custom UI with
bounded pagination, search within the loaded page, error/retry states, and a
link back to its collection's forms. Register console gizmos in
`packages/console/web/gizmos/index.ts`. `supports` is a pure, synchronous contract
compatibility check; restrict it by package and required resources/fields as
appropriate. Components can be `React.lazy` components with their own Suspense
fallback. Gizmo IDs must be unique within a registry.

## Shared behavior

- `descriptor` describes the **deployed** application, not an uncommitted draft.
- `call` is the same operation transport used by the forms. In the console it
  preserves environment, purpose, build/deployment preconditions, and server-only
  runtime credentials. It is not a new permission grant.
- `openForms(route?)` opens a standard collection. It refuses navigation while
  the gizmo has reported unsaved work.
- `onDirtyChange` must cover both local edits and pending writes. The host blocks
  switching experiences/environments and warns on reload until it is cleared.
- Switching experiences after saving remounts the destination so it loads fresh
  data. Design/Use switching keeps the active Use experience mounted.
- Custom writes must use the declared operation contracts. Supply
  `expectedVersion` for record updates/actions, handle runtime Problem Details,
  and use changeset review for bulk edits. `EditBuffer` and `buildChangeset` are
  exported for this purpose; gizmos do not get a separate mutation path.
- A render failure is contained to the custom surface so users can reopen the
  generated forms. Async failures should be handled in the gizmo itself.

Gizmos are trusted, bundled application code. This is a component integration
point, not a sandbox for untrusted remote JavaScript, a visual gizmo builder, or
a plugin marketplace. Presentation choices never replace runtime authorization.

Apache-2.0
