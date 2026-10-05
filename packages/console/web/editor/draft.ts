import type { Project } from "./language.js";

/** Shared with the visual editor. The playground and the editor edit one browser draft. */
export const storageKey = "forge.visual-editor.v1";
export const draftChanged = "forge-draft-changed";

export interface StoredDraft {
  project: Project;
  repository: unknown;
}

export function isProject(value: unknown): value is Project {
  if (!value || typeof value !== "object") return false;
  const project = value as Project;
  return (
    typeof project.name === "string" &&
    Array.isArray(project.files) &&
    project.files.length > 0 &&
    project.files.length <= 50 &&
    project.files.every(
      (file) => typeof file.path === "string" && typeof file.text === "string",
    ) &&
    project.files.some((file) => file.path === project.currentFile)
  );
}

export function readDraft(): StoredDraft | null {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || "null");
    const project = stored?.project ?? stored;
    if (!isProject(project)) return null;
    return { project, repository: stored?.repository ?? null };
  } catch {
    return null;
  }
}

/** Persists the draft and tells other open views in this tab to reload it. */
export function writeDraft(project: Project, repository?: unknown) {
  const payload = {
    project,
    repository: repository === undefined ? (readDraft()?.repository ?? null) : repository,
  };
  localStorage.setItem(storageKey, JSON.stringify(payload));
  window.dispatchEvent(new CustomEvent(draftChanged));
}
