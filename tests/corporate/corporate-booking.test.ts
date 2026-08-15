import { describe, it, expect } from "vitest";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createClass,
  createCompany,
  linkMemberToCompany,
  getCompany,
  hoursFromNow,
} from "../helpers";

// Flow 10 (corporate booking). Source: src/server/routers/corporate-bookings.ts `book`.
// Per audit ARCH-001, this router has no frontend caller anywhere in
// src/app or src/components — reachable today only via a direct tRPC call
// by any logged-in member linked to an active company.
describe("corporateBookings.book — golden path", () => {
  const t = useTestDatabase();

  it("books against the company's credit pool and debits creditCost from creditPoolBalance", async () => {
    const member = await createMember(t.db);
    const company = await createCompany(t.db, { creditPoolBalance: 20 });
    await linkMemberToCompany(t.db, member.id, company.id);
    const cls = await createClass(t.db, { capacity: 5, creditCost: 3 });

    const booking = await callerAs(t.db, member).corporateBookings.book({ classId: cls.id });

    expect(booking.status).toBe("booked");
    expect(booking.creditsUsed).toBe(3);
    expect(booking.companyId).toBe(company.id);
    expect((await getCompany(t.db, company.id))?.creditPoolBalance).toBe(17);
  });

  it('rejects with FORBIDDEN "You are not linked to an active company." for an unlinked member', async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db);
    await expect(callerAs(t.db, member).corporateBookings.book({ classId: cls.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "You are not linked to an active company.",
    });
  });

  it('treats a member linked to an INACTIVE company the same as unlinked', async () => {
    const member = await createMember(t.db);
    const company = await createCompany(t.db, { active: false });
    await linkMemberToCompany(t.db, member.id, company.id);
    const cls = await createClass(t.db);

    await expect(callerAs(t.db, member).corporateBookings.book({ classId: cls.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "You are not linked to an active company.",
    });
  });

  it('rejects with FORBIDDEN "Your company does not have enough credits." when the pool is short', async () => {
    const member = await createMember(t.db);
    const company = await createCompany(t.db, { creditPoolBalance: 2 });
    await linkMemberToCompany(t.db, member.id, company.id);
    const cls = await createClass(t.db, { creditCost: 3 });

    await expect(callerAs(t.db, member).corporateBookings.book({ classId: cls.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Your company does not have enough credits.",
    });
  });

  it("credit check runs before the capacity check: an insufficient pool blocks booking even into a class that isn't full", async () => {
    const member = await createMember(t.db);
    const company = await createCompany(t.db, { creditPoolBalance: 0 });
    await linkMemberToCompany(t.db, member.id, company.id);
    const cls = await createClass(t.db, { capacity: 10, creditCost: 1 });

    await expect(callerAs(t.db, member).corporateBookings.book({ classId: cls.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Your company does not have enough credits.",
    });
  });

  it('rejects a second corporate booking for the same class with CONFLICT "You are already on the list for this class."', async () => {
    const member = await createMember(t.db);
    const company = await createCompany(t.db, { creditPoolBalance: 20 });
    await linkMemberToCompany(t.db, member.id, company.id);
    const cls = await createClass(t.db, { capacity: 5 });
    const caller = callerAs(t.db, member);

    await caller.corporateBookings.book({ classId: cls.id });
    await expect(caller.corporateBookings.book({ classId: cls.id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "You are already on the list for this class.",
    });
  });

  it('rejects with BAD_REQUEST "This class has already started." for a past class', async () => {
    const member = await createMember(t.db);
    const company = await createCompany(t.db, { creditPoolBalance: 20 });
    await linkMemberToCompany(t.db, member.id, company.id);
    const cls = await createClass(t.db, { startsAt: hoursFromNow(-1) });

    await expect(callerAs(t.db, member).corporateBookings.book({ classId: cls.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This class has already started.",
    });
  });

  it("waitlists once the class is full by corporate bookings alone, with creditsUsed=0 and no pool debit", async () => {
    const cls = await createClass(t.db, { capacity: 1, creditCost: 2 });
    const company = await createCompany(t.db, { creditPoolBalance: 20 });

    const holder = await createMember(t.db);
    await linkMemberToCompany(t.db, holder.id, company.id);
    await callerAs(t.db, holder).corporateBookings.book({ classId: cls.id });

    const overflow = await createMember(t.db);
    await linkMemberToCompany(t.db, overflow.id, company.id);
    const booking = await callerAs(t.db, overflow).corporateBookings.book({ classId: cls.id });

    expect(booking.status).toBe("waitlisted");
    expect(booking.creditsUsed).toBe(0);
    expect((await getCompany(t.db, company.id))?.creditPoolBalance).toBe(18); // only the first booking charged
  });
});
