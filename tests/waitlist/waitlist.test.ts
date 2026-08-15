import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { bookings } from "@/db/schema";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createClass,
  createActiveMembership,
  fillClassToCapacity,
} from "../helpers";

// Flow 3 (waitlisting). Source: src/server/routers/bookings.ts `book`, `waitlisted`.
describe("waitlisting", () => {
  const t = useTestDatabase();

  it("a waitlisted booking always has creditsUsed=0", async () => {
    const cls = await createClass(t.db, { capacity: 1, creditCost: 4 });
    await fillClassToCapacity(t.db, cls);

    const member = await createMember(t.db);
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const booking = await callerAs(t.db, member).bookings.book({ classId: cls.id });

    expect(booking.status).toBe("waitlisted");
    expect(booking.creditsUsed).toBe(0);
  });

  it("bookings.waitlisted reports queue position 1-indexed, strictly by bookedAt", async () => {
    // position is computed as `count(waitlisted rows with an earlier bookedAt) + 1`
    // (bookings.ts `waitlisted`, lines ~384-393) — bookedAt has only
    // second-level resolution (SQLite CURRENT_TIMESTAMP), so this test sets
    // bookedAt explicitly to get a deterministic ordering rather than
    // depending on two inserts landing in different real-world seconds.
    const cls = await createClass(t.db, { capacity: 1 });
    await fillClassToCapacity(t.db, cls);

    const first = await createMember(t.db);
    const second = await createMember(t.db);
    await createActiveMembership(t.db, first.id, { creditsRemaining: 10 });
    await createActiveMembership(t.db, second.id, { creditsRemaining: 10 });

    const b1 = await callerAs(t.db, first).bookings.book({ classId: cls.id });
    const b2 = await callerAs(t.db, second).bookings.book({ classId: cls.id });
    await t.db.update(bookings).set({ bookedAt: "2026-01-01T00:00:00.000Z" }).where(eq(bookings.id, b1.id));
    await t.db.update(bookings).set({ bookedAt: "2026-01-01T00:00:05.000Z" }).where(eq(bookings.id, b2.id));

    const firstQueue = await callerAs(t.db, first).bookings.waitlisted();
    const secondQueue = await callerAs(t.db, second).bookings.waitlisted();

    expect(firstQueue[0].position).toBe(1);
    expect(secondQueue[0].position).toBe(2);
  });

  it("CURRENT BEHAVIOR (edge case): two members waitlisted within the same second tie for position 1", async () => {
    // bookedAt defaults to SQLite's CURRENT_TIMESTAMP, which has only
    // second-level resolution. Two `book()` calls landing in the same wall
    // clock second get an identical bookedAt, and the strict `<` comparison
    // in the position query means neither counts as "before" the other.
    const cls = await createClass(t.db, { capacity: 1 });
    await fillClassToCapacity(t.db, cls);

    const first = await createMember(t.db);
    const second = await createMember(t.db);
    await createActiveMembership(t.db, first.id, { creditsRemaining: 10 });
    await createActiveMembership(t.db, second.id, { creditsRemaining: 10 });

    const b1 = await callerAs(t.db, first).bookings.book({ classId: cls.id });
    const b2 = await callerAs(t.db, second).bookings.book({ classId: cls.id });
    const sameSecond = "2026-01-01T00:00:00.000Z";
    await t.db.update(bookings).set({ bookedAt: sameSecond }).where(eq(bookings.id, b1.id));
    await t.db.update(bookings).set({ bookedAt: sameSecond }).where(eq(bookings.id, b2.id));

    const firstQueue = await callerAs(t.db, first).bookings.waitlisted();
    const secondQueue = await callerAs(t.db, second).bookings.waitlisted();

    expect(firstQueue[0].position).toBe(1);
    expect(secondQueue[0].position).toBe(1); // both report position 1 — not a stable/unique ranking
  });

  it("a member can leave their own waitlist spot via cancel, and it does not trigger promotion of anyone else", async () => {
    const cls = await createClass(t.db, { capacity: 1 });
    await fillClassToCapacity(t.db, cls);

    const waiter1 = await createMember(t.db);
    const waiter2 = await createMember(t.db);
    await createActiveMembership(t.db, waiter1.id, { creditsRemaining: 10 });
    await createActiveMembership(t.db, waiter2.id, { creditsRemaining: 10 });

    const b1 = await callerAs(t.db, waiter1).bookings.book({ classId: cls.id });
    await callerAs(t.db, waiter2).bookings.book({ classId: cls.id });

    await callerAs(t.db, waiter1).bookings.cancel({ bookingId: b1.id });

    // CURRENT BEHAVIOR: promotion only runs when a "booked" row is cancelled
    // (bookings.ts line ~213: `if (row.booking.status === "booked")`), not
    // when a waitlisted row is cancelled — so waiter2 stays waitlisted.
    const queue = await callerAs(t.db, waiter2).bookings.waitlisted();
    expect(queue).toHaveLength(1);
    expect(queue[0].position).toBe(1);
  });
});
