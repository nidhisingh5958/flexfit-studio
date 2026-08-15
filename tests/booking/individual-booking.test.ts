import { describe, it, expect } from "vitest";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createClass,
  createActiveMembership,
  createUnlimitedMembership,
  createExpiredMembership,
  getMembership,
  hoursFromNow,
} from "../helpers";

// Flow 1 (individual booking) + Flow 6 (credit deduction).
// Source: src/server/routers/bookings.ts `book`.
describe("bookings.book — individual booking golden path", () => {
  const t = useTestDatabase();

  it("books an open class, debits one credit per creditCost, and returns the booking", async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { capacity: 5, creditCost: 2 });
    const ms = await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });

    const caller = callerAs(t.db, member);
    const booking = await caller.bookings.book({ classId: cls.id });

    expect(booking.status).toBe("booked");
    expect(booking.creditsUsed).toBe(2);
    expect(booking.membershipId).toBe(ms.id);

    const updated = await getMembership(t.db, ms.id);
    expect(updated?.creditsRemaining).toBe(8);
  });

  it("does not decrement credits for an unlimited (999) membership", async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { capacity: 5, creditCost: 1 });
    const ms = await createUnlimitedMembership(t.db, member.id);

    const caller = callerAs(t.db, member);
    const booking = await caller.bookings.book({ classId: cls.id });

    expect(booking.status).toBe("booked");
    expect(booking.creditsUsed).toBe(1); // creditsUsed is still recorded on the booking row...
    const updated = await getMembership(t.db, ms.id);
    expect(updated?.creditsRemaining).toBe(999); // ...but the membership balance is untouched.
  });

  it('rejects with FORBIDDEN "Not enough class credits remaining." when credits are insufficient', async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { capacity: 5, creditCost: 3 });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 2 });

    const caller = callerAs(t.db, member);
    await expect(caller.bookings.book({ classId: cls.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Not enough class credits remaining.",
    });
  });

  it('rejects with FORBIDDEN "An active membership is required to book classes." when there is no membership', async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db);

    const caller = callerAs(t.db, member);
    await expect(caller.bookings.book({ classId: cls.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "An active membership is required to book classes.",
    });
  });

  it("treats an expired membership the same as no membership", async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db);
    await createExpiredMembership(t.db, member.id, { creditsRemaining: 10 });

    const caller = callerAs(t.db, member);
    await expect(caller.bookings.book({ classId: cls.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "An active membership is required to book classes.",
    });
  });

  it('rejects with NOT_FOUND "Class not found." for a nonexistent class id', async () => {
    const member = await createMember(t.db);
    await createActiveMembership(t.db, member.id);

    const caller = callerAs(t.db, member);
    await expect(caller.bookings.book({ classId: 999999 })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Class not found.",
    });
  });

  it('rejects with BAD_REQUEST "This class has been cancelled." for a cancelled class', async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { cancelled: true });
    await createActiveMembership(t.db, member.id);

    const caller = callerAs(t.db, member);
    await expect(caller.bookings.book({ classId: cls.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This class has been cancelled.",
    });
  });

  it('rejects with BAD_REQUEST "This class has already started." once startsAt is in the past', async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { startsAt: hoursFromNow(-1) });
    await createActiveMembership(t.db, member.id);

    const caller = callerAs(t.db, member);
    await expect(caller.bookings.book({ classId: cls.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This class has already started.",
    });
  });

  it("requires sign-in (protectedProcedure)", async () => {
    const cls = await createClass(t.db);
    const caller = callerAs(t.db, null);
    await expect(caller.bookings.book({ classId: cls.id })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Sign in required.",
    });
  });
});

describe("bookings.book — duplicate booking (edge case)", () => {
  const t = useTestDatabase();

  it('rejects a second booking attempt for the same class with CONFLICT "You are already on the list for this class."', async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { capacity: 5 });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });

    const caller = callerAs(t.db, member);
    await caller.bookings.book({ classId: cls.id });

    await expect(caller.bookings.book({ classId: cls.id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "You are already on the list for this class.",
    });
  });

  it("allows rebooking after the first booking was cancelled (cancelled bookings don't block)", async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { capacity: 5, startsAt: hoursFromNow(48) });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });

    const caller = callerAs(t.db, member);
    const first = await caller.bookings.book({ classId: cls.id });
    await caller.bookings.cancel({ bookingId: first.id });

    const second = await caller.bookings.book({ classId: cls.id });
    expect(second.status).toBe("booked");
  });
});
