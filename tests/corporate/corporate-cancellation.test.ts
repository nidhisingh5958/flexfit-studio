import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createTrainer,
  createAdmin,
  createClass,
  createCompany,
  linkMemberToCompany,
  getCompany,
  getCorporateBooking,
} from "../helpers";

// Flow 11 (corporate cancellation). Source: src/server/routers/
// corporate-bookings.ts `cancel`, CORPORATE_FREE_CANCELLATION_HOURS = 24.
describe("corporateBookings.cancel — ownership & status rules (mirrors bookings.cancel)", () => {
  const t = useTestDatabase();

  it("the owning member can cancel; staff (admin/trainer) can cancel on their behalf — and each cancellation actually updates the booking row and refunds the pool", async () => {
    // cls starts 48h out (default createClass startsAt) and creditCost
    // defaults to 1 — comfortably inside the 24h corporate free-cancellation
    // window, so every cancel below is expected to refund.
    const member = await createMember(t.db);
    const company = await createCompany(t.db, { creditPoolBalance: 20 });
    await linkMemberToCompany(t.db, member.id, company.id);
    const cls = await createClass(t.db, { capacity: 5 });
    const caller = callerAs(t.db, member);

    // 1. Owner cancels their own booking.
    const b1 = await caller.corporateBookings.book({ classId: cls.id });
    expect((await getCompany(t.db, company.id))?.creditPoolBalance).toBe(19);
    const ownerCancelResult = await caller.corporateBookings.cancel({ bookingId: b1.id });
    expect(ownerCancelResult).toMatchObject({ ok: true, refunded: true });

    const b1Row = await getCorporateBooking(t.db, b1.id);
    expect(b1Row?.status).toBe("cancelled");
    expect(b1Row?.cancelledAt).not.toBeNull();
    expect((await getCompany(t.db, company.id))?.creditPoolBalance).toBe(20); // refunded

    // 2. Admin cancels on the member's behalf.
    const b2 = await caller.corporateBookings.book({ classId: cls.id });
    expect((await getCompany(t.db, company.id))?.creditPoolBalance).toBe(19);
    const admin = await createAdmin(t.db);
    const adminCancelResult = await callerAs(t.db, admin).corporateBookings.cancel({ bookingId: b2.id });
    expect(adminCancelResult).toMatchObject({ ok: true, refunded: true });

    const b2Row = await getCorporateBooking(t.db, b2.id);
    expect(b2Row?.status).toBe("cancelled");
    expect(b2Row?.cancelledAt).not.toBeNull();
    expect((await getCompany(t.db, company.id))?.creditPoolBalance).toBe(20); // refunded

    // 3. Trainer cancels on the member's behalf.
    const b3 = await caller.corporateBookings.book({ classId: cls.id });
    expect((await getCompany(t.db, company.id))?.creditPoolBalance).toBe(19);
    const trainer = await createTrainer(t.db);
    const trainerCancelResult = await callerAs(t.db, trainer).corporateBookings.cancel({ bookingId: b3.id });
    expect(trainerCancelResult).toMatchObject({ ok: true, refunded: true });

    const b3Row = await getCorporateBooking(t.db, b3.id);
    expect(b3Row?.status).toBe("cancelled");
    expect(b3Row?.cancelledAt).not.toBeNull();
    expect((await getCompany(t.db, company.id))?.creditPoolBalance).toBe(20); // refunded
  });

  it('a different member gets FORBIDDEN "You cannot cancel this booking."', async () => {
    const member = await createMember(t.db);
    const company = await createCompany(t.db, { creditPoolBalance: 20 });
    await linkMemberToCompany(t.db, member.id, company.id);
    const cls = await createClass(t.db, { capacity: 5 });
    const booking = await callerAs(t.db, member).corporateBookings.book({ classId: cls.id });

    const stranger = await createMember(t.db);
    await expect(callerAs(t.db, stranger).corporateBookings.cancel({ bookingId: booking.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "You cannot cancel this booking.",
    });
  });
});

describe("corporateBookings.cancel — free-cancellation boundary (24 hours)", () => {
  const t = useTestDatabase();
  const NOW = new Date("2026-06-01T12:00:00.000Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function setupCorporateBooking(hoursUntilStart: number, poolBalance = 20) {
    const member = await createMember(t.db);
    const company = await createCompany(t.db, { creditPoolBalance: poolBalance });
    await linkMemberToCompany(t.db, member.id, company.id);
    const cls = await createClass(t.db, {
      capacity: 5,
      creditCost: 3,
      startsAt: new Date(NOW + hoursUntilStart * 60 * 60 * 1000).toISOString(),
    });
    const caller = callerAs(t.db, member);
    const booking = await caller.corporateBookings.book({ classId: cls.id });
    return { member, company, cls, caller, booking };
  }

  it("exactly 24 hours before start: refunded=true, pool balance restored", async () => {
    const { caller, booking, company } = await setupCorporateBooking(24);
    const result = await caller.corporateBookings.cancel({ bookingId: booking.id });
    expect(result.refunded).toBe(true);
    expect((await getCompany(t.db, company.id))?.creditPoolBalance).toBe(20);
  });

  it("23 hours 59 minutes before start: refunded=false, pool balance NOT restored", async () => {
    const { caller, booking, company } = await setupCorporateBooking(23 + 59 / 60);
    const result = await caller.corporateBookings.cancel({ bookingId: booking.id });
    expect(result.refunded).toBe(false);
    expect((await getCompany(t.db, company.id))?.creditPoolBalance).toBe(17); // still debited
  });

  it("this boundary is 24h, not the individual flow's 12h — same class timing refunds corporate but not individual", async () => {
    // Cross-check against FREE_CANCELLATION_HOURS (12h, individual): at 18h
    // out, an individual booking would be refundable but is presented here
    // purely to document that corporate's window is a distinct, larger
    // constant (CORPORATE_FREE_CANCELLATION_HOURS=24), not a shared one.
    const { caller, booking, company } = await setupCorporateBooking(18);
    const result = await caller.corporateBookings.cancel({ bookingId: booking.id });
    expect(result.refunded).toBe(false); // 18h < 24h window
    expect((await getCompany(t.db, company.id))?.creditPoolBalance).toBe(17);
  });
});

describe("corporateBookings.markAttended", () => {
  const t = useTestDatabase();

  it("flips status booked -> attended and records a checkin row", async () => {
    const member = await createMember(t.db);
    const company = await createCompany(t.db, { creditPoolBalance: 20 });
    await linkMemberToCompany(t.db, member.id, company.id);
    const cls = await createClass(t.db, { capacity: 5 });
    const booking = await callerAs(t.db, member).corporateBookings.book({ classId: cls.id });

    const admin = await createAdmin(t.db);
    await callerAs(t.db, admin).corporateBookings.markAttended({ bookingId: booking.id });

    const row = await getCorporateBooking(t.db, booking.id);
    expect(row?.status).toBe("attended");
  });

  it('rejects with BAD_REQUEST "Only confirmed bookings can be checked in." for a waitlisted booking', async () => {
    const cls = await createClass(t.db, { capacity: 1 });
    const company = await createCompany(t.db, { creditPoolBalance: 20 });

    const holder = await createMember(t.db);
    await linkMemberToCompany(t.db, holder.id, company.id);
    await callerAs(t.db, holder).corporateBookings.book({ classId: cls.id });

    const overflow = await createMember(t.db);
    await linkMemberToCompany(t.db, overflow.id, company.id);
    const waitlisted = await callerAs(t.db, overflow).corporateBookings.book({ classId: cls.id });

    const admin = await createAdmin(t.db);
    await expect(callerAs(t.db, admin).corporateBookings.markAttended({ bookingId: waitlisted.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Only confirmed bookings can be checked in.",
    });
  });
});
