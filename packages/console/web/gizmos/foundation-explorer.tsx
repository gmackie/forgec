import React from "react";
import type { GizmoDefinition, GizmoProps, UiResource } from "@forgegraph/react";

const prefix = "@forgegraph/foundation/";
const foundation = (r: UiResource) => r.id.startsWith(prefix) ? r.id.slice(prefix.length).split("/")[0] : undefined;
const descriptions: Record<string, string> = {
  specification: "Browse specifications, pinned versions, and their source references.",
  artifact: "Inspect artifacts, components, and realization provenance.",
  identifiers: "Find identifiers, validity periods, and supersession records.",
  participation: "Inspect participants and relationships. Record visibility does not establish an access grant.",
  evidence: "Browse evidence records and their supporting references.",
  decision: "Follow decisions and the records supporting them.",
  change: "Inspect changes and their review history.",
  lineage: "Trace recorded relationships between inputs and outcomes.",
  collaboration: "Browse shared work and recorded contributions.",
};
export function FoundationExplorer({ descriptor, openForms }: GizmoProps) {
  const resources = descriptor.resources.filter((r) => foundation(r));
  const groups = [...new Set(resources.map((r) => foundation(r)!))];
  return <section className="foundation-explorer" aria-label="Foundation records">
    <p>Explore the shared records behind this application. Collections appear only when they are included in the deployed application.</p>
    <div className="gizmo-cards">{groups.map((group) => <section key={group} className="foundation-card">
      <h3>{group.replaceAll("-", " ").replace(/^./, (s) => s.toUpperCase())}</h3>
      <p>{descriptions[group] ?? "Browse the shared records and relationships supplied by this foundation package."}</p>
      {resources.filter((r) => foundation(r) === group).map((r) => <button type="button" key={r.id} onClick={() => openForms(r.route)}>{r.plural} <span aria-hidden>→</span></button>)}
    </section>)}</div>
  </section>;
}
export const foundationExplorer: GizmoDefinition = {
  id: "foundation-records",
  title: "Application foundations",
  description: "Explore specifications, artifacts, identifiers, participation, and other shared application records.",
  supports: (descriptor) => descriptor.resources.some((r) => !!foundation(r)),
  component: FoundationExplorer,
};
