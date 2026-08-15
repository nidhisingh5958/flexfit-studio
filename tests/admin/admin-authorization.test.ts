import { describe, it, expect } from "vitest";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createTrainer,
  createAdmin,
  createClass,
  createActiveMembership,
} from "../helpers";

// Flow 15 (authorization), admin-only surface. Source: adminProcedure in
// src/server/trpc.ts (lines 53-58): "Admins only." for any non-admin role.
describe("adminProcedure gates admin-only mutations/queries", () => {
  const t = useTestDatabase();

  it("admin.stats is reachable by an admin and reflects real fixture data (see admin-stats.test.ts for the full field-by-field characterization)", async () => {
    const admin = await createAdmin(t.db);
    await createMember(t.db);
    const stats = await callerAs(t.db, admin).admin.stats();
    expect(stats.totalMembers).toBe(1);
  });

  it('admin.stats rejects a member with FORBIDDEN "Admins only."', async () => {
    const member = await createMember(t.db);
    await expect(callerAs(t.db, member).admin.stats()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Admins only.",
    });
  });

  it('admin.stats rejects a trainer with FORBIDDEN "Admins only." — staff is not enough here, unlike bookings.markAttended', async () => {
    const trainer = await createTrainer(t.db);
    await expect(callerAs(t.db, trainer).admin.stats()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Admins only.",
    });
  });

  it('members.setActive and members.setRole require admin, not just staff', async () => {
    const trainer = await createTrainer(t.db);
    const target = await createMember(t.db);
    await expect(callerAs(t.db, trainer).members.setActive({ id: target.id, active: false })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Admins only.",
    });
    await expect(callerAs(t.db, trainer).members.setRole({ id: target.id, role: "trainer" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Admins only.",
    });
  });

  it("an admin can deactivate a member and change their role", async () => {
    const admin = await createAdmin(t.db);
    const target = await createMember(t.db);

    const deactivated = await callerAs(t.db, admin).members.setActive({ id: target.id, active: false });
    expect(deactivated.active).toBe(false);

    const promoted = await callerAs(t.db, admin).members.setRole({ id: target.id, role: "trainer" });
    expect(promoted.role).toBe("trainer");
  });

  it('adminCompanies.create requires admin, not staff', async () => {
    const trainer = await createTrainer(t.db);
    await expect(
      callerAs(t.db, trainer).adminCompanies.create({ name: "X", contactEmail: "x@example.com", creditPoolBalance: 0 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "Admins only." });
  });

  it("unauthenticated callers get UNAUTHORIZED before the FORBIDDEN admin check even runs", async () => {
    await expect(callerAs(t.db, null).admin.stats()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Sign in required.",
    });
  });
});

// SEC-003: staff-wide scope. Documents that ANY trainer (not just the one
// teaching the class) can check members in / view the roster for ANY class.
// Source: bookings.ts `markAttended`/`rosterFor` are `staffProcedure`
// (admin OR trainer) with no ownership check against classes.trainerId.
describe("SEC-003 / CURRENT BEHAVIOR: trainers are not scoped to their own classes", () => {
  const t = useTestDatabase();

  it("a trainer who does not teach the class can still view its roster and check members in", async () => {
    const teachingTrainer = await createTrainer(t.db);
    const otherTrainer = await createTrainer(t.db);
    const cls = await createClass(t.db, { trainerId: teachingTrainer.id, capacity: 5 });

    const member = await createMember(t.db);
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const booking = await callerAs(t.db, member).bookings.book({ classId: cls.id });

    // otherTrainer does not teach `cls` (trainerId points at teachingTrainer)
    await expect(callerAs(t.db, otherTrainer).bookings.rosterFor({ classId: cls.id })).resolves.toHaveLength(1);
    await expect(
      callerAs(t.db, otherTrainer).bookings.markAttended({ bookingId: booking.id }),
    ).resolves.toMatchObject({ ok: true });
  });
});
