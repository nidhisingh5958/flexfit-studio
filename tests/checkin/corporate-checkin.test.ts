import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { checkins } from "@/db/schema";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createAdmin,
  createClass,
  createCompany,
  linkMemberToCompany,
  getCorporateBooking,
} from "../helpers";

// ARCH-008: corporate check-ins cannot be traced back to their booking.
// Source: src/db/schema.ts `checkins.bookingId` is a single FK into
// `bookings` only; src/server/routers/corporate-bookings.ts `markAttended`
// (lines ~291-299) inserts `checkins` with `bookingId: null` because there's
// nowhere else to point it.
describe("ARCH-008: corporateBookings.markAttended and the checkins table", () => {
  const t = useTestDatabase();

  it("flips the corporate booking to attended, same as the individual flow", async () => {
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

  it("CURRENT BEHAVIOR: the resulting checkins row has bookingId=null — it cannot be linked back to the corporate booking", async () => {
    const member = await createMember(t.db);
    const company = await createCompany(t.db, { creditPoolBalance: 20 });
    await linkMemberToCompany(t.db, member.id, company.id);
    const cls = await createClass(t.db, { capacity: 5 });
    const booking = await callerAs(t.db, member).corporateBookings.book({ classId: cls.id });

    const admin = await createAdmin(t.db);
    await callerAs(t.db, admin).corporateBookings.markAttended({ bookingId: booking.id });

    const rows = await t.db.select().from(checkins).where(eq(checkins.userId, member.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].bookingId).toBeNull();
  });

  it("CURRENT BEHAVIOR: bookings.checkinCountFor (joins checkins to the `bookings` table) never sees corporate check-ins", async () => {
    const member = await createMember(t.db);
    const company = await createCompany(t.db, { creditPoolBalance: 20 });
    await linkMemberToCompany(t.db, member.id, company.id);
    const cls = await createClass(t.db, { capacity: 5 });
    const booking = await callerAs(t.db, member).corporateBookings.book({ classId: cls.id });

    const admin = await createAdmin(t.db);
    await callerAs(t.db, admin).corporateBookings.markAttended({ bookingId: booking.id });

    const count = await callerAs(t.db, admin).bookings.checkinCountFor({ classId: cls.id });
    expect(count.count).toBe(0); // the check-in exists, but isn't counted here
  });
});
