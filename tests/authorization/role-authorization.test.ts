import { describe, it, expect } from "vitest";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createTrainer,
  createAdmin,
} from "../helpers";

// Flow 15 (authorization) — the three tRPC middleware tiers. Source:
// src/server/trpc.ts `protectedProcedure` / `staffProcedure` / `adminProcedure`.
describe("protectedProcedure / staffProcedure / adminProcedure boundaries", () => {
  const t = useTestDatabase();

  it('protectedProcedure: anonymous caller gets UNAUTHORIZED "Sign in required."', async () => {
    await expect(callerAs(t.db, null).members.profile()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Sign in required.",
    });
  });

  it('staffProcedure: a member gets FORBIDDEN "Staff only."', async () => {
    const member = await createMember(t.db);
    await expect(callerAs(t.db, member).members.search({ q: "" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Staff only.",
    });
  });

  it("staffProcedure: both admin and trainer pass", async () => {
    const admin = await createAdmin(t.db);
    const trainer = await createTrainer(t.db);
    await expect(callerAs(t.db, admin).members.search({ q: "" })).resolves.toBeDefined();
    await expect(callerAs(t.db, trainer).members.search({ q: "" })).resolves.toBeDefined();
  });

  it('adminProcedure: a trainer (staff, but not admin) gets FORBIDDEN "Admins only."', async () => {
    const trainer = await createTrainer(t.db);
    await expect(callerAs(t.db, trainer).admin.stats()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Admins only.",
    });
  });
});

// trainers.ts hand-rolls its own role check on every procedure (ARCH-004)
// instead of a dedicated trainerProcedure — these tests pin the exact
// wording ("Only trainers can access this.") so a future consolidation
// doesn't silently change it.
describe("trainers.ts — per-procedure role checks", () => {
  const t = useTestDatabase();

  it.each([
    ["upcomingClasses", (c: ReturnType<typeof callerAs>) => c.trainers.upcomingClasses()],
    ["availability", (c: ReturnType<typeof callerAs>) => c.trainers.availability()],
    ["setAvailability", (c: ReturnType<typeof callerAs>) => c.trainers.setAvailability({ dayOfWeek: 1, startTime: "09:00", endTime: "17:00" })],
    ["removeAvailability", (c: ReturnType<typeof callerAs>) => c.trainers.removeAvailability({ dayOfWeek: 1 })],
  ])('%s rejects a member with FORBIDDEN "Only trainers can access this."', async (_name, call) => {
    const member = await createMember(t.db);
    await expect(call(callerAs(t.db, member))).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Only trainers can access this.",
    });
  });

  it('checkAvailability uses a DIFFERENT message ("Staff only.") and a different allowed set (trainer OR admin, not just trainer)', async () => {
    const member = await createMember(t.db);
    await expect(
      callerAs(t.db, member).trainers.checkAvailability({ trainerId: 1, startsAt: new Date().toISOString(), durationMin: 60 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "Staff only." });

    const admin = await createAdmin(t.db);
    const trainer = await createTrainer(t.db);
    // Admins are allowed here even though they're rejected by the other four trainer-only procedures.
    await expect(
      callerAs(t.db, admin).trainers.checkAvailability({ trainerId: trainer.id, startsAt: new Date().toISOString(), durationMin: 60 }),
    ).resolves.toBeDefined();
  });

  it("a trainer can set, read, and remove their own availability", async () => {
    const trainer = await createTrainer(t.db);
    const caller = callerAs(t.db, trainer);

    const created = await caller.trainers.setAvailability({ dayOfWeek: 2, startTime: "08:00", endTime: "16:00" });
    expect(created.dayOfWeek).toBe(2);

    const list = await caller.trainers.availability();
    expect(list).toHaveLength(1);

    await caller.trainers.removeAvailability({ dayOfWeek: 2 });
    expect(await caller.trainers.availability()).toHaveLength(0);
  });
});
