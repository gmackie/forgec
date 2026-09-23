import { err, type ForgeError } from "./errors.js";
import type { AtomicAbsenceGuard, CommitPlan } from "./services.js";

/** Storage-level defense: no transaction can publish a fact it requires absent. */
export function absenceWriteConflict(plans: readonly CommitPlan[], absent: readonly AtomicAbsenceGuard[]): ForgeError | null {
  for (const guard of absent) {
    if (!guard.resource.decorators.appendOnly || guard.unique.condition) return err("ValidationFailed", "Unsupported atomic absence guard");
    if (plans.some(plan => plan.tenant === guard.tenant && plan.claims.some(claim => claim.after === guard.claimKey))) {
      return err("ValidationFailed", "Atomic mutation creates a fact required to be absent");
    }
  }
  return null;
}
