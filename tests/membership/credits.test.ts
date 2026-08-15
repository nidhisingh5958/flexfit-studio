import { describe, it, expect } from "vitest";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createClass,
  createActiveMembership,
  createUnlimitedMembership,
  getMembership,
  hoursFromNow,
} from "../helpers";

// Flow 6/7 (credit deduction & refund), unlimited-membership edge cases.
// Source: src/server/routers/bookings.ts UNLIMITED_CREDITS=999 and every
// `< UNLIMITED_CREDITS` guard around a credit mutation.
describe("membership credits — unlimited vs. metered", () => {
  const t = useTestDatabase();

  it("a metered membership is debited exactly creditCost on booking", async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { creditCost: 3, capacity: 5 });
    const ms = await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });

    await callerAs(t.db, member).bookings.book({ classId: cls.id });
    expect((await getMembership(t.db, ms.id))?.creditsRemaining).toBe(7);
  });

  it("a membership with creditsRemaining >= 999 is treated as unlimited and is never debited or credited", async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { creditCost: 5, capacity: 5, startsAt: hoursFromNow(48) });
    const ms = await createUnlimitedMembership(t.db, member.id);
    const caller = callerAs(t.db, member);

    const booking = await caller.bookings.book({ classId: cls.id });
    expect((await getMembership(t.db, ms.id))?.creditsRemaining).toBe(999);

    await caller.bookings.cancel({ bookingId: booking.id });
    expect((await getMembership(t.db, ms.id))?.creditsRemaining).toBe(999); // still untouched
  });

  it("a membership with exactly 999 credits (the sentinel) never blocks booking a high-cost class", async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { creditCost: 500, capacity: 5 }); // would fail for any metered plan
    await createUnlimitedMembership(t.db, member.id);

    await expect(callerAs(t.db, member).bookings.book({ classId: cls.id })).resolves.toMatchObject({
      status: "booked",
    });
  });

  it("a metered membership with exactly enough credits for one class can book it (boundary: creditsRemaining === creditCost)", async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { creditCost: 4, capacity: 5 });
    const ms = await createActiveMembership(t.db, member.id, { creditsRemaining: 4 });

    await callerAs(t.db, member).bookings.book({ classId: cls.id });
    expect((await getMembership(t.db, ms.id))?.creditsRemaining).toBe(0);
  });

  it("a metered membership with one credit short is rejected (boundary: creditsRemaining === creditCost - 1)", async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { creditCost: 4, capacity: 5 });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 3 });

    await expect(callerAs(t.db, member).bookings.book({ classId: cls.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Not enough class credits remaining.",
    });
  });

  it("a membership with 0 credits cannot book a free (creditCost: 0) class either way — the check is strictly `<`, so 0 < 0 is false and it's allowed", async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { creditCost: 0, capacity: 5 });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 0 });

    // CURRENT BEHAVIOR: 0 credits remaining, 0 credit cost -> `0 < 0` is
    // false, so the sufficiency check passes and the booking succeeds.
    await expect(callerAs(t.db, member).bookings.book({ classId: cls.id })).resolves.toMatchObject({
      status: "booked",
      creditsUsed: 0,
    });
  });
});
