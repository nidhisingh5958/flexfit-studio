import { describe, it, expect } from "vitest";
import { checkins } from "@/db/schema";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createTrainer,
  createAdmin,
  createClass,
  createActiveMembership,
  createExpiredMembership,
  createPayment,
  daysFromNowDateOnly,
  hoursFromNow,
} from "../helpers";

// HIGH GAP 6: admin.stats. Source: src/server/routers/admin.ts `stats`
// (lines 15-61):
//   totalMembers      = count(users where role='member')
//   activeMemberships = count(memberships where status='active' AND endDate>=today)
//   upcomingClasses   = count(classes where startsAt>=now AND cancelled=false)
//   revenueCents      = sum(payments.amountCents where status='paid')
//   totalCheckins     = count(checkins)
//   pendingPayments   = count(payments where status='pending')
//
// Every fixture below is deliberately built so each field's expected value
// can be derived exactly from the setup — not asserted against real seed
// data, and not just checked for "is defined." If any one of these six
// computations changes, this test fails on that specific field.
describe("admin.stats — exact field values derived from a controlled fixture", () => {
  const t = useTestDatabase();

  it("returns counts/sums that match the fixture precisely", async () => {
    const admin = await createAdmin(t.db);

    // totalMembers: only role='member' rows count — trainers, and the
    // calling admin itself, must not be included.
    const memberA = await createMember(t.db);
    const memberB = await createMember(t.db);
    const memberC = await createMember(t.db);
    await createTrainer(t.db);

    // activeMemberships: status='active' AND endDate >= today.
    await createActiveMembership(t.db, memberA.id, { endDate: daysFromNowDateOnly(10) }); // counts
    await createActiveMembership(t.db, memberB.id, { endDate: daysFromNowDateOnly(30) }); // counts
    await createExpiredMembership(t.db, memberC.id); // status='expired' + past endDate — excluded
    await createActiveMembership(t.db, memberC.id, { status: "cancelled", endDate: daysFromNowDateOnly(30) }); // wrong status — excluded

    // upcomingClasses: startsAt >= now AND cancelled=false.
    await createClass(t.db, { startsAt: hoursFromNow(1) }); // counts
    await createClass(t.db, { startsAt: hoursFromNow(48) }); // counts
    await createClass(t.db, { startsAt: hoursFromNow(72), cancelled: true }); // cancelled — excluded
    await createClass(t.db, { startsAt: hoursFromNow(-1) }); // already started — excluded

    // revenueCents (paid only) / pendingPayments (pending only).
    await createPayment(t.db, { userId: memberA.id, amountCents: 100000, status: "paid" }); // counts toward revenue
    await createPayment(t.db, { userId: memberB.id, amountCents: 50000, status: "paid" }); // counts toward revenue
    await createPayment(t.db, { userId: memberC.id, amountCents: 99999, status: "pending" }); // counts toward pendingPayments only
    await createPayment(t.db, { userId: memberA.id, amountCents: 77777, status: "refunded" }); // excluded from both

    // totalCheckins: every row in `checkins`, unconditionally.
    await t.db.insert(checkins).values([
      { userId: memberA.id, source: "front_desk" },
      { userId: memberB.id, source: "kiosk" },
    ]);

    const stats = await callerAs(t.db, admin).admin.stats();

    expect(stats).toEqual({
      totalMembers: 3,
      activeMemberships: 2,
      upcomingClasses: 2,
      revenueCents: 150000,
      totalCheckins: 2,
      pendingPayments: 1,
    });
  });

  it("returns all zeros against an otherwise-empty database (baseline, no fixture noise)", async () => {
    const admin = await createAdmin(t.db);
    const stats = await callerAs(t.db, admin).admin.stats();

    expect(stats).toEqual({
      totalMembers: 0,
      activeMemberships: 0,
      upcomingClasses: 0,
      revenueCents: 0,
      totalCheckins: 0,
      pendingPayments: 0,
    });
  });
});
