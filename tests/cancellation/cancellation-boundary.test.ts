import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createClass,
  createActiveMembership,
  fillClassToCapacity,
  getMembership,
  getBooking,
} from "../helpers";

// Flow 7 (credit refund) + the free-cancellation boundary edge cases called
// out explicitly by the task. Source: src/server/routers/bookings.ts
// `FREE_CANCELLATION_HOURS = 12` and the `refundable` calculation in `cancel`
// (lines ~188-190): `hoursUntil(cls.startsAt) >= FREE_CANCELLATION_HOURS &&
// booking.creditsUsed > 0`.
//
// Real wall-clock time drifts by milliseconds between class setup and the
// cancel call, which makes an exact-boundary assertion flaky against real
// time. These tests freeze the clock with vi.useFakeTimers() so "exactly 12
// hours before start" is a deterministic value, not a race against test
// execution speed.
describe("bookings.cancel — free-cancellation boundary (12 hours)", () => {
  const t = useTestDatabase();
  const NOW = new Date("2026-06-01T12:00:00.000Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function setupBookedClass(hoursUntilStart: number) {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, {
      capacity: 5,
      creditCost: 3,
      startsAt: new Date(NOW + hoursUntilStart * 60 * 60 * 1000).toISOString(),
    });
    const ms = await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const caller = callerAs(t.db, member);
    const booking = await caller.bookings.book({ classId: cls.id });
    return { member, cls, ms, caller, booking };
  }

  it("exactly 12 hours before start (inclusive boundary): refunded = true, credits restored", async () => {
    const { caller, booking, ms } = await setupBookedClass(12);

    const result = await caller.bookings.cancel({ bookingId: booking.id });
    expect(result.refunded).toBe(true);

    const updated = await getMembership(t.db, ms.id);
    expect(updated?.creditsRemaining).toBe(10); // 7 + 3 refunded back to 10
  });

  it("11 hours 59 minutes before start (just inside / under the window): refunded = false, credits NOT restored", async () => {
    const { caller, booking, ms } = await setupBookedClass(11 + 59 / 60);

    const result = await caller.bookings.cancel({ bookingId: booking.id });
    expect(result.refunded).toBe(false);

    const updated = await getMembership(t.db, ms.id);
    expect(updated?.creditsRemaining).toBe(7); // unchanged — 10 - 3 spent, no refund
  });

  it("12 hours 1 minute before start (just outside / clear of the window): refunded = true", async () => {
    const { caller, booking, ms } = await setupBookedClass(12 + 1 / 60);

    const result = await caller.bookings.cancel({ bookingId: booking.id });
    expect(result.refunded).toBe(true);

    const updated = await getMembership(t.db, ms.id);
    expect(updated?.creditsRemaining).toBe(10);
  });

  it("far in advance, but the booking was waitlisted (creditsUsed=0): refunded = false regardless of timing", async () => {
    const cls = await createClass(t.db, {
      capacity: 1,
      creditCost: 3,
      startsAt: new Date(NOW + 999 * 60 * 60 * 1000).toISOString(),
    });
    await fillClassToCapacity(t.db, cls);

    const waiter = await createMember(t.db);
    const ms = await createActiveMembership(t.db, waiter.id, { creditsRemaining: 10 });
    const caller = callerAs(t.db, waiter);
    const booking = await caller.bookings.book({ classId: cls.id });
    expect(booking.creditsUsed).toBe(0);

    const result = await caller.bookings.cancel({ bookingId: booking.id });
    expect(result.refunded).toBe(false);

    const updated = await getMembership(t.db, ms.id);
    expect(updated?.creditsRemaining).toBe(10); // never spent, so correctly nothing to refund
  });

  it("does not refund an unlimited (999-credit) membership even when inside the free window", async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, {
      capacity: 5,
      creditCost: 1,
      startsAt: new Date(NOW + 999 * 60 * 60 * 1000).toISOString(),
    });
    const ms = await createActiveMembership(t.db, member.id, { creditsRemaining: 999 });
    const caller = callerAs(t.db, member);
    const booking = await caller.bookings.book({ classId: cls.id });

    await caller.bookings.cancel({ bookingId: booking.id });

    const updated = await getMembership(t.db, ms.id);
    expect(updated?.creditsRemaining).toBe(999); // guarded by `ms.creditsRemaining < UNLIMITED_CREDITS`
  });

  it("cancelling always sets status=cancelled and cancelledAt regardless of refund eligibility", async () => {
    const { caller, booking } = await setupBookedClass(1); // inside the window, not refundable
    await caller.bookings.cancel({ bookingId: booking.id });
    const row = await getBooking(t.db, booking.id);
    expect(row?.status).toBe("cancelled");
    expect(row?.cancelledAt).not.toBeNull();
  });
});
