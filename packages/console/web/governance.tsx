import React from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Table } from "@cloudflare/kumo/components/table";
import type { PackageSummary } from "../src/oci.js";

export function PackageGovernance({ governance }: { governance: PackageSummary["governance"] }) {
  const semantics = governance?.dataSemantics;
  return <>
    <section className="panel detail-panel">
      <h2>Data classification</h2>
      {semantics ? <>
        <p>Forge taxonomy <code>{semantics.taxonomy}</code></p>
        <p className="muted">Classification and evidence compiled by Forge for this package version.</p>
        <div className="table-scroll">
          <Table>
            <Table.Header><Table.Row>
              <Table.Head>Resource / field</Table.Head><Table.Head>Data class</Table.Head>
              <Table.Head>Handling</Table.Head><Table.Head>Identifiability</Table.Head>
              <Table.Head>Personal</Table.Head><Table.Head>Evidence</Table.Head>
            </Table.Row></Table.Header>
            <Table.Body>{semantics.fields.map(f => <Table.Row key={`${f.resource}.${f.field}`}>
              <Table.Cell><code>{f.resource}</code><p><strong>{f.field}</strong></p></Table.Cell>
              <Table.Cell><code>{f.class}</code><details><summary>Ancestry and kinds</summary>
                <p>{f.ancestors.join(" → ")}</p><p>{f.kinds.join(", ")}</p>
              </details></Table.Cell>
              <Table.Cell><Badge variant="secondary">{f.handling}</Badge></Table.Cell>
              <Table.Cell>{f.identifiability}</Table.Cell><Table.Cell>{f.personal}</Table.Cell>
              <Table.Cell><span>{f.evidence}</span><p className="muted small">{f.completeness}</p></Table.Cell>
            </Table.Row>)}</Table.Body>
          </Table>
        </div>
        {!!semantics.subjects.length && <details><summary>Subject bindings</summary>
          {semantics.subjects.map(s => <div key={s.resource}><code>{s.resource}</code>
            <p>{s.kind}{s.via ? ` via ${s.via}` : ""}</p>
            {s.accessPath && <p>Access path: {s.accessPath}</p>}
            {s.recordContext && <p>Record context: {s.recordContext}</p>}
          </div>)}
        </details>}
      </> : <p className="muted">This bundle has no compiled data classification metadata.</p>}
      {!!governance?.dataClasses.length && <details><summary>Package data-class extensions</summary>
        {governance.dataClasses.map(c => <p key={c.id}><code>{c.id}</code> extends <code>{c.extends}</code></p>)}
      </details>}
    </section>
    <section className="panel detail-panel">
      <h2>Purposes and capability surfaces</h2>
      <p className="muted">Purpose relationships grant no access. Explicit capability bindings define each resource’s allowed operations.</p>
      {!!governance?.purposes.length && <details><summary>Declared purpose taxonomy</summary>
        {governance.purposes.map(p => <p key={p.id}><code>{p.id}</code>{p.extends && <> extends <code>{p.extends}</code></>}</p>)}
      </details>}
      {governance?.surfaces.length ? governance.surfaces.map(s => <div className="purpose-surface" key={`${s.resource}:${s.purpose}`}>
        <h3><code>{s.purpose}</code></h3><p>Resource <code>{s.resource}</code></p>
        <div className="badges">{s.capabilities.map(c => <Badge key={c} variant="secondary">{c}</Badge>)}</div>
        <details><summary>Allowed operations ({s.allowAtoms.length})</summary>
          {s.allowAtoms.map(a => <p key={`${a.verb}:${a.name}`}><code>{a.verb} {a.name}</code> <span className="muted">via {a.origin.join(" → ")}</span></p>)}
        </details>
        <details><summary>Denied operations ({s.deny.length})</summary>
          {s.deny.length ? s.deny.map(a => <p key={`${a.verb}:${a.name}`}><code>{a.verb} {a.name}</code> <span className="muted">via {a.origin.join(" → ")}</span></p>) : <p>No explicit deny atoms.</p>}
        </details>
      </div>) : <p className="muted">No compiled purpose surfaces. No purpose-based access is implied.</p>}
    </section>
  </>;
}
