import { language, type Project } from "./language.js";
const ready = fetch(new URL("../../generated/editor.wasm", import.meta.url))
  .then((r) => {
    if (!r.ok) throw new Error("Cannot load the Forge compiler");
    return r.arrayBuffer();
  })
  .then(language);
self.onmessage = async (
  event: MessageEvent<{ id: number; project: Project; emit?: "ir" }>,
) => {
  try {
    const inspect = await ready;
    const project = event.data.emit
      ? { ...event.data.project, emit: event.data.emit }
      : event.data.project;
    self.postMessage({
      id: event.data.id,
      analysis: inspect(project),
    });
  } catch (error) {
    self.postMessage({ id: event.data.id, error: String(error) });
  }
};
