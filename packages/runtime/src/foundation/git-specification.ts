/** Node Git adapter. Only configured local repositories are accessible; fetching and
 * authentication remain host responsibilities. No selector is passed to a shell. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { validateSpecificationPin, type SpecificationPin, type SpecificationProvider, type PinnedSourceMap } from "./specification.js";
const exec = promisify(execFile);
export interface GitSpecificationRepository { directory: string; sourceMap: string }
export class GitSpecificationProvider implements SpecificationProvider {
  private readonly repositories: ReadonlyMap<string, GitSpecificationRepository>;
  constructor(repositories: Readonly<Record<string, GitSpecificationRepository>>) {
    this.repositories = new Map(Object.entries(repositories).map(([id, config]) => [id, { ...config }]));
  }
  private config(repository: string) {
    const config = this.repositories.get(repository);
    if (!config) throw new Error("Unknown specification repository");
    return config;
  }
  private async git(repository: string, args: string[]): Promise<Buffer> {
    const { stdout } = await exec("git", ["--no-replace-objects", "-C", this.config(repository).directory, ...args], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 15_000 });
    return stdout;
  }
  private async blob(repository: string, revision: string, path: string) {
    if (!path || path.startsWith("/") || path.split("/").some(p => p === ".." || p === ".") || /[\0\\]/.test(path)) throw new Error("Invalid pinned source path");
    return this.git(repository, ["cat-file", "blob", `${revision}:${path}`]);
  }
  async resolveSelector(request: { repository: string; anchor: string; selector: string }): Promise<SpecificationPin> {
    if (!request.selector || request.selector.length > 1024 || /[\0\r\n]/.test(request.selector)) throw new Error("Invalid Git selector");
    const revision = (await this.git(request.repository, ["rev-parse", "--verify", "--end-of-options", `${request.selector}^{commit}`])).toString("utf8").trim();
    const pin = { repository: request.repository, anchor: request.anchor, revision };
    validateSpecificationPin(pin);
    const { map } = await this.sourceMap(pin);
    if (!Object.hasOwn(map.anchors, pin.anchor)) throw new Error("Semantic anchor is absent at selected commit");
    return pin;
  }
  async sourceMap(pin: SpecificationPin): Promise<{ repository: string; map: PinnedSourceMap }> {
    validateSpecificationPin(pin);
    const config = this.config(pin.repository);
    const map = JSON.parse((await this.blob(pin.repository, pin.revision, config.sourceMap)).toString("utf8"));
    if (map.version !== "forge-source-map/1" || map.revision != null && map.revision !== pin.revision || !map.sources || !map.anchors) throw new Error("Invalid or mismatched pinned source map");
    const lengths = new Map<string, number>();
    for (const [path, source] of Object.entries(map.sources) as [string, { digest: string; byteLength: number }][]) {
      const bytes = await this.blob(pin.repository, pin.revision, path);
      if (source.digest !== `sha256:${createHash("sha256").update(bytes).digest("hex")}` || source.byteLength !== bytes.length) throw new Error("Pinned source digest mismatch");
      lengths.set(path, bytes.length);
    }
    for (const span of Object.values(map.anchors) as { file: string; start: number; end: number }[]) {
      if (!lengths.has(span.file) || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end < span.start || span.end > lengths.get(span.file)!) throw new Error("Invalid source span in pinned map");
    }
    return { repository: pin.repository, map: { version: "forge-source-map/1", revision: pin.revision, anchors: map.anchors } };
  }
  /** Dependency closure is read from the pinned tree, never the working directory. */
  async lockfile(pin: SpecificationPin): Promise<string> {
    validateSpecificationPin(pin);
    return (await this.blob(pin.repository, pin.revision, "forge.lock")).toString("utf8");
  }
}
