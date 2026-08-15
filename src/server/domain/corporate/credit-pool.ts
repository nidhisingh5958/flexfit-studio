/**
 * Computes a company's new `creditPoolBalance` after applying a signed
 * delta (positive to add credits back, negative to debit them),
 * optionally flooring the result at zero.
 *
 * This is a pure calculation only — it does not decide whether an update
 * should happen at all. Each call site in corporate-bookings.ts keeps its
 * own existing guard (e.g. whether the pool can cover the promoted
 * class's cost before charging it) exactly as before.
 *
 * Deliberately NOT the same function as adjustIndividualCredits
 * (src/server/domain/membership/credits.ts), and does not call it or
 * share an implementation with it. Per audit finding DUP-005, the two
 * payer types have genuinely different shortfall behavior on waitlist
 * promotion: the individual flow always debits, floored at zero; the
 * corporate flow skips the debit entirely if the pool can't cover it.
 * That difference lives entirely in each router's own guard (whether
 * this function is called at all), not in the arithmetic itself, and
 * must not be merged away by sharing one function between the two.
 */
export function adjustCorporatePool(
  balance: number,
  delta: number,
  floor: boolean,
): number {
  const next = balance + delta;
  return floor ? Math.max(0, next) : next;
}
