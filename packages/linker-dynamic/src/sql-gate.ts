// Table-level narrowing of the child's D1 handle. The child's runtime still speaks SQL (it runs the
// unmodified D1 adapter), so the host checks every statement it forwards: each table a statement
// reads must be readable and the table it writes must be writable under the closure's policy.
// Statements this scanner cannot classify are refused. This is a research-grade check over the
// SQL the runtime generates, not a SQL parser; see README "Sandbox".
import { LinkError } from "./manifest.ts";

const TABLE_REF = /\b(from|join|into|update|table)\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_]*)\s*(\()?/gi;
const CTE = /\b(?:with(?:\s+recursive)?|,)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^()]*\))?\s+as\s*\(/gi;
const WRITE = /^\s*(insert|update|delete|replace)\b/i;
const KEYWORDS = new Set(["set", "select", "values"]);
const TABLE_FUNCTIONS = new Set(["json_each", "json_tree"]);

export interface TableAccess {
  write: string | null;
  read: string[];
}

const unquote = (t: string) => (t.startsWith('"') ? t.slice(1, -1).replaceAll('""', '"') : t).toLowerCase();

export function tableAccess(sql: string): TableAccess {
  // Bound parameters carry values; strip string literals so their contents cannot look like tables.
  const text = sql.replace(/'(?:[^']|'')*'/g, "''");
  const ctes = new Set([...text.matchAll(CTE)].map((m) => m[1]!.toLowerCase()));
  const refs: Array<{ kw: string; name: string }> = [];
  for (const m of text.matchAll(TABLE_REF)) {
    const name = unquote(m[2]!);
    if (KEYWORDS.has(name) || ctes.has(name)) continue;
    if (m[3] && TABLE_FUNCTIONS.has(name)) continue;
    refs.push({ kw: m[1]!.toLowerCase(), name });
  }
  const verb = WRITE.exec(text)?.[1]?.toLowerCase();
  if (!verb) {
    if (!/^\s*(select|with)\b/i.test(text)) throw new LinkError("CapabilityDenied", [`unclassified statement refused: ${text.slice(0, 80)}`]);
    return { write: null, read: [...new Set(refs.map((r) => r.name))] };
  }
  const targetKw = verb === "update" ? "update" : verb === "delete" ? "from" : "into";
  const target = refs.find((r) => r.kw === targetKw);
  if (!target) throw new LinkError("CapabilityDenied", [`write statement without a recognisable target refused: ${text.slice(0, 80)}`]);
  return { write: target.name, read: [...new Set(refs.filter((r) => r !== target).map((r) => r.name))] };
}

export function checkSql(sql: string, policy: { label: string; tables: { read: string[]; write: string[] } }): void {
  const access = tableAccess(sql);
  const denied: string[] = [];
  if (access.write && !policy.tables.write.includes(access.write)) denied.push(`write ${access.write}`);
  for (const t of access.read) if (!policy.tables.read.includes(t)) denied.push(`read ${t}`);
  if (denied.length) throw new LinkError("CapabilityDenied", [`${policy.label} has no capability to ${denied.join(", ")}`]);
}
