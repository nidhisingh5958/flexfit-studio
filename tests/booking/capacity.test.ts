import { describe, it, expect } from "vitest";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createClass,
  createActiveMembership,
  fillClassToCapacity,
} from "../helpers";

// Flow 2 (capacity / full class) + Flow 3 (waitlisting).
// Source: src/server/routers/bookings.ts `book` (isFull check, lines ~127-146),
// src/server/routers/classes.ts `list` (booked/spotsLeft/full, lines ~24-51).
describe("class capacity boundary", () => {
  const t = useTestDatabase();

  it("the class's last open seat is bookable as status=booked", async () => {
    const cls = await createClass(t.db, { capacity: 3 });
    const filler1 = await createMember(t.db);
    const filler2 = await createMember(t.db);
    await createActiveMembership(t.db, filler1.id, { creditsRemaining: 10 });
    await createActiveMembership(t.db, filler2.id, { creditsRemaining: 10 });
    await callerAs(t.db, filler1).bookings.book({ classId: cls.id });
    await callerAs(t.db, filler2).bookings.book({ classId: cls.id });

    const lastSeat = await createMember(t.db);
    await createActiveMembership(t.db, lastSeat.id, { creditsRemaining: 10 });
    const booking = await callerAs(t.db, lastSeat).bookings.book({ classId: cls.id });

    expect(booking.status).toBe("booked");
  });

  it("booking one person beyond capacity waitlists them with creditsUsed=0 and does not touch their credits", async () => {
    const cls = await createClass(t.db, { capacity: 2, creditCost: 3 });
    await fillClassToCapacity(t.db, cls);

    const overflow = await createMember(t.db);
    await createActiveMembership(t.db, overflow.id, { creditsRemaining: 10 });
    const booking = await callerAs(t.db, overflow).bookings.book({ classId: cls.id });

    expect(booking.status).toBe("waitlisted");
    expect(booking.creditsUsed).toBe(0);

    const caller = callerAs(t.db, overflow);
    const profile = await caller.members.profile();
    expect(profile.membership?.creditsRemaining).toBe(10); // unchanged
  });

  it("classes.list reports full=true and spotsLeft=0 once individually booked to capacity", async () => {
    const cls = await createClass(t.db, { capacity: 2 });
    await fillClassToCapacity(t.db, cls);

    const anyUser = await createMember(t.db);
    const caller = callerAs(t.db, anyUser);
    const list = await caller.classes.list({});
    const row = list.find((c) => c.id === cls.id);

    expect(row?.full).toBe(true);
    expect(row?.spotsLeft).toBe(0);
  });

  it("classes.list spotsLeft only counts status='booked', not 'attended' (documents the definition used for capacity)", async () => {
    const cls = await createClass(t.db, { capacity: 2 });
    await fillClassToCapacity(t.db, cls);

    // Independently check in one attendee (simulating an early kiosk check-in).
    const admin = await createMember(t.db, { role: "admin" });
    const roster = await callerAs(t.db, admin).bookings.rosterFor({ classId: cls.id });
    await callerAs(t.db, admin).bookings.markAttended({ bookingId: roster[0].bookingId });

    const list = await callerAs(t.db, admin).classes.list({});
    const row = list.find((c) => c.id === cls.id);

    // CURRENT BEHAVIOR (see audit BUG-006): the checked-in seat no longer
    // counts toward "full", even though the class is still physically full.
    expect(row?.full).toBe(false);
    expect(row?.spotsLeft).toBe(1);
  });
});
