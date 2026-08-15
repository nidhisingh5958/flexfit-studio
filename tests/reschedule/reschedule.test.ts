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

// Flow 8 (rescheduling). Source: src/server/routers/reschedules.ts `reschedule`
// and `validateReschedule`.
describe("reschedules.reschedule — golden path", () => {
  const t = useTestDatabase();

  it("moves a booked booking to an open same-named class, cancels the original, and carries creditsUsed forward unchanged", async () => {
    const member = await createMember(t.db);
    const from = await createClass(t.db, { name: "Spin 45", capacity: 5, creditCost: 2, startsAt: hoursFromNow(48) });
    const to = await createClass(t.db, { name: "Spin 45", capacity: 5, creditCost: 2, startsAt: hoursFromNow(72) });
    const ms = await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });

    const caller = callerAs(t.db, member);
    const original = await caller.bookings.book({ classId: from.id });
    expect(original.creditsUsed).toBe(2);
    const creditsAfterBooking = (await getMembership(t.db, ms.id))!.creditsRemaining;

    const result = await caller.reschedules.reschedule({ fromBookingId: original.id, toClassId: to.id });

    expect(result.ok).toBe(true);
    expect(result.newStatus).toBe("booked");
    expect(result.newBooking.creditsUsed).toBe(2); // carried over, not re-charged
    expect(result.newBooking.classId).toBe(to.id);

    const originalRow = await getBooking(t.db, original.id);
    expect(originalRow?.status).toBe("cancelled");

    // Credits are untouched by reschedule itself — carried, not re-spent.
    const creditsAfterReschedule = (await getMembership(t.db, ms.id))!.creditsRemaining;
    expect(creditsAfterReschedule).toBe(creditsAfterBooking);
  });

  it("records a reschedules row and it's visible via reschedules.history", async () => {
    const member = await createMember(t.db);
    const from = await createClass(t.db, { name: "HIIT Circuit", capacity: 5, startsAt: hoursFromNow(48) });
    const to = await createClass(t.db, { name: "HIIT Circuit", capacity: 5, startsAt: hoursFromNow(72) });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });

    const caller = callerAs(t.db, member);
    const original = await caller.bookings.book({ classId: from.id });
    await caller.reschedules.reschedule({ fromBookingId: original.id, toClassId: to.id });

    const history = await caller.reschedules.history();
    expect(history).toHaveLength(1);
    expect(history[0].fromClassName).toBe("HIIT Circuit");
    expect(history[0].toClassName).toBe("HIIT Circuit");
  });

  it("moving into a full same-named class waitlists the new booking", async () => {
    const member = await createMember(t.db);
    const from = await createClass(t.db, { name: "Boxing", capacity: 5, startsAt: hoursFromNow(48) });
    const to = await createClass(t.db, { name: "Boxing", capacity: 1, startsAt: hoursFromNow(72) });
    await fillClassToCapacity(t.db, to);
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });

    const caller = callerAs(t.db, member);
    const original = await caller.bookings.book({ classId: from.id });
    const result = await caller.reschedules.reschedule({ fromBookingId: original.id, toClassId: to.id });

    expect(result.newStatus).toBe("waitlisted");
  });
});

