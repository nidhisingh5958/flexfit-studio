import { describe, it, expect } from "vitest";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createClass,
  createActiveMembership,
  getMembership,
  hoursFromNow,
} from "../helpers";
import { openSecondConnection } from "../helpers/db";

// DATA-002: credit balances are updated via read-then-write, not an atomic
// SQL increment/decrement. Source: every credit mutation in
// src/server/routers/bookings.ts (e.g. lines 204-209, the cancel refund)
// computes `ms.creditsRemaining + delta` in JS from a prior SELECT, then
// issues a separate UPDATE.
//
// Two independent connections concurrently cancel two DIFFERENT bookings
// that both refund credits onto the SAME membership row. Reproduced
// deterministically across repeated local trials.
describe("DATA-002: two concurrent refunds onto the same membership", () => {
  const t = useTestDatabase();

  it("CURRENT BEHAVIOR: one refund is lost — the final balance reflects only one of the two refunds", async () => {
    const member = await createMember(t.db);
    const ms = await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const classA = await createClass(t.db, { capacity: 5, creditCost: 3, startsAt: hoursFromNow(48) });
    const classB = await createClass(t.db, { capacity: 5, creditCost: 3, startsAt: hoursFromNow(48) });

    const setupCaller = callerAs(t.db, member);
    const bookingA = await setupCaller.bookings.book({ classId: classA.id });
    const bookingB = await setupCaller.bookings.book({ classId: classB.id });
    expect((await getMembership(t.db, ms.id))?.creditsRemaining).toBe(4); // 10 - 3 - 3

    const conn2 = openSecondConnection(t.raw);
    try {
      const callerA = callerAs(t.db, member);
      const callerB = callerAs(conn2.db, member);

      const [resultA, resultB] = await Promise.allSettled([
        callerA.bookings.cancel({ bookingId: bookingA.id }),
        callerB.bookings.cancel({ bookingId: bookingB.id }),
      ]);

      expect(resultA.status).toBe("fulfilled");
      expect(resultB.status).toBe("fulfilled");
      if (resultA.status === "fulfilled") expect(resultA.value.refunded).toBe(true);
      if (resultB.status === "fulfilled") expect(resultB.value.refunded).toBe(true);

      // Both cancellations reported a refund, but only one actually landed:
      // both requests read creditsRemaining=4 before either wrote back, so
      // the second write (4 + 3 = 7) clobbers the first instead of the
      // correct 4 + 3 + 3 = 10.
      const final = await getMembership(t.db, ms.id);
      expect(final?.creditsRemaining).toBe(7); // NOT 10 — one refund of 3 was lost
    } finally {
      conn2.client.close();
    }
  });
});
