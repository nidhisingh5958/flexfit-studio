import { describe, it, expect } from "vitest";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createClass,
  createActiveMembership,
  fillClassToCapacity,
  getBooking,
  getMembership,
  hoursFromNow,
} from "../helpers";

// Flow 4 (waitlist promotion). Source: src/server/routers/bookings.ts `cancel`
// (promotion block, lines ~213-252).
describe("waitlist promotion on cancellation of a booked seat", () => {
  const t = useTestDatabase();

  it("promotes the longest-waiting member, charges them the class's creditCost, and decrements their membership", async () => {
    const cls = await createClass(t.db, { capacity: 1, creditCost: 2, startsAt: hoursFromNow(48) });
    const [holder] = await fillClassToCapacity(t.db, cls);
    const holderCaller = callerAs(t.db, holder);
    const holderBooking = (await holderCaller.bookings.mine({})).find((b) => b.classId === cls.id)!;

    const waiter = await createMember(t.db);
    const waiterMs = await createActiveMembership(t.db, waiter.id, { creditsRemaining: 5 });
    const waiterBooking = await callerAs(t.db, waiter).bookings.book({ classId: cls.id });
    expect(waiterBooking.status).toBe("waitlisted");

    await holderCaller.bookings.cancel({ bookingId: holderBooking.id });

    const promoted = await getBooking(t.db, waiterBooking.id);
    expect(promoted?.status).toBe("booked");
    expect(promoted?.creditsUsed).toBe(2);

    const ms = await getMembership(t.db, waiterMs.id);
    expect(ms?.creditsRemaining).toBe(3); // 5 - 2
  });

  it("promotes the oldest waitlisted booking, not the newest", async () => {
    const cls = await createClass(t.db, { capacity: 1, startsAt: hoursFromNow(48) });
    const [holder] = await fillClassToCapacity(t.db, cls);
    const holderCaller = callerAs(t.db, holder);
    const holderBooking = (await holderCaller.bookings.mine({})).find((b) => b.classId === cls.id)!;

    const older = await createMember(t.db);
    const newer = await createMember(t.db);
    await createActiveMembership(t.db, older.id, { creditsRemaining: 5 });
    await createActiveMembership(t.db, newer.id, { creditsRemaining: 5 });

    const olderBooking = await callerAs(t.db, older).bookings.book({ classId: cls.id });
    await callerAs(t.db, newer).bookings.book({ classId: cls.id });

    await holderCaller.bookings.cancel({ bookingId: holderBooking.id });

    const promoted = await getBooking(t.db, olderBooking.id);
    expect(promoted?.status).toBe("booked");
  });

  it("DUP-005 / CURRENT BEHAVIOR: a waiter who spends most of their credits elsewhere before being promoted is still promoted, and the shortfall is FLOORED TO ZERO (not skipped)", async () => {
    // Note on setup: `book()` checks credit sufficiency *before* deciding
    // whether the class is full (bookings.ts lines 119-125), so a member can
    // only join a waitlist in the first place if they had enough credits at
    // that moment — a member can't join a waitlist already short on credits.
    // The realistic way this state is reached is: join a waitlist with
    // enough credits, then spend most (not all) of those same credits
    // booking a *different* class before the original promotion happens.
    //
    // The starting balance at promotion time is deliberately left NON-ZERO
    // (2) against a promotion cost of 6, per audit finding DUP-005 and the
    // Phase 2 review: a balance of exactly 0 makes "floor to zero"
    // (Math.max(0, 0-6) = 0) and "skip the debit entirely" (leaves it at 0)
    // produce the same observable number, so a test built that way cannot
    // tell the two implementations apart. With a starting balance of 2:
    //   - floor to zero:            Math.max(0, 2 - 6) = 0
    //   - skip if insufficient:     unchanged                = 2
    // These differ, so asserting the final balance actually distinguishes
    // which of the two behaviors bookings.cancel's promotion block uses.
    const classB = await createClass(t.db, { capacity: 1, creditCost: 6, startsAt: hoursFromNow(48) });
    const [holder] = await fillClassToCapacity(t.db, classB);
    const holderCaller = callerAs(t.db, holder);
    const holderBooking = (await holderCaller.bookings.mine({})).find((b) => b.classId === classB.id)!;

    const waiter = await createMember(t.db);
    const waiterMs = await createActiveMembership(t.db, waiter.id, { creditsRemaining: 8 }); // >= classB's creditCost, so joining the waitlist is allowed
    const waiterCaller = callerAs(t.db, waiter);
    const waiterBooking = await waiterCaller.bookings.book({ classId: classB.id });
    expect(waiterBooking.status).toBe("waitlisted");

    // Spend most (not all) of those credits on an unrelated class while
    // still waitlisted, leaving a non-zero balance of 2 (< classB's cost of 6).
    const classC = await createClass(t.db, { capacity: 5, creditCost: 6, startsAt: hoursFromNow(72) });
    await waiterCaller.bookings.book({ classId: classC.id });
    expect((await getMembership(t.db, waiterMs.id))?.creditsRemaining).toBe(2); // 8 - 6

    await holderCaller.bookings.cancel({ bookingId: holderBooking.id });

    const promoted = await getBooking(t.db, waiterBooking.id);
    // Promotion is not blocked by (and does not re-check) credit sufficiency.
    expect(promoted?.status).toBe("booked");
    expect(promoted?.creditsUsed).toBe(6);

    const ms = await getMembership(t.db, waiterMs.id);
    // This is the distinguishing assertion: 0, not 2. Confirms the
    // individual flow always debits, floored at zero via Math.max(0, ...),
    // rather than skipping the debit when the balance can't cover it.
    expect(ms?.creditsRemaining).toBe(0);
  });

  it("no promotion happens if nobody is waitlisted (silent no-op)", async () => {
    const cls = await createClass(t.db, { capacity: 1, startsAt: hoursFromNow(48) });
    const [holder] = await fillClassToCapacity(t.db, cls);
    const holderCaller = callerAs(t.db, holder);
    const holderBooking = (await holderCaller.bookings.mine({})).find((b) => b.classId === cls.id)!;

    const result = await holderCaller.bookings.cancel({ bookingId: holderBooking.id });
    expect(result.ok).toBe(true);
  });
});
