// External binding for payments.AuthorizePayment (plan §14: external slots are
// explicit). The reference deployment approves every amount below 1000.00 and
// declines above, so the SubmitOrder error paths are reachable end to end.
import type { ExternalBinding } from "@forgegraph/runtime";

export const authorizePayment: ExternalBinding = async (input) => {
  const amount = Number((input as { amount: string }).amount);
  if (!Number.isFinite(amount)) return { ok: false, code: "PaymentUnavailable", detail: "amount missing" };
  if (amount >= 1000) return { ok: false, code: "PaymentDeclined", detail: `amount ${amount.toFixed(2)} exceeds the authorization limit` };
  return { ok: true, value: { authorizationId: `auth_${Math.random().toString(36).slice(2, 10)}` } };
};
