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

// High-risk audit findings BUG-003 and BUG-004: reschedule's credit handling
// around waitlisted <-> booked transitions. Source: src/server/routers/
// reschedules.ts `reschedule` (lines ~181-192) vs. src/server/routers/
// bookings.ts `cancel` promotion block (lines ~226-250), which is the only
// other place a waitlisted booking turns into a charged, confirmed one.
describe("BUG-003: rescheduling a waitlisted booking into an open class", () => {
  const t = useTestDatabase();

  it("CURRENT BEHAVIOR: produces a confirmed (status=booked) booking with creditsUsed=0 — no credit is ever charged", async () => {
    const waitlistedClass = await createClass(t.db, {
      name: "Power Vinyasa",
      capacity: 1,
      creditCost: 3,
      startsAt: hoursFromNow(48),
    });
    await fillClassToCapacity(t.db, waitlistedClass);

    const openTarget = await createClass(t.db, {
      name: "Power Vinyasa",
      capacity: 5,
      creditCost: 3,
      startsAt: hoursFromNow(72),
    });

    const member = await createMember(t.db);
    const ms = await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const caller = callerAs(t.db, member);

    const waitlisted = await caller.bookings.book({ classId: waitlistedClass.id });
    expect(waitlisted.status).toBe("waitlisted");
    expect(waitlisted.creditsUsed).toBe(0);
    const creditsBefore = (await getMembership(t.db, ms.id))!.creditsRemaining;

    const result = await caller.reschedules.reschedule({
      fromBookingId: waitlisted.id,
      toClassId: openTarget.id,
    });

    // This is the bug: a real, physical seat is granted ("booked") but the
    // member is never charged for it.
    expect(result.newStatus).toBe("booked");
    const newRow = await getBooking(t.db, result.newBooking.id);
    expect(newRow?.status).toBe("booked");
    expect(newRow?.creditsUsed).toBe(0);

    const creditsAfter = (await getMembership(t.db, ms.id))!.creditsRemaining;
    expect(creditsAfter).toBe(creditsBefore); // unchanged — no charge occurred

    // Contrast: normal waitlist promotion (bookings.cancel) DOES charge —
    // see waitlist-promotion.test.ts. This is the same status transition
    // (waitlisted -> booked) reaching a different outcome depending on path.
  });
});

describe("BUG-004: rescheduling a paid booking into a full class, then later promoting it", () => {
  const t = useTestDatabase();

  it("CURRENT BEHAVIOR: the resulting waitlisted booking carries a nonzero creditsUsed, breaking the invariant that waitlisted bookings always have creditsUsed=0", async () => {
    const openOriginal = await createClass(t.db, {
      name: "Advanced Spin",
      capacity: 5,
      creditCost: 4,
      startsAt: hoursFromNow(48),
    });
    const fullTarget = await createClass(t.db, {
      name: "Advanced Spin",
      capacity: 1,
      creditCost: 4,
      startsAt: hoursFromNow(72),
    });
    await fillClassToCapacity(t.db, fullTarget);

    const member = await createMember(t.db);
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const caller = callerAs(t.db, member);

    const original = await caller.bookings.book({ classId: openOriginal.id });
    expect(original.status).toBe("booked");
    expect(original.creditsUsed).toBe(4);

    const result = await caller.reschedules.reschedule({
      fromBookingId: original.id,
      toClassId: fullTarget.id,
    });

    expect(result.newStatus).toBe("waitlisted");
    const waitlistedRow = await getBooking(t.db, result.newBooking.id);
    expect(waitlistedRow?.status).toBe("waitlisted");
    // Every waitlisted row created via bookings.book has creditsUsed=0.
    // This one, created via reschedule, does not:
    expect(waitlistedRow?.creditsUsed).toBe(4);
  });

  it("CURRENT BEHAVIOR: if that waitlisted booking is later promoted, the member is charged again — a double credit deduction for one class", async () => {
    const openOriginal = await createClass(t.db, {
      name: "Advanced Spin",
      capacity: 5,
      creditCost: 4,
      startsAt: hoursFromNow(48),
    });
    const fullTarget = await createClass(t.db, {
      name: "Advanced Spin",
      capacity: 1,
      creditCost: 4,
      startsAt: hoursFromNow(72),
    });
    const [holder] = await fillClassToCapacity(t.db, fullTarget);
    const holderCaller = callerAs(t.db, holder);
    const holderBooking = (await holderCaller.bookings.mine({})).find((b) => b.classId === fullTarget.id)!;

    const member = await createMember(t.db);
    const ms = await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const caller = callerAs(t.db, member);

    const original = await caller.bookings.book({ classId: openOriginal.id }); // charges 4 credits
    const creditsAfterOriginalBooking = (await getMembership(t.db, ms.id))!.creditsRemaining;
    expect(creditsAfterOriginalBooking).toBe(6); // 10 - 4

    const rescheduled = await caller.reschedules.reschedule({
      fromBookingId: original.id,
      toClassId: fullTarget.id,
    }); // -> waitlisted, creditsUsed carried at 4, membership NOT touched by reschedule itself
    expect(rescheduled.newStatus).toBe("waitlisted");
    expect((await getMembership(t.db, ms.id))?.creditsRemaining).toBe(6); // still 6, unchanged so far

    // Someone ahead of them cancels their confirmed seat -> promotion fires.
    await holderCaller.bookings.cancel({ bookingId: holderBooking.id });

    const promoted = await getBooking(t.db, rescheduled.newBooking.id);
    expect(promoted?.status).toBe("booked");
    expect(promoted?.creditsUsed).toBe(4); // overwritten to cls.creditCost by the promotion logic

    // The member is charged 4 credits a second time for a class they were
    // already charged 4 credits for at the original booking.
    const finalCredits = (await getMembership(t.db, ms.id))!.creditsRemaining;
    expect(finalCredits).toBe(2); // 6 - 4, i.e. 10 - 4 - 4 for one attended class
  });
});
