import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { notifications } from "@/db/schema";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createAdmin,
  createClass,
  createActiveMembership,
  createCompany,
  linkMemberToCompany,
  getBooking,
  getCorporateBooking,
  getMembership,
  getCompany,
  hoursFromNow,
} from "../helpers";

// BUG-005: admin class cancellation. Source: src/server/routers/classes.ts
// `cancel` (lines ~132-154) — the entire side-effect set is: set
// classes.cancelled=true, and cancel `bookings` rows with status='booked'
// for that class. Nothing else.
describe("BUG-005: classes.cancel side effects", () => {
  const t = useTestDatabase();

  async function setupMixedClass() {
    const admin = await createAdmin(t.db);
    const cls = await createClass(t.db, { capacity: 1, creditCost: 4, startsAt: hoursFromNow(48) });

    const bookedMember = await createMember(t.db);
    const bookedMs = await createActiveMembership(t.db, bookedMember.id, { creditsRemaining: 10 });
    const bookedBooking = await callerAs(t.db, bookedMember).bookings.book({ classId: cls.id });
    expect(bookedBooking.status).toBe("booked");

    const waitlistedMember = await createMember(t.db);
    await createActiveMembership(t.db, waitlistedMember.id, { creditsRemaining: 10 });
    const waitlistedBooking = await callerAs(t.db, waitlistedMember).bookings.book({ classId: cls.id });
    expect(waitlistedBooking.status).toBe("waitlisted");

    const corporateMember = await createMember(t.db);
    const company = await createCompany(t.db, { creditPoolBalance: 20 });
    await linkMemberToCompany(t.db, corporateMember.id, company.id);
    const corporateBooking = await callerAs(t.db, corporateMember).corporateBookings.book({ classId: cls.id });
    expect(corporateBooking.status).toBe("booked"); // capacity is per-table (BUG-001), so this also succeeds

    return { admin, cls, bookedMember, bookedMs, bookedBooking, waitlistedBooking, corporateMember, company, corporateBooking };
  }

  it("cancels 'booked' individual bookings for the class", async () => {
    const { admin, cls, bookedBooking } = await setupMixedClass();
    await callerAs(t.db, admin).classes.cancel({ id: cls.id });
    const row = await getBooking(t.db, bookedBooking.id);
    expect(row?.status).toBe("cancelled");
  });

  it("CURRENT BEHAVIOR: does NOT refund the cancelled member's credits", async () => {
    const { admin, cls, bookedMs } = await setupMixedClass();
    const before = (await getMembership(t.db, bookedMs.id))!.creditsRemaining;
    await callerAs(t.db, admin).classes.cancel({ id: cls.id });
    const after = (await getMembership(t.db, bookedMs.id))!.creditsRemaining;
    expect(after).toBe(before); // still down the 4 credits spent at booking time
  });

  it("CURRENT BEHAVIOR: does NOT cancel 'waitlisted' individual bookings for the class", async () => {
    const { admin, cls, waitlistedBooking } = await setupMixedClass();
    await callerAs(t.db, admin).classes.cancel({ id: cls.id });
    const row = await getBooking(t.db, waitlistedBooking.id);
    expect(row?.status).toBe("waitlisted"); // left dangling against a cancelled class
  });

  it("CURRENT BEHAVIOR: does NOT touch corporate bookings for the class at all", async () => {
    const { admin, cls, corporateBooking, company } = await setupMixedClass();
    const poolBefore = (await getCompany(t.db, company.id))!.creditPoolBalance;

    await callerAs(t.db, admin).classes.cancel({ id: cls.id });

    const row = await getCorporateBooking(t.db, corporateBooking.id);
    expect(row?.status).toBe("booked"); // still shows as confirmed for a cancelled class
    const poolAfter = (await getCompany(t.db, company.id))!.creditPoolBalance;
    expect(poolAfter).toBe(poolBefore); // no refund
  });

  it("CURRENT BEHAVIOR: does NOT insert a class_cancelled notification for any affected member", async () => {
    const { admin, cls, bookedMember, waitlistedBooking } = await setupMixedClass();
    void waitlistedBooking;
    await callerAs(t.db, admin).classes.cancel({ id: cls.id });

    const rows = await t.db.select().from(notifications).where(eq(notifications.userId, bookedMember.id));
    expect(rows.filter((n) => n.type === "class_cancelled")).toHaveLength(0);
  });

  it("still marks the class itself as cancelled=true", async () => {
    const { admin, cls } = await setupMixedClass();
    const result = await callerAs(t.db, admin).classes.cancel({ id: cls.id });
    expect(result.cancelled).toBe(true);
  });

  it('rejects with NOT_FOUND "Class not found." for an unknown class id', async () => {
    const admin = await createAdmin(t.db);
    await expect(callerAs(t.db, admin).classes.cancel({ id: 999999 })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Class not found.",
    });
  });

  it("requires admin (adminProcedure) — a trainer cannot cancel a class", async () => {
    const trainer = await createMember(t.db, { role: "trainer" });
    const cls = await createClass(t.db);
    await expect(callerAs(t.db, trainer).classes.cancel({ id: cls.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Admins only.",
    });
  });
});
