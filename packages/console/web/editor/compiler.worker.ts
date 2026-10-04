import { language, type OpenApiImportRequest, type Project } from "./language.js";

const ready = fetch(new URL("../../generated/editor.wasm", import.meta.url))
  .then((r) => {
    if (!r.ok) throw new Error("Cannot load the Forge compiler");
    return r.arrayBuffer();
  })
  .then(language);

type WorkerRequest =
  | { kind?: undefined; id: number; project: Project; emit?: "ir" }
  | { kind: "import"; id: number; request: OpenApiImportRequest };

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id } = event.data;
  try {
    const api = await ready;
    if (event.data.kind === "import") {
      const imported = api.importOpenApi(event.data.request);
      if (imported.error) self.postMessage({ id, error: imported.error });
      else self.postMessage({ id, imported });
      return;
    }
    const project = event.data.emit
      ? { ...event.data.project, emit: event.data.emit }
      : event.data.project;
    self.postMessage({ id, analysis: api(project) });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
