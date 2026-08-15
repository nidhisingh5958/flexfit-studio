import { describe, it, expect } from "vitest";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createClass,
  createCompany,
  linkMemberToCompany,
  getCompany,
  getCorporateBooking,
  hoursFromNow,
} from "../helpers";

// Flow 12 (corporate waitlist promotion) + DUP-005: the same promotion rule
// as bookings.cancel, but with a DIFFERENT credit-shortfall behavior.
// Source: src/server/routers/corporate-bookings.ts `cancel` promotion block
// (lines ~224-262): `if (company.creditPoolBalance >= row.cls.creditCost)`
// — skips the debit entirely if short, vs. the individual flow's
// `Math.max(0, remaining - cost)`, which always debits, floored at zero.
describe("corporate waitlist promotion", () => {
  const t = useTestDatabase();

  it("promotes the oldest waitlisted corporate booking and debits the pool by the class's creditCost", async () => {
    const cls = await createClass(t.db, { capacity: 1, creditCost: 5, startsAt: hoursFromNow(48) });
    const company = await createCompany(t.db, { creditPoolBalance: 20 });

    const holder = await createMember(t.db);
    await linkMemberToCompany(t.db, holder.id, company.id);
    const holderBooking = await callerAs(t.db, holder).corporateBookings.book({ classId: cls.id });

    const waiter = await createMember(t.db);
    await linkMemberToCompany(t.db, waiter.id, company.id);
    const waiterBooking = await callerAs(t.db, waiter).corporateBookings.book({ classId: cls.id });
    expect(waiterBooking.status).toBe("waitlisted");
    expect((await getCompany(t.db, company.id))?.creditPoolBalance).toBe(15); // only holder charged so far

    await callerAs(t.db, holder).corporateBookings.cancel({ bookingId: holderBooking.id });

    const promoted = await getCorporateBooking(t.db, waiterBooking.id);
    expect(promoted?.status).toBe("booked");
    expect(promoted?.creditsUsed).toBe(5);
    // holder's cancellation happens within the 24h window here (class is far
    // in the future), so their credits are refunded (+5), then the waiter is
    // charged (-5): net pool balance is unchanged from the pre-cancel value.
    expect((await getCompany(t.db, company.id))?.creditPoolBalance).toBe(15);
  });

  it("DUP-005 / CURRENT BEHAVIOR: unlike the individual flow, if the pool can't cover the promoted class, the promotion still succeeds but the pool is left UNCHANGED (not floored to zero)", async () => {
    // Bookkeeping for this scenario (pool balance after each step). The
    // ending pool balance before promotion is deliberately left NON-ZERO
    // (2) against a promotion cost of 6 — per audit finding DUP-005 and the
    // Phase 2 review, a balance of exactly 0 makes "skip the debit"
    // (leaves it at 0) and "floor to zero" (Math.max(0, 0-6) = 0)
    // indistinguishable. With a balance of 2 at promotion time:
    //   - skip if insufficient (this router's actual code):  unchanged = 2
    //   - floor to zero (the individual flow's pattern):     Math.max(0, 2-6) = 0
    // These differ, so the final pool balance actually proves which of the
    // two behaviors corporate-bookings.ts `cancel`'s promotion block uses.
    //
    //   company starts at 20
    //   holder books cls (cost 6, capacity 1)          -> 20 - 6 = 14  [booked]
    //   waiter joins waitlist for cls (pool 14 >= 6 OK  -> 14          [waitlisted, no charge]
    //     to join, but the class is already full)
    //   waiter books an unrelated class (cost 12)       -> 14 - 12 = 2 [booked]
    //   holder cancels cls booking, OUTSIDE the 24h      -> 2           [no refund:
    //     free-cancellation window (cls starts in 1h)                   cls starts too soon]
    //     -> promotion fires for waiter's waitlisted cls booking,
    //        pool (2) < creditCost (6), so the debit is skipped.
    const cls = await createClass(t.db, { capacity: 1, creditCost: 6, startsAt: hoursFromNow(1) });
    const company = await createCompany(t.db, { creditPoolBalance: 20 });

    const holder = await createMember(t.db);
    await linkMemberToCompany(t.db, holder.id, company.id);
    const holderBooking = await callerAs(t.db, holder).corporateBookings.book({ classId: cls.id });
    expect((await getCompany(t.db, company.id))?.creditPoolBalance).toBe(14);

    const waiter = await createMember(t.db);
    await linkMemberToCompany(t.db, waiter.id, company.id);
    const waiterBooking = await callerAs(t.db, waiter).corporateBookings.book({ classId: cls.id });
    expect(waiterBooking.status).toBe("waitlisted");
    expect((await getCompany(t.db, company.id))?.creditPoolBalance).toBe(14); // unchanged — waitlisting never charges

    const otherClass = await createClass(t.db, { capacity: 5, creditCost: 12, startsAt: hoursFromNow(48) });
    await callerAs(t.db, waiter).corporateBookings.book({ classId: otherClass.id });
    expect((await getCompany(t.db, company.id))?.creditPoolBalance).toBe(2); // 14 - 12, non-zero but short of cls's cost of 6

    const cancelResult = await callerAs(t.db, holder).corporateBookings.cancel({ bookingId: holderBooking.id });
    expect(cancelResult.refunded).toBe(false); // cls starts in 1h, well inside the 24h window

    const promoted = await getCorporateBooking(t.db, waiterBooking.id);
    expect(promoted?.status).toBe("booked"); // promotion is not blocked by the insufficient pool...
    expect(promoted?.creditsUsed).toBe(6);
    // This is the distinguishing assertion: 2, not 0. Confirms the
    // corporate flow skips the debit entirely when the pool is short,
    // rather than flooring it to zero the way the individual flow does.
    expect((await getCompany(t.db, company.id))?.creditPoolBalance).toBe(2);
  });
});
