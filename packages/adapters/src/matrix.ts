/**
 * Certification matrix (M18; PAR-155). A profile is an exact tuple —
 * engine, driver/mode, runtime host, deployment — and its status is one of
 * `certified` (with evidence), `unverified` (nothing has run) or
 * `unsupported` (a required guarantee is known to fail). Status never
 * derives from names: swapping one component of a certified tuple yields an
 * unverified tuple until the suite has run against it.
 */
export interface ProfileTuple { engine: string; driver: string; runtime: string; deployment: string }
export interface Evidence { suite: string; passed: number; failed: number; at: string; engineVersion?: string; notes?: string }
export interface ProfileEntry { id: string; tuple: ProfileTuple; status: "certified" | "unverified" | "unsupported"; evidence?: Evidence[]; reason?: string }

export const tupleId = (t: ProfileTuple) => `${t.engine}/${t.driver}/${t.runtime}/${t.deployment}`;

export class CertificationMatrix {
  private entries = new Map<string, ProfileEntry>();
  constructor(seed: ProfileEntry[] = []) {
    for (const e of seed) this.entries.set(e.id, e);
  }
  list(): ProfileEntry[] {
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  /** Status for a tuple. Unknown tuples are `unverified`, never inherited from a similar one. */
  status(t: ProfileTuple): ProfileEntry {
    return this.entries.get(tupleId(t)) ?? { id: tupleId(t), tuple: t, status: "unverified", reason: "no suite has run against this exact combination; certification is per tuple, not per component name" };
  }
  /** Record a suite run. Certified only when nothing failed; an existing certification is replaced by the newest evidence. */
  record(t: ProfileTuple, ev: Evidence): ProfileEntry {
    const id = tupleId(t);
    const prev = this.entries.get(id);
    const evidence = [...(prev?.evidence ?? []), ev];
    const entry: ProfileEntry = ev.failed === 0 && ev.passed > 0 ? { id, tuple: t, status: "certified", evidence } : { id, tuple: t, status: "unsupported", evidence, reason: `${ev.failed} required guarantee(s) failed in ${ev.suite}` };
    this.entries.set(id, entry);
    return entry;
  }
  markUnsupported(t: ProfileTuple, reason: string): ProfileEntry {
    const entry: ProfileEntry = { id: tupleId(t), tuple: t, status: "unsupported", reason, ...(this.entries.get(tupleId(t))?.evidence ? { evidence: this.entries.get(tupleId(t))!.evidence! } : {}) };
    this.entries.set(entry.id, entry);
    return entry;
  }
  /** Production certification request: only a certified tuple with evidence passes; anything else is refused with the exact reason. */
  requireCertified(t: ProfileTuple): { ok: true; entry: ProfileEntry } | { ok: false; status: ProfileEntry["status"]; reason: string } {
    const e = this.status(t);
    if (e.status === "certified" && e.evidence?.length) return { ok: true, entry: e };
    return { ok: false, status: e.status, reason: e.reason ?? `status is ${e.status}` };
  }
  toJSON(): { version: string; profiles: ProfileEntry[] } {
    return { version: "certification-matrix/1", profiles: this.list() };
  }
}
