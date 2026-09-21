import type { Project } from "./language.js";
import contacts from "../../../../examples/studio-desk/src/contacts.forge?raw";
import tickets from "../../../../examples/studio-desk/src/tickets.forge?raw";
import plans from "../../../../examples/studio-desk/src/plans.forge?raw";
import governance from "../../../../examples/studio-desk/src/governance.forge?raw";
import types from "../../../../examples/studio-desk/src/types.forge?raw";
import events from "../../../../examples/studio-desk/src/events.forge?raw";
import operations from "../../../../examples/studio-desk/src/operations.forge?raw";

export const example: Project = {
  name: "@demo/service-desk",
  currentFile: "contacts.forge",
  files: [
    { path: "contacts.forge", text: contacts },
    { path: "tickets.forge", text: tickets },
    { path: "plans.forge", text: plans },
    { path: "governance.forge", text: governance },
    { path: "types.forge", text: types },
    { path: "events.forge", text: events },
    { path: "operations.forge", text: operations },
  ],
};
