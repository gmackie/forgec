import { expect, it } from "vitest";
import { completeSuite, currentScenarios, verifyEndpointBuild } from "../src/certification-gates.mjs";

it("requires a successful complete invocation with no skipped assertions", () => {
  const report = { success: true, numFailedTests: 0, numPassedTests: 1, numPendingTests: 0, numTodoTests: 0, testResults: [{ assertionResults: [{ status: "passed" }] }] };
  expect(completeSuite(report)).toBe(true);
  for (const patch of [{success:false}, {numPendingTests:1}, {numTodoTests:1}, {numFailedTests:1}, {numPassedTests:0}, {testResults:[]}]) expect(completeSuite({...report,...patch})).toBe(false);
});

it("requires exactly the current scenario IDs and no failed or empty traces", () => {
  const traces = [{id:"a", steps:2, failures:[]}, {id:"b", steps:1, failures:[]}];
  expect(currentScenarios({scenarios:traces}, ["a","b"])).toBe(true);
  for (const scenarios of [[], traces.slice(1), [traces[0],traces[0]], [...traces,{id:"c",steps:1,failures:[]}], [{...traces[0],steps:0},traces[1]], [{...traces[0],failures:["bad"]},traces[1]]]) expect(currentScenarios({scenarios},["a","b"])).toBe(false);
});

it("rejects a reachable endpoint serving another build", async () => {
  const fetcher = async () => new Response(JSON.stringify({buildHash:"current"}), {headers:{"x-forge-build":"current"}});
  await expect(verifyEndpointBuild("https://test.invalid", "current", fetcher)).resolves.toBe("current");
  await expect(verifyEndpointBuild("https://test.invalid", "other", fetcher)).rejects.toThrow(/build/);
  await expect(verifyEndpointBuild("https://test.invalid", "current", async () => new Response("denied",{status:403}))).rejects.toThrow(/403/);
});
