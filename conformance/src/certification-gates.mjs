/** Fail closed when live certification is partial or targets another build. */
export function completeSuite(report) {
  const assertions = (report?.testResults ?? []).flatMap((t) => t.assertionResults ?? []);
  return report?.success === true && report.numFailedTests === 0 && report.numPassedTests > 0 && report.numPendingTests === 0 && report.numTodoTests === 0 && assertions.length === report.numPassedTests && assertions.every((a) => a.status === "passed");
}
export function currentScenarios(report, ids) {
  const scenarios = report?.scenarios;
  return Array.isArray(scenarios) && JSON.stringify(scenarios.map(s => s.id).sort()) === JSON.stringify([...ids].sort()) && scenarios.every(s => s.steps > 0 && Array.isArray(s.failures) && s.failures.length === 0);
}
export async function verifyEndpointBuild(url, expected, fetcher = fetch) {
  const response = await fetcher(`${url.replace(/\/$/, "")}/forge/discovery`, { headers: { "x-forge-tenant": "certification", "x-forge-actor": "conformance" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Endpoint discovery returned ${response.status}`);
  const discovery = await response.json();
  if (discovery.buildHash !== expected || response.headers.get("x-forge-build") !== expected) throw new Error("Endpoint build differs from current certification fixture");
  return expected;
}
