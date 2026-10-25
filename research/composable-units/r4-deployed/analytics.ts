// FORG-38: what the lab cost and how much CPU each Worker used, from Cloudflare's GraphQL analytics.
//
//   CLOUDFLARE_API_TOKEN=$(npx wrangler auth token | tail -1) ACCOUNT=<id> FROM=<iso> TO=<iso> \
//     node research/composable-units/r4-deployed/analytics.ts
//
// Writes results/analytics.json: per lab Worker and status, requests, subrequests, errors, CPU and wall
// time (sum and p50/p99); Dynamic Worker invocations and distinct Dynamic Workers per day (the loader's
// billed unit); D1 queries and rows for the lab databases. The cost estimate prices them at the Workers
// Paid list rates the docs give (README cites them). Analytics lag a few minutes behind the requests.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stableJson } from "../../../packages/units/src/index.ts";
// @ts-expect-error plain module
import { D1, WORKERS } from "./lab/names.mjs";

const token = process.env["CLOUDFLARE_API_TOKEN"];
const account = process.env["ACCOUNT"];
const from = process.env["FROM"];
const to = process.env["TO"] ?? new Date().toISOString();
if (!token || !account || !from) throw new Error("CLOUDFLARE_API_TOKEN, ACCOUNT and FROM are required");

async function gql(query: string, variables: Record<string, unknown>) {
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const j = (await r.json()) as { data: any; errors: unknown };
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data.viewer.accounts[0];
}

const scripts = Object.values(WORKERS) as string[];
const workers = await gql(
  `query($a: String!, $s: Time!, $e: Time!, $names: [String!]) { viewer { accounts(filter: {accountTag: $a}) {
    workersInvocationsAdaptive(limit: 200, filter: {datetime_geq: $s, datetime_leq: $e, scriptName_in: $names}) {
      dimensions { scriptName status }
      sum { requests subrequests errors cpuTimeUs wallTime }
      quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99 }
    } } } }`,
  { a: account, s: from, e: to, names: scripts },
);
const day = (iso: string) => iso.slice(0, 10);
const dynamic = await gql(
  `query($a: String!, $s: Date!, $e: Date!) { viewer { accounts(filter: {accountTag: $a}) {
    workersInvocationsByOwnerAndScriptGroups(limit: 50, filter: {date_geq: $s, date_leq: $e}) { dimensions { date } sum { requests cpuTimeUs } uniq { distinctDynamicWorkerCount } }
  } } }`,
  { a: account, s: day(from), e: day(to) },
);
let d1: unknown = null;
try {
  d1 = (
    await gql(
      `query($a: String!, $s: Time!, $e: Time!) { viewer { accounts(filter: {accountTag: $a}) {
        d1AnalyticsAdaptiveGroups(limit: 50, filter: {datetime_geq: $s, datetime_leq: $e}) { dimensions { databaseId } sum { readQueries writeQueries rowsRead rowsWritten } }
      } } }`,
      { a: account, s: from, e: to },
    )
  ).d1AnalyticsAdaptiveGroups;
} catch (e) {
  d1 = { error: String(e).slice(0, 300) };
}

const rows = workers.workersInvocationsAdaptive as Array<{ dimensions: { scriptName: string; status: string }; sum: any; quantiles: any }>;
const total = rows.reduce((t, r) => ({ requests: t.requests + r.sum.requests, subrequests: t.subrequests + r.sum.subrequests, errors: t.errors + r.sum.errors, cpuMs: t.cpuMs + r.sum.cpuTimeUs / 1000 }), { requests: 0, subrequests: 0, errors: 0, cpuMs: 0 });
const dyn = dynamic.workersInvocationsByOwnerAndScriptGroups as Array<{ dimensions: { date: string }; sum: { requests: number; cpuTimeUs: number }; uniq: { distinctDynamicWorkerCount: number } }>;
const dynTotal = { requests: dyn.reduce((n, d) => n + d.sum.requests, 0), cpuMs: dyn.reduce((n, d) => n + d.sum.cpuTimeUs / 1000, 0), distinctDynamicWorkerDays: dyn.reduce((n, d) => n + d.uniq.distinctDynamicWorkerCount, 0) };

// Workers Paid list rates (developers.cloudflare.com/dynamic-workers/pricing/ and workers/platform/pricing/).
const RATES = { perMillionRequests: 0.3, perMillionCpuMs: 0.02, perDynamicWorkerDay: 0.002, includedRequestsPerMonth: 10_000_000, includedCpuMsPerMonth: 30_000_000, includedDynamicWorkersPerMonth: 1000 };
const requests = total.requests + dynTotal.requests;
const cpuMs = total.cpuMs + dynTotal.cpuMs;
const cost = {
  requests,
  cpuMs: Math.round(cpuMs),
  distinctDynamicWorkerDays: dynTotal.distinctDynamicWorkerDays,
  atOverageRatesUsd: Number(((requests / 1e6) * RATES.perMillionRequests + (cpuMs / 1e6) * RATES.perMillionCpuMs + dynTotal.distinctDynamicWorkerDays * RATES.perDynamicWorkerDay).toFixed(4)),
  shareOfIncluded: { requests: requests / RATES.includedRequestsPerMonth, cpuMs: cpuMs / RATES.includedCpuMsPerMonth, dynamicWorkers: dynTotal.distinctDynamicWorkerDays / RATES.includedDynamicWorkersPerMonth },
  rates: RATES,
};

mkdirSync(join(import.meta.dirname, "results"), { recursive: true });
writeFileSync(
  join(import.meta.dirname, "results/analytics.json"),
  stableJson({
    version: "r4-deployed/1",
    issue: "FORG-38",
    measured: "deployed",
    section: "analytics",
    window: { from, to },
    d1Databases: D1,
    workers: rows.map((r) => ({ script: r.dimensions.scriptName, status: r.dimensions.status, ...r.sum, cpuMs: r.sum.cpuTimeUs / 1000, quantilesUs: r.quantiles })).sort((a, b) => (a.script + a.status < b.script + b.status ? -1 : 1)),
    total,
    dynamicWorkers: { byDay: dyn, total: dynTotal, note: "account-wide: no other Worker on the account used the loader before this run (0 rows for 2026-10-01..25 before the lab deployed)" },
    d1,
    cost,
  }),
);
console.log(JSON.stringify({ total, dynTotal, cost }, null, 1));
