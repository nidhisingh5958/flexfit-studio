import { describe, it, expect } from "vitest";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createAdmin,
  createClass,
  createCompany,
  linkMemberToCompany,
  getCompany,
} from "../helpers";

// BUG-007: a member linked to more than one active company. Source:
// src/server/routers/admin-companies.ts `linkMember` (only rejects an exact
// duplicate companyId+userId pair — nothing stops linking to a second,
// different company) and src/server/routers/corporate-bookings.ts
// `getCompanyForMember` (no `orderBy`, `.get()` takes whichever the join
// happens to return first).
describe("BUG-007: a member linked to two active companies", () => {
  const t = useTestDatabase();

  it("admin.linkMember does not prevent linking one member to a second company", async () => {
    const admin = await createAdmin(t.db);
    const member = await createMember(t.db);
    const companyA = await createCompany(t.db, { name: "Company A" });
    const companyB = await createCompany(t.db, { name: "Company B" });

    await callerAs(t.db, admin).adminCompanies.linkMember({ companyId: companyA.id, userId: member.id });
    await expect(
      callerAs(t.db, admin).adminCompanies.linkMember({ companyId: companyB.id, userId: member.id }),
    ).resolves.toBeTruthy();
  });

  it("CURRENT BEHAVIOR: exactly one company is charged for a corporate booking, deterministically for a given data state, but which one is not defined by any documented rule", async () => {
    const admin = await createAdmin(t.db);
    const member = await createMember(t.db);
    const companyA = await createCompany(t.db, { name: "Company A", creditPoolBalance: 50 });
    const companyB = await createCompany(t.db, { name: "Company B", creditPoolBalance: 50 });
    await callerAs(t.db, admin).adminCompanies.linkMember({ companyId: companyA.id, userId: member.id });
    await callerAs(t.db, admin).adminCompanies.linkMember({ companyId: companyB.id, userId: member.id });

    const cls = await createClass(t.db, { capacity: 5, creditCost: 5 });
    const booking = await callerAs(t.db, member).corporateBookings.book({ classId: cls.id });

    // The booking is unambiguously charged to exactly one company...
    expect([companyA.id, companyB.id]).toContain(booking.companyId);

    const chargedCompany = await getCompany(t.db, booking.companyId);
    const otherCompanyId = booking.companyId === companyA.id ? companyB.id : companyA.id;
    const otherCompany = await getCompany(t.db, otherCompanyId);

    expect(chargedCompany?.creditPoolBalance).toBe(45); // debited
    expect(otherCompany?.creditPoolBalance).toBe(50); // untouched

    // ...but nothing in admin-companies.ts or corporate-bookings.ts
    // expresses which one "should" win — getCompanyForMember has no
    // orderBy, so this is an artifact of query/insertion order, not a
    // documented business rule. Recorded here as unresolved in
    // docs/open-questions.md.
  });
});
