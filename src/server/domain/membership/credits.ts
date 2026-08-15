/**
 * Computes a membership's new `creditsRemaining` value after applying a
 * signed delta (positive to add credits back, negative to debit them),
 * optionally flooring the result at zero.
 *
 * This is a pure calculation only — it does not check whether the
 * membership is unlimited, does not decide whether an update should
 * happen at all, and does not touch the database. Each call site in
 * bookings.ts keeps its own existing guard (whether the membership is
 * unlimited, whether the write should happen) exactly as before; this
 * function only replaces the arithmetic that was previously duplicated
 * three times: a plain debit (book), a plain credit (cancel refund), and
 * a floored debit (waitlist promotion charge).
 */
export function adjustIndividualCredits(
  remaining: number,
  delta: number,
  floor: boolean,
): number {
  const next = remaining + delta;
  return floor ? Math.max(0, next) : next;
}
