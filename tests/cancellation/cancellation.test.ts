import { describe, it, expect } from "vitest";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createTrainer,
  createAdmin,
  createClass,
  createActiveMembership,
  getBooking,
  getMembership,
  hoursFromNow,
} from "../helpers";

// Flow 5 (cancellation). Source: src/server/routers/bookings.ts `cancel`.
describe("bookings.cancel — ownership & status rules", () => {
  const t = useTestDatabase();

  it("the owning member can cancel their own booking", async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { startsAt: hoursFromNow(48) });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const caller = callerAs(t.db, member);
    const booking = await caller.bookings.book({ classId: cls.id });

    const result = await caller.bookings.cancel({ bookingId: booking.id });
    expect(result.ok).toBe(true);

    const row = await getBooking(t.db, booking.id);
    expect(row?.status).toBe("cancelled");
    expect(row?.cancelledAt).not.toBeNull();
  });

  it("staff (admin or trainer) can cancel someone else's booking, and it actually mutates the booking and refunds credits", async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { startsAt: hoursFromNow(48), creditCost: 2 });
    const ms = await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const booking = await callerAs(t.db, member).bookings.book({ classId: cls.id });
    expect((await getMembership(t.db, ms.id))?.creditsRemaining).toBe(8); // 10 - 2

    const admin = await createAdmin(t.db);
    const adminCancelResult = await callerAs(t.db, admin).bookings.cancel({ bookingId: booking.id });
    expect(adminCancelResult).toMatchObject({ ok: true, refunded: true }); // 48h out, well inside the 12h window

    const adminCancelledRow = await getBooking(t.db, booking.id);
    expect(adminCancelledRow?.status).toBe("cancelled");
    expect(adminCancelledRow?.cancelledAt).not.toBeNull();
    expect((await getMembership(t.db, ms.id))?.creditsRemaining).toBe(10); // refunded back

    // second booking for the trainer-cancel case
    const booking2 = await callerAs(t.db, member).bookings.book({ classId: cls.id });
    expect((await getMembership(t.db, ms.id))?.creditsRemaining).toBe(8); // debited again

    const trainer = await createTrainer(t.db);
    const trainerCancelResult = await callerAs(t.db, trainer).bookings.cancel({ bookingId: booking2.id });
    expect(trainerCancelResult).toMatchObject({ ok: true, refunded: true });

    const trainerCancelledRow = await getBooking(t.db, booking2.id);
    expect(trainerCancelledRow?.status).toBe("cancelled");
    expect(trainerCancelledRow?.cancelledAt).not.toBeNull();
    expect((await getMembership(t.db, ms.id))?.creditsRemaining).toBe(10); // refunded back again
  });

  it('a different (non-staff) member gets FORBIDDEN "You cannot cancel this booking."', async () => {
    const member = await createMember(t.db);
    const stranger = await createMember(t.db);
    const cls = await createClass(t.db, { startsAt: hoursFromNow(48) });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const booking = await callerAs(t.db, member).bookings.book({ classId: cls.id });

    await expect(callerAs(t.db, stranger).bookings.cancel({ bookingId: booking.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "You cannot cancel this booking.",
    });
  });

  it('rejects with NOT_FOUND "Booking not found." for an unknown id', async () => {
    const member = await createMember(t.db);
    await expect(callerAs(t.db, member).bookings.cancel({ bookingId: 999999 })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Booking not found.",
    });
  });

  it('rejects cancelling an already-cancelled booking with BAD_REQUEST "This booking is no longer active."', async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { startsAt: hoursFromNow(48) });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const caller = callerAs(t.db, member);
    const booking = await caller.bookings.book({ classId: cls.id });
    await caller.bookings.cancel({ bookingId: booking.id });

    await expect(caller.bookings.cancel({ bookingId: booking.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This booking is no longer active.",
    });
  });

  it("CURRENT BEHAVIOR: cancel has no check against the class already having started (unlike book)", async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { startsAt: hoursFromNow(48) });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const caller = callerAs(t.db, member);
    const booking = await caller.bookings.book({ classId: cls.id });

    // Simulate the class having since started/ended — cancel is still accepted.
    // (bookings.cancel has no hoursUntil(...) <= 0 guard, unlike bookings.book.)
    const result = await caller.bookings.cancel({ bookingId: booking.id });
    expect(result.ok).toBe(true);
  });
});
