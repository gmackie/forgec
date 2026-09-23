import React, { useState } from "react";
import type { SyntaxNode } from "./language.js";
import { children } from "./model.js";
import { fieldDraft } from "./composer-model.js";

/** Local sample input only. Uses the draft's field model; never calls a deployed app. */
export function FormTrial({ source, fields, onConfigure, editing }: {
  source: string; fields: SyntaxNode[]; onConfigure: (field: SyntaxNode) => void; editing: boolean;
}) {
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [checked, setChecked] = useState(false);
  return <form className="studio-trial-form" aria-label="Try draft form" onSubmit={(event) => { event.preventDefault(); setChecked(true); }}>
    <p>Try entering sample values. Nothing is sent or saved. This checks required fields and basic input formats; business rules are checked by the deployed application.</p>
    <div className="studio-preview-fields">{fields.map((field) => {
      const draft = fieldDraft(source,field);
      const label = draft.name.replace(/([a-z])([A-Z])/g,"$1 $2");
      const scalar = draft.type.replace(/\?$/, "").split(/[\s(<]/)[0];
      const automatic = scalar === "id" || children(field,"DERIVED_VALUE").length > 0;
      const required = !draft.type.includes("?") && !automatic && !draft.value;
      const type = scalar === "email" ? "email" : scalar === "date" ? "date" : scalar === "datetime" ? "datetime-local" : ["decimal","integer","int32","int64"].includes(scalar ?? "") ? "number" : "text";
      return <div key={draft.name} className="studio-trial-field">
        <label>{label}{required ? " *" : ""}
          {automatic ? <output>Assigned or calculated automatically</output> : scalar === "boolean" || scalar === "bool" ? <select value={String(values[draft.name] ?? "")} required={required} onChange={(e) => {setValues({...values,[draft.name]:e.target.value});setChecked(false);}}><option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option></select> : <input type={type} step={type === "number" ? "any" : undefined} required={required} value={String(values[draft.name] ?? "")} onChange={(e) => { setValues({...values,[draft.name]:e.target.value});setChecked(false); }} />}
        </label>
        {editing && <button type="button" onClick={() => onConfigure(field)}>Configure {draft.name}</button>}
      </div>;
    })}</div>
    <button type="submit">Check sample</button> <button type="button" onClick={() => {setValues({});setChecked(false);}}>Clear sample</button>
    {checked && <p role="status">Sample passes basic form checks. No records were saved.</p>}
  </form>;
}
