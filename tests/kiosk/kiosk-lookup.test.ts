import { describe, it, expect } from "vitest";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createTrainer,
  createAdmin,
  createActiveMembership,
  createExpiredMembership,
  createClass,
  daysFromNowDateOnly,
} from "../helpers";

// Flow 16 (kiosk / member lookup). Source: src/server/routers/members.ts
// `lookupByEmailOrPhone` (lines 134-161).
describe("members.lookupByEmailOrPhone", () => {
  const t = useTestDatabase();

  it("finds a member by exact email", async () => {
    const staff = await createAdmin(t.db);
    const member = await createMember(t.db, { email: "unique.lookup@test.local" });
    const found = await callerAs(t.db, staff).members.lookupByEmailOrPhone({ query: "unique.lookup@test.local" });
    expect(found.id).toBe(member.id);
  });

  it("finds a member by a phone substring", async () => {
    const staff = await createAdmin(t.db);
    const member = await createMember(t.db, { phone: "+91 90000 55555" });
    const found = await callerAs(t.db, staff).members.lookupByEmailOrPhone({ query: "90000 55555" });
    expect(found.id).toBe(member.id);
  });

  it('rejects with NOT_FOUND "Member not found." when nothing matches', async () => {
    const staff = await createAdmin(t.db);
    await expect(
      callerAs(t.db, staff).members.lookupByEmailOrPhone({ query: "nobody-matches-this@nowhere.invalid" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Member not found." });
  });

  it('rejects with NOT_FOUND "Member not found." when the match is a trainer or admin, not a member', async () => {
    const staff = await createAdmin(t.db);
    await createTrainer(t.db, { email: "staffonly@test.local" });
    await expect(
      callerAs(t.db, staff).members.lookupByEmailOrPhone({ query: "staffonly@test.local" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Member not found." });
  });

  it("BUG-008 / CURRENT BEHAVIOR: an ambiguous query matching two members returns exactly one of them, with no indication the match was ambiguous", async () => {
    const staff = await createAdmin(t.db);
    const a = await createMember(t.db, { phone: "+91 90000 10001" });
    const b = await createMember(t.db, { phone: "+91 90000 10002" });

    // "90000 1000" matches both — the query has no ORDER BY, so which one
    // comes back is an artifact of table scan order, not a documented rule.
    const found = await callerAs(t.db, staff).members.lookupByEmailOrPhone({ query: "90000 1000" });
    expect([a.id, b.id]).toContain(found.id);
  });

  it("requires staff (staffProcedure)", async () => {
    const member = await createMember(t.db);
    const target = await createMember(t.db, { email: "target@test.local" });
    await expect(
      callerAs(t.db, member).members.lookupByEmailOrPhone({ query: "target@test.local" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "Staff only." });
  });
});

// BUG-009: the kiosk's "membership expired / no credits" warning reads
// members.byId's memberships[0] (ordered by startDate desc, no status
// filter) rather than the same activeMembershipFor() selection (status +
// endDate desc) that actually gates booking. This test reproduces the
// divergence at the data layer the kiosk page (src/app/kiosk/page.tsx
// lines 50-54) reads from.
describe("BUG-009: members.byId's membership ordering disagrees with the booking engine's selection", () => {
  const t = useTestDatabase();

  it("CURRENT BEHAVIOR: byId's first membership (by startDate desc) can be a different row than what bookings.book would actually use", async () => {
    const staff = await createAdmin(t.db);
    const member = await createMember(t.db);

    // Older membership: still active, plenty of credits, later endDate —
    // this is the one bookings.book's activeMembershipFor() would select.
    await createActiveMembership(t.db, member.id, {
      startDate: daysFromNowDateOnly(-30),
      endDate: daysFromNowDateOnly(60),
      creditsRemaining: 10,
    });

    // Newer-by-startDate membership: expired, 0 credits. members.byId's
    // history is ordered `desc(startDate)`, so this row is memberships[0].
    await createExpiredMembership(t.db, member.id, {
      startDate: daysFromNowDateOnly(-1),
      creditsRemaining: 0,
    });

    const details = await callerAs(t.db, staff).members.byId({ id: member.id });
    // Kiosk reads memberships[0] directly for its expired/no-credits banner.
    const kioskWouldReadFirst = details.memberships[0];
    expect(kioskWouldReadFirst.status).toBe("expired");
    expect(kioskWouldReadFirst.creditsRemaining).toBe(0);

    // But the actual booking gate (activeMembershipFor: status='active' AND
    // endDate >= today, ordered by furthest endDate) would use the OTHER,
    // still-valid membership — the kiosk would show "expired"/"no credits"
    // warnings for a member who can, in fact, still book.
    const cls = await createClass(t.db, { capacity: 5 });
    const booking = await callerAs(t.db, member).bookings.book({ classId: cls.id });
    expect(booking.status).toBe("booked"); // succeeds despite the kiosk's (misleading) banner data
  });
});
