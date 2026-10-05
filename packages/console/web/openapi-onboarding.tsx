import React, { useState } from "react";
import type { OpenApiImport, OpenApiImportRequest, OpenApiReport } from "./editor/language.js";
import { openApiSamples } from "./editor/openapi-samples.js";

export interface DiscoveredApi {
  path: string;
  packageName: string;
  text: string;
  focus: string;
  report: OpenApiReport;
}

function slugFrom(packageName: string) {
  const raw = packageName.split("/").pop() ?? "";
  const slug = raw.replace(/[^A-Za-z0-9_-]/g, "");
  return slug || "api";
}

function fieldsOf(report: OpenApiReport) {
  return [...new Set(report.foreignIdentifiers.map((item) => item.field))];
}

export function OpenApiOnboarding({
  importSpec,
  onUse,
  onAdd,
}: {
  importSpec: (request: OpenApiImportRequest) => Promise<OpenApiImport>;
  onUse: (api: DiscoveredApi) => void;
  onAdd: (api: DiscoveredApi) => void;
}) {
  const [packageName, setPackageName] = useState("@external/api");
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<DiscoveredApi | null>(null);

  async function discover(text: string, nextPackage: string, id: string | null, allowHosts: string[]) {
    setBusy(true);
    setError("");
    try {
      const imported = await importSpec({
        text,
        package: nextPackage,
        ...(allowHosts.length ? { allowHosts } : {}),
      });
      if (imported.error) {
        setPreview(null);
        setError(imported.error);
        return;
      }
      const forge = imported.files?.find((file) => file.path.endsWith(".forge"));
      const report = imported.report;
      const focus = report?.operations[0]?.function ?? "";
      if (!forge || !report || !focus) {
        setPreview(null);
        setError("This document did not discover any operations.");
        return;
      }
      setPreview({
        path: `external/${id ?? slugFrom(nextPackage)}.forge`,
        packageName: nextPackage,
        text: forge.text,
        focus,
        report,
      });
    } catch (reason) {
      setPreview(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  const foreign = preview ? fieldsOf(preview.report) : [];

  return (
    <details className="playground-openapi">
      <summary>Import OpenAPI</summary>
      <p className="muted small">
        Import an OpenAPI 3 document in this browser. Forge does not call the host.
      </p>
      <div className="playground-openapi-samples">
        {openApiSamples.map((sample) => (
          <button
            key={sample.id}
            type="button"
            disabled={busy}
            onClick={() => void discover(sample.text, sample.package, sample.id, [sample.host])}
          >
            {sample.title}
          </button>
        ))}
      </div>
      <label>
        Package
        <input
          aria-label="OpenAPI package"
          value={packageName}
          onChange={(event) => setPackageName(event.target.value)}
        />
      </label>
      <label>
        OpenAPI document
        <textarea
          aria-label="OpenAPI document"
          value={pasted}
          onChange={(event) => setPasted(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={busy || !pasted.trim() || !packageName.trim()}
        onClick={() => void discover(pasted, packageName.trim(), null, [])}
      >
        Discover pasted spec
      </button>
      {error ? (
        <p className="playground-error" role="alert">
          {error}
        </p>
      ) : null}
      {preview ? (
        <div className="playground-openapi-preview">
          <p>
            <strong>{preview.report.source.title}</strong>
          </p>
          <ul>
            {preview.report.operations.map((operation) => (
              <li key={`${operation.method} ${operation.path}`}>
                {operation.method} {operation.path} · {operation.function}
              </li>
            ))}
          </ul>
          <p className="muted small">
            Hosts {preview.report.hosts.join(", ") || "none"}. Forge did not call this host.
          </p>
          {foreign.length ? (
            <p className="muted small">Foreign ids stay text: {foreign.join(", ")}.</p>
          ) : null}
          {preview.report.skippedOperations.length ? (
            <p className="muted small">Skipped: {preview.report.skippedOperations.join(", ")}.</p>
          ) : null}
          {preview.report.unsupported.length ? (
            <p className="muted small">
              Unsupported: {preview.report.unsupported.map((item) => item.feature).join(", ")}.
            </p>
          ) : null}
          <div className="playground-openapi-samples">
            <button type="button" onClick={() => onUse(preview)}>
              Use this API
            </button>
            <button type="button" onClick={() => onAdd(preview)}>
              Add to this program
            </button>
          </div>
        </div>
      ) : null}
    </details>
  );
}
