import { describe, it, expect } from "vitest";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createClass,
  createActiveMembership,
  createExpiredMembership,
  daysFromNowDateOnly,
} from "../helpers";

// Flow 9 (membership selection) + BUG-010 (multiple active memberships).
// Source: activeMembershipFor() in src/server/routers/bookings.ts (lines
// 20-37) and src/server/routers/reschedules.ts (identical copy, lines 22-39):
// `status='active' AND endDate >= today`, `orderBy(desc(endDate))`.
describe("which membership gets used for booking", () => {
  const t = useTestDatabase();

  it("an expired membership is ignored even if it has credits remaining", async () => {
    const member = await createMember(t.db);
    await createExpiredMembership(t.db, member.id, { creditsRemaining: 50 });
    const cls = await createClass(t.db);

    await expect(callerAs(t.db, member).bookings.book({ classId: cls.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "An active membership is required to book classes.",
    });
  });

  it("a cancelled-status membership is ignored even if endDate is still in the future", async () => {
    const member = await createMember(t.db);
    await createActiveMembership(t.db, member.id, {
      status: "cancelled",
      endDate: daysFromNowDateOnly(30),
      creditsRemaining: 50,
    });
    const cls = await createClass(t.db);

    await expect(callerAs(t.db, member).bookings.book({ classId: cls.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "An active membership is required to book classes.",
    });
  });

  it("BUG-010 / CURRENT BEHAVIOR: a member can hold two simultaneous active memberships — booking always draws from the one with the furthest endDate", async () => {
    const member = await createMember(t.db);
    const soonerButMoreCredits = await createActiveMembership(t.db, member.id, {
      endDate: daysFromNowDateOnly(10),
      creditsRemaining: 100,
    });
    const laterButFewerCredits = await createActiveMembership(t.db, member.id, {
      endDate: daysFromNowDateOnly(60),
      creditsRemaining: 1,
    });

    const cls = await createClass(t.db, { creditCost: 1 });
    const caller = callerAs(t.db, member);
    const booking = await caller.bookings.book({ classId: cls.id });

    // The membership with the *later* endDate is selected, regardless of
    // which one has more credits or was purchased more recently.
    expect(booking.membershipId).toBe(laterButFewerCredits.id);
    expect(booking.membershipId).not.toBe(soonerButMoreCredits.id);
  });

  it("CURRENT BEHAVIOR: activeMembershipFor() tolerates two coexisting active membership rows with identical endDates without erroring, and draws from exactly one", async () => {
    // NOTE: this test only characterizes the *selection* query
    // (activeMembershipFor) against two membership rows planted directly
    // via the test factory — it does NOT exercise `plans.subscribe`, and
    // does not by itself prove that the real subscription mechanism is
    // what allows two active memberships to coexist. For that, see
    // tests/membership/plans-subscribe.test.ts, which calls
    // `plans.subscribe` twice through the actual router (the real
    // characterization of BUG-010 requested in the Phase 2B review).
    const member = await createMember(t.db);
    const first = await createActiveMembership(t.db, member.id, { endDate: daysFromNowDateOnly(5), creditsRemaining: 10 });
    const second = await createActiveMembership(t.db, member.id, { endDate: daysFromNowDateOnly(5), creditsRemaining: 10 });

    // Two memberships with the SAME endDate: orderBy(desc(endDate)) alone
    // does not fully determine which one wins in a tie — deliberately not
    // asserting which of the two is picked (that ordering is unspecified
    // and not something the app promises), only that exactly one is, and
    // that having two coexisting rows doesn't itself cause an error.
    const cls = await createClass(t.db, { creditCost: 1 });
    const caller = callerAs(t.db, member);
    const booking = await caller.bookings.book({ classId: cls.id });
    expect([first.id, second.id]).toContain(booking.membershipId);
  });
});