describe("reschedules.reschedule — validation errors (exact messages)", () => {
  const t = useTestDatabase();

  async function bookedSetup(overrides: { fromCapacity?: number; toCapacity?: number } = {}) {
    const member = await createMember(t.db);
    const from = await createClass(t.db, {
      name: "Sunrise Yoga",
      capacity: overrides.fromCapacity ?? 5,
      startsAt: hoursFromNow(48),
    });
    const to = await createClass(t.db, {
      name: "Sunrise Yoga",
      capacity: overrides.toCapacity ?? 5,
      startsAt: hoursFromNow(72),
    });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const caller = callerAs(t.db, member);
    const original = await caller.bookings.book({ classId: from.id });
    return { member, from, to, caller, original };
  }

  it('NOT_FOUND "Booking not found." for an unknown fromBookingId', async () => {
    const member = await createMember(t.db);
    const to = await createClass(t.db);
    await expect(
      callerAs(t.db, member).reschedules.reschedule({ fromBookingId: 999999, toClassId: to.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Booking not found." });
  });

  it('FORBIDDEN "You cannot reschedule this booking." for a non-owner', async () => {
    const { to, original } = await bookedSetup();
    const stranger = await createMember(t.db);
    await expect(
      callerAs(t.db, stranger).reschedules.reschedule({ fromBookingId: original.id, toClassId: to.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "You cannot reschedule this booking." });
  });

  it('BAD_REQUEST "This booking is no longer active." once already cancelled', async () => {
    const { to, original, caller } = await bookedSetup();
    await caller.bookings.cancel({ bookingId: original.id });
    await expect(
      caller.reschedules.reschedule({ fromBookingId: original.id, toClassId: to.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "This booking is no longer active." });
  });

  it('BAD_REQUEST with the FREE_RESCHEDULE_HOURS message once inside the 4-hour window', async () => {
    const member = await createMember(t.db);
    const from = await createClass(t.db, { name: "X", startsAt: hoursFromNow(2) });
    const to = await createClass(t.db, { name: "X", startsAt: hoursFromNow(48) });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const caller = callerAs(t.db, member);
    const original = await caller.bookings.book({ classId: from.id });

    await expect(caller.reschedules.reschedule({ fromBookingId: original.id, toClassId: to.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "You can only reschedule up to 4 hours before the class starts.",
    });
  });

  it('NOT_FOUND "Target class not found." for an unknown toClassId', async () => {
    const { original, caller } = await bookedSetup();
    await expect(
      caller.reschedules.reschedule({ fromBookingId: original.id, toClassId: 999999 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Target class not found." });
  });

  it('BAD_REQUEST "You can only reschedule to a class with the same name." for a differently-named target', async () => {
    const { original, caller } = await bookedSetup();
    const differentName = await createClass(t.db, { name: "Totally Different", startsAt: hoursFromNow(72) });
    await expect(
      caller.reschedules.reschedule({ fromBookingId: original.id, toClassId: differentName.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "You can only reschedule to a class with the same name." });
  });

  it('BAD_REQUEST "You are already booked for this class." when the target IS the original class', async () => {
    const { from, original, caller } = await bookedSetup();
    await expect(
      caller.reschedules.reschedule({ fromBookingId: original.id, toClassId: from.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "You are already booked for this class." });
  });

  it('BAD_REQUEST "This class has already started." for a target already underway', async () => {
    const member = await createMember(t.db);
    const from = await createClass(t.db, { name: "X", startsAt: hoursFromNow(48) });
    const to = await createClass(t.db, { name: "X", startsAt: hoursFromNow(-1) });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const caller = callerAs(t.db, member);
    const original = await caller.bookings.book({ classId: from.id });

    await expect(caller.reschedules.reschedule({ fromBookingId: original.id, toClassId: to.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This class has already started.",
    });
  });

  it('BAD_REQUEST "This class has been cancelled." for a cancelled target', async () => {
    const member = await createMember(t.db);
    const from = await createClass(t.db, { name: "X", startsAt: hoursFromNow(48) });
    const to = await createClass(t.db, { name: "X", startsAt: hoursFromNow(72), cancelled: true });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const caller = callerAs(t.db, member);
    const original = await caller.bookings.book({ classId: from.id });

    await expect(caller.reschedules.reschedule({ fromBookingId: original.id, toClassId: to.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This class has been cancelled.",
    });
  });

  it('CONFLICT "You already have an active booking for this class." when already on the target', async () => {
    const { from, to, caller, member } = await bookedSetup();
    void from;
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 }); // second membership row, still fine
    await caller.bookings.book({ classId: to.id }); // separately book the target already

    const secondFromClass = await createClass(t.db, { name: "Sunrise Yoga", startsAt: hoursFromNow(50) });
    const secondBooking = await caller.bookings.book({ classId: secondFromClass.id });

    await expect(
      caller.reschedules.reschedule({ fromBookingId: secondBooking.id, toClassId: to.id }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "You already have an active booking for this class." });
  });

  it("requires sign-in", async () => {
    const to = await createClass(t.db);
    await expect(
      callerAs(t.db, null).reschedules.reschedule({ fromBookingId: 1, toClassId: to.id }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "Sign in required." });
  });
});

// ARCH-003: validateReschedule duplicates the same eight checks as a query.
// These tests confirm the query returns { valid: false, reason } equivalents
// instead of throwing, using the exact same wording.
describe("reschedules.validateReschedule — mirrors reschedule's checks without mutating", () => {
  const t = useTestDatabase();

  it("returns valid:true and targetIsFull for a legitimate reschedule candidate", async () => {
    const member = await createMember(t.db);
    const from = await createClass(t.db, { name: "Mobility", startsAt: hoursFromNow(48) });
    const to = await createClass(t.db, { name: "Mobility", startsAt: hoursFromNow(72) });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const caller = callerAs(t.db, member);
    const original = await caller.bookings.book({ classId: from.id });

    const result = await caller.reschedules.validateReschedule({ fromBookingId: original.id, toClassId: to.id });
    expect(result).toEqual({ valid: true, targetIsFull: false });

    // and it did NOT mutate anything
    const row = await getBooking(t.db, original.id);
    expect(row?.status).toBe("booked");
  });

  it('returns the identical reason string as the mutation for the same-name violation', async () => {
    const member = await createMember(t.db);
    const from = await createClass(t.db, { name: "Mobility", startsAt: hoursFromNow(48) });
    const to = await createClass(t.db, { name: "Different", startsAt: hoursFromNow(72) });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const caller = callerAs(t.db, member);
    const original = await caller.bookings.book({ classId: from.id });

    const result = await caller.reschedules.validateReschedule({ fromBookingId: original.id, toClassId: to.id });
    expect(result).toEqual({
      valid: false,
      reason: "You can only reschedule to a class with the same name.",
    });
  });
});
