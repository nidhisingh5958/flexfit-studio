import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { checkins } from "@/db/schema";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createAdmin,
  createTrainer,
  createClass,
  createActiveMembership,
  getBooking,
  hoursFromNow,
} from "../helpers";

// Flow 14 (check-in / attendance). Source: src/server/routers/bookings.ts `markAttended`.
describe("bookings.markAttended — golden path", () => {
  const t = useTestDatabase();

  it("flips a booked booking to attended and records a checkins row with the given source", async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { capacity: 5 });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const booking = await callerAs(t.db, member).bookings.book({ classId: cls.id });

    const admin = await createAdmin(t.db);
    const result = await callerAs(t.db, admin).bookings.markAttended({ bookingId: booking.id, source: "kiosk" });
    expect(result.ok).toBe(true);

    const row = await getBooking(t.db, booking.id);
    expect(row?.status).toBe("attended");

    const checkinRows = await t.db.select().from(checkins).where(eq(checkins.bookingId, booking.id));
    expect(checkinRows).toHaveLength(1);
    expect(checkinRows[0].source).toBe("kiosk");
    expect(checkinRows[0].userId).toBe(member.id);
  });

  it('defaults source to "front_desk" when not specified', async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { capacity: 5 });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const booking = await callerAs(t.db, member).bookings.book({ classId: cls.id });

    const trainer = await createTrainer(t.db);
    await callerAs(t.db, trainer).bookings.markAttended({ bookingId: booking.id });

    const checkinRows = await t.db.select().from(checkins).where(eq(checkins.bookingId, booking.id));
    expect(checkinRows[0].source).toBe("front_desk");
  });

  it('rejects with NOT_FOUND "Booking not found." for an unknown id', async () => {
    const admin = await createAdmin(t.db);
    await expect(callerAs(t.db, admin).bookings.markAttended({ bookingId: 999999 })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Booking not found.",
    });
  });

  it('rejects a waitlisted booking with BAD_REQUEST "Only confirmed bookings can be checked in."', async () => {
    const cls = await createClass(t.db, { capacity: 1 });
    const holder = await createMember(t.db);
    await createActiveMembership(t.db, holder.id, { creditsRemaining: 10 });
    await callerAs(t.db, holder).bookings.book({ classId: cls.id });

    const overflow = await createMember(t.db);
    await createActiveMembership(t.db, overflow.id, { creditsRemaining: 10 });
    const waitlisted = await callerAs(t.db, overflow).bookings.book({ classId: cls.id });

    const admin = await createAdmin(t.db);
    await expect(callerAs(t.db, admin).bookings.markAttended({ bookingId: waitlisted.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Only confirmed bookings can be checked in.",
    });
  });

  it("rejects checking the same booking in twice (already attended)", async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { capacity: 5 });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const booking = await callerAs(t.db, member).bookings.book({ classId: cls.id });
    const admin = await createAdmin(t.db);
    await callerAs(t.db, admin).bookings.markAttended({ bookingId: booking.id });

    await expect(callerAs(t.db, admin).bookings.markAttended({ bookingId: booking.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Only confirmed bookings can be checked in.",
    });
  });

  it("requires staff — a member cannot check themself in", async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { capacity: 5 });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const booking = await callerAs(t.db, member).bookings.book({ classId: cls.id });

    await expect(callerAs(t.db, member).bookings.markAttended({ bookingId: booking.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Staff only.",
    });
  });

  it("BUG-006 / CURRENT BEHAVIOR: checking someone in before class start removes them from the booked-count capacity check, opening a phantom seat", async () => {
    const cls = await createClass(t.db, { capacity: 1, creditCost: 1, startsAt: hoursFromNow(1) }); // within kiosk's 2h early-checkin window
    const attendee = await createMember(t.db);
    await createActiveMembership(t.db, attendee.id, { creditsRemaining: 10 });
    const booking = await callerAs(t.db, attendee).bookings.book({ classId: cls.id });
    expect(booking.status).toBe("booked");

    const admin = await createAdmin(t.db);
    await callerAs(t.db, admin).bookings.markAttended({ bookingId: booking.id, source: "kiosk" });

    // The room is still physically full (capacity 1, attendee is present),
    // but the class no longer counts as full for a new booking attempt.
    const newBooker = await createMember(t.db);
    await createActiveMembership(t.db, newBooker.id, { creditsRemaining: 10 });
    const secondBooking = await callerAs(t.db, newBooker).bookings.book({ classId: cls.id });
    expect(secondBooking.status).toBe("booked"); // not waitlisted, despite capacity=1
  });
});
