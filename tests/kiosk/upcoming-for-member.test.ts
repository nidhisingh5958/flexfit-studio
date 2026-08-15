import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { classes } from "@/db/schema";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createTrainer,
  createAdmin,
  createClass,
  createActiveMembership,
  hoursFromNow,
} from "../helpers";

// HIGH GAP 3: bookings.upcomingForMember, tested directly rather than only
// indirectly through kiosk-lookup.test.ts. This is the actual query the
// kiosk uses to decide which classes a member can be checked into. Source:
// src/server/routers/bookings.ts `upcomingForMember` (lines 313-345):
// filters on userId, status='booked', classes.startsAt within
// [now, now+hoursAhead], and classes.cancelled=false.
describe("bookings.upcomingForMember", () => {
  const t = useTestDatabase();

  async function setup() {
    const member = await createMember(t.db);
    await createActiveMembership(t.db, member.id, { creditsRemaining: 20 });
    const staff = await createAdmin(t.db);
    return { member, staff, memberCaller: callerAs(t.db, member) };
  }

  it("includes a normal booked booking starting within the default 2-hour window", async () => {
    const { member, staff, memberCaller } = await setup();
    const cls = await createClass(t.db, { name: "Sunrise Yoga", capacity: 5, startsAt: hoursFromNow(1) });
    await memberCaller.bookings.book({ classId: cls.id });

    const upcoming = await callerAs(t.db, staff).bookings.upcomingForMember({ userId: member.id });
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0].className).toBe("Sunrise Yoga");
    expect(upcoming[0].bookingStatus).toBe("booked");
  });

  it("excludes a cancelled booking", async () => {
    const { member, staff, memberCaller } = await setup();
    const cls = await createClass(t.db, { capacity: 5, startsAt: hoursFromNow(1) });
    const booking = await memberCaller.bookings.book({ classId: cls.id });
    await memberCaller.bookings.cancel({ bookingId: booking.id });

    const upcoming = await callerAs(t.db, staff).bookings.upcomingForMember({ userId: member.id });
    expect(upcoming).toHaveLength(0);
  });

  it("excludes an already-attended booking (status='attended', not 'booked')", async () => {
    const { member, staff, memberCaller } = await setup();
    const cls = await createClass(t.db, { capacity: 5, startsAt: hoursFromNow(1) });
    const booking = await memberCaller.bookings.book({ classId: cls.id });
    await callerAs(t.db, staff).bookings.markAttended({ bookingId: booking.id });

    const upcoming = await callerAs(t.db, staff).bookings.upcomingForMember({ userId: member.id });
    expect(upcoming).toHaveLength(0);
  });

  it("excludes a waitlisted booking (status='waitlisted', not 'booked')", async () => {
    const { staff } = await setup();
    const cls = await createClass(t.db, { capacity: 1, startsAt: hoursFromNow(1) });
    const holder = await createMember(t.db);
    await createActiveMembership(t.db, holder.id, { creditsRemaining: 10 });
    await callerAs(t.db, holder).bookings.book({ classId: cls.id });

    const overflow = await createMember(t.db);
    await createActiveMembership(t.db, overflow.id, { creditsRemaining: 10 });
    const waitlisted = await callerAs(t.db, overflow).bookings.book({ classId: cls.id });
    expect(waitlisted.status).toBe("waitlisted");

    const upcoming = await callerAs(t.db, staff).bookings.upcomingForMember({ userId: overflow.id });
    expect(upcoming).toHaveLength(0);
  });

  it("excludes a booking for a class that has already started", async () => {
    const { member, staff } = await setup();
    // Book while the class is still in the future, then move it into the
    // past via the real admin update mutation (booking a past class
    // directly is blocked by bookings.book itself).
    const cls = await createClass(t.db, { capacity: 5, startsAt: hoursFromNow(1) });
    const memberCaller = callerAs(t.db, member);
    await memberCaller.bookings.book({ classId: cls.id });
    await t.db.update(classes).set({ startsAt: hoursFromNow(-1) }).where(eq(classes.id, cls.id));

    const upcoming = await callerAs(t.db, staff).bookings.upcomingForMember({ userId: member.id });
    expect(upcoming).toHaveLength(0);
  });

  it("excludes a booking outside the requested hoursAhead window", async () => {
    const { member, staff, memberCaller } = await setup();
    const farClass = await createClass(t.db, { capacity: 5, startsAt: hoursFromNow(5) }); // outside the default 2h window
    await memberCaller.bookings.book({ classId: farClass.id });

    const upcoming = await callerAs(t.db, staff).bookings.upcomingForMember({ userId: member.id });
    expect(upcoming).toHaveLength(0);
  });

  it("respects a custom hoursAhead value, including a booking the default window would have excluded", async () => {
    const { member, staff, memberCaller } = await setup();
    const farClass = await createClass(t.db, { name: "Advanced Spin", capacity: 5, startsAt: hoursFromNow(10) });
    await memberCaller.bookings.book({ classId: farClass.id });

    const withDefault = await callerAs(t.db, staff).bookings.upcomingForMember({ userId: member.id });
    expect(withDefault).toHaveLength(0);

    const withWiderWindow = await callerAs(t.db, staff).bookings.upcomingForMember({
      userId: member.id,
      hoursAhead: 24,
    });
    expect(withWiderWindow).toHaveLength(1);
    expect(withWiderWindow[0].className).toBe("Advanced Spin");
  });

  it("CURRENT BEHAVIOR: excludes a booking whose class was independently marked cancelled, even if the booking row itself still reads status='booked'", async () => {
    // Isolates the `classes.cancelled=false` filter clause specifically —
    // in the app's own admin flow (classes.cancel), a cancelled class's
    // "booked" rows are flipped to "cancelled" too (see BUG-005 coverage),
    // so this exact combination (class cancelled, booking still "booked")
    // wouldn't arise through classes.cancel itself; it isolates what this
    // one filter clause does on its own.
    const { member, staff, memberCaller } = await setup();
    const cls = await createClass(t.db, { capacity: 5, startsAt: hoursFromNow(1) });
    await memberCaller.bookings.book({ classId: cls.id });
    await t.db.update(classes).set({ cancelled: true }).where(eq(classes.id, cls.id));

    const upcoming = await callerAs(t.db, staff).bookings.upcomingForMember({ userId: member.id });
    expect(upcoming).toHaveLength(0);
  });

  it("returns null trainerName (not an error) when the class has no assigned trainer", async () => {
    const { member, staff, memberCaller } = await setup();
    const cls = await createClass(t.db, { capacity: 5, startsAt: hoursFromNow(1) }); // no trainerId
    await memberCaller.bookings.book({ classId: cls.id });

    const upcoming = await callerAs(t.db, staff).bookings.upcomingForMember({ userId: member.id });
    expect(upcoming[0].trainerId).toBeNull();
    expect(upcoming[0].trainerName).toBeNull();
  });

  it("requires staff (staffProcedure) — a member cannot call this for themselves", async () => {
    const { member } = await setup();
    await expect(
      callerAs(t.db, member).bookings.upcomingForMember({ userId: member.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "Staff only." });
  });

  it("a trainer (not just admin) can call this", async () => {
    const { member, memberCaller } = await setup();
    const cls = await createClass(t.db, { capacity: 5, startsAt: hoursFromNow(1) });
    await memberCaller.bookings.book({ classId: cls.id });
    const trainer = await createTrainer(t.db);

    await expect(
      callerAs(t.db, trainer).bookings.upcomingForMember({ userId: member.id }),
    ).resolves.toHaveLength(1);
  });
});
