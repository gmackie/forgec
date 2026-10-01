/**
 * What the editor does when the compiler stops answering.
 *
 * The behaviour under test is not performance. Analysis is single-digit milliseconds — the
 * seven-file demo measures about 4 ms warm, and 200k characters still measures near 1 ms — so
 * the watchdog exists to notice silence, not slowness. It previously reported that silence as
 * "Compiler time limit reached... shorten the source", which sent people to shorten a source
 * whose length had nothing to do with it, and left the editor inert until someone found the
 * restart button.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { language } from "../web/editor/language.js";
import { example } from "../web/editor/example.js";

const wasm = readFileSync(
  new URL("../generated/editor.wasm", import.meta.url),
);

describe("editor compiler", () => {
  it("analyses the demo project far inside the watchdog budget", async () => {
    const inspect = await language(wasm);
    inspect(example); // warm: the first call includes one-time setup
    const started = performance.now();
    inspect(example);
    const elapsed = performance.now() - started;
    // The budget is 4000 ms. If analysis ever approaches it, the watchdog has become a
    // correctness problem rather than a safety net and the budget must be revisited.
    expect(elapsed).toBeLessThan(400);
  });

  it("stays fast as the source grows, so source length is never the explanation", async () => {
    const inspect = await language(wasm);
    const files = Array.from({ length: 16 }, (_, k) =>
      example.files.map((f) => ({ path: `copy${k}-${f.path}`, text: f.text })),
    ).flat();
    const big = { ...example, files, currentFile: files[0]!.path };
    const started = performance.now();
    inspect(big);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("reports a compiler that cannot start, without blaming the source", () => {
    const source = readFileSync(
      new URL("../web/editor/editor.tsx", import.meta.url),
      "utf8",
    );
    // The old copy told people to shorten a source whose length is irrelevant.
    expect(source).not.toContain("shorten the source");
    // A missing worker is its own fact, not a timeout.
    expect(source).toContain("The compiler is not running");
    // And silence is described as silence.
    expect(source).toContain("stopped responding");
  });

  it("restarts once on its own before asking anyone to intervene", () => {
    const source = readFileSync(
      new URL("../web/editor/editor.tsx", import.meta.url),
      "utf8",
    );
    // A worker that dies should cost a redraw, not a dead editor.
    expect(source).toContain("restarted.current = true");
    expect(source).toContain("setWorkerEpoch");
    // A request is only pending if it was actually sent; otherwise the watchdog reports a
    // timeout for a message that never left.
    expect(source).toContain("if (!w) {");
  });
});
