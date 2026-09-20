import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Scenario } from "./runner.js";

export const SCENARIO_DIR = resolve(import.meta.dirname, "..", "scenarios");

export function loadScenarios(): Scenario[] {
  return readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(resolve(SCENARIO_DIR, f), "utf8")) as Scenario);
}
