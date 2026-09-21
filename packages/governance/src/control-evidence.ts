/**
 * Versioned control packs and bounded evidence export (FORGE-081). A pack
 * maps technical controls to their sources (tests, plans, ledgers) with an
 * applicability fact and a state: `measured` (from a suite or drill),
 * `attested` (a human says so, with who/when), or `unknown`. It cannot
 * advertise blanket regulatory compliance: `assertCompliance` refuses, and
 * every report leads with assumptions, review requirements and stale
 * evidence. OSCAL export is bounded to a component definition with
 * implemented requirements and their evidence links.
 */
export interface Control { id: string; title: string; sources: string[]; applicability: { fact: string; applies: boolean | "unknown" }; state: "measured" | "attested" | "unknown"; evidence?: { ref: string; at: string; by?: string }; assumptions?: string[]; reviewRequired?: boolean }
export interface ControlPack { version: "control-pack/1"; package: string; artifact: string; controls: Control[]; evidenceWindowMs: number; disclaimer: string }

export const DISCLAIMER = "Technical controls only. Legal disposition of subject rights, regulatory applicability and compliance determinations remain externally accountable; this pack never claims GDPR, FERPA, COPPA or any framework compliance.";

export function controlPack(o: { package: string; artifact: string; controls: Control[]; evidenceWindowMs?: number }): ControlPack {
  for (const c of o.controls) {
    if (/compliant|compliance with (gdpr|ferpa|coppa|hipaa|soc ?2)/i.test(c.title)) throw new Error(`control ${c.id}: a control describes a technical measure, not a compliance claim`);
    if (c.state === "attested" && !c.evidence?.by) throw new Error(`control ${c.id}: an attestation names who attested and when`);
    if (c.state === "measured" && !c.evidence?.ref) throw new Error(`control ${c.id}: a measured control references its evidence`);
  }
  return { version: "control-pack/1", package: o.package, artifact: o.artifact, controls: o.controls, evidenceWindowMs: o.evidenceWindowMs ?? 90 * 86_400_000, disclaimer: DISCLAIMER };
}

export function assertCompliance(_pack: ControlPack, framework: string): never {
  throw new Error(`${framework} compliance is a legal determination made outside this package; export the evidence report and have it reviewed`);
}

export interface EvidenceReport { package: string; artifact: string; generatedAt: string; assumptions: string[]; reviewRequired: string[]; stale: string[]; unknown: string[]; controls: { id: string; state: string; applies: boolean | "unknown"; evidence?: string; stale: boolean }[]; disclaimer: string }

export function evidenceReport(pack: ControlPack, now = Date.now()): EvidenceReport {
  const stale: string[] = [];
  const unknown: string[] = [];
  const reviewRequired: string[] = [];
  const assumptions: string[] = [];
  const controls = pack.controls.map((c) => {
    const isStale = Boolean(c.evidence && now - Date.parse(c.evidence.at) > pack.evidenceWindowMs);
    if (isStale) stale.push(c.id);
    if (c.state === "unknown" || c.applicability.applies === "unknown") unknown.push(c.id);
    if (c.reviewRequired || c.state === "attested") reviewRequired.push(c.id);
    for (const a of c.assumptions ?? []) assumptions.push(`${c.id}: ${a}`);
    return { id: c.id, state: c.state, applies: c.applicability.applies, ...(c.evidence ? { evidence: c.evidence.ref } : {}), stale: isStale };
  });
  return { package: pack.package, artifact: pack.artifact, generatedAt: new Date(now).toISOString(), assumptions, reviewRequired, stale, unknown, controls, disclaimer: pack.disclaimer };
}

/** Bounded OSCAL component definition: one component, implemented requirements with evidence links; nothing more. */
export function exportOscal(pack: ControlPack, now = Date.now()): Record<string, unknown> {
  const report = evidenceReport(pack, now);
  return {
    "component-definition": {
      uuid: `forge-${pack.artifact.slice(0, 12)}`,
      metadata: { title: `${pack.package} technical controls`, "last-modified": report.generatedAt, version: pack.artifact.slice(0, 12), "oscal-version": "1.1.2", remarks: pack.disclaimer },
      components: [{
        uuid: `forge-component-${pack.artifact.slice(0, 12)}`,
        type: "software",
        title: pack.package,
        description: "Forge-built service; controls are technical measures with evidence, not compliance determinations",
        "control-implementations": [{
          uuid: `forge-impl-${pack.artifact.slice(0, 12)}`,
          source: "forge://technical-controls/1",
          description: "Technical control implementations",
          "implemented-requirements": pack.controls.map((c) => ({
            uuid: `forge-req-${c.id}`,
            "control-id": c.id,
            description: c.title,
            props: [{ name: "state", value: c.state }, { name: "applies", value: String(c.applicability.applies) }, { name: "stale", value: String(report.stale.includes(c.id)) }],
            ...(c.evidence ? { links: [{ href: c.evidence.ref, rel: "evidence" }] } : {}),
            remarks: [...(c.assumptions ?? []), ...(c.reviewRequired ? ["review required"] : [])].join("; ") || undefined,
          })),
        }],
      }],
    },
  };
}
