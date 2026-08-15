import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { memberships, payments } from "@/db/schema";
import { useTestDatabase, callerAs, createMember, createPlan, createClass } from "../helpers";

// BUG-010 (real characterization): does the actual `plans.subscribe`
// production mutation allow a member to end up with more than one
// simultaneous active membership? Source: src/server/routers/plans.ts
// `subscribe` (lines 21-70) — it looks up the plan, checks the plan is
// active, then unconditionally inserts a new `memberships` row and a
// `payments` row. There is no query anywhere in this mutation that checks
// for an existing active membership before creating another one.
//
// This test calls `plans.subscribe` twice, for real, through the actual
// tRPC procedure — not via the test factories — and inspects the database
// afterward. Per the Phase 2B instructions: do not add a uniqueness guard,
// do not fix BUG-010. If current behavior allows duplicate active
// memberships, this test documents that by passing.
describe("BUG-010 / CURRENT BEHAVIOR: plans.subscribe called twice for the same member", () => {
  const t = useTestDatabase();

  it("creates two separate, simultaneously-active membership rows — the second call is never blocked by the first", async () => {
    const member = await createMember(t.db);
    const plan = await createPlan(t.db, {
      name: "Monthly Unlimited",
      priceCents: 450000,
      durationDays: 30,
      classCredits: 999,
    });
    const caller = callerAs(t.db, member);

    // 1. First subscription.
    const firstResult = await caller.plans.subscribe({ planId: plan.id, method: "card" });
    expect(firstResult.status).toBe("active");
    expect(firstResult.userId).toBe(member.id);
    expect(firstResult.planId).toBe(plan.id);

    // 2. Second subscription to the SAME plan, same member, no cancellation
    //    or lapse of the first membership in between.
    const secondResult = await caller.plans.subscribe({ planId: plan.id, method: "upi" });
    expect(secondResult.status).toBe("active");

    // CURRENT BEHAVIOR: the second call is not rejected — it's a distinct
    // row, not an update to the first.
    expect(secondResult.id).not.toBe(firstResult.id);

    // 3. Inspect the database directly: how many membership rows now exist
    //    for this member, and what are their statuses?
    const allMemberships = await t.db.select().from(memberships).where(eq(memberships.userId, member.id));
    expect(allMemberships).toHaveLength(2);
    expect(allMemberships.filter((m) => m.status === "active")).toHaveLength(2);

    // CURRENT BEHAVIOR: the production mutation allows two simultaneously
    // active memberships for one member — nothing in plans.subscribe
    // queries for or blocks against an existing active membership.
  });

  it("also creates a separate `paid` payment row for each call — subscribing twice pays (and records) twice", async () => {
    const member = await createMember(t.db);
    const plan = await createPlan(t.db, { priceCents: 300000 });
    const caller = callerAs(t.db, member);

    await caller.plans.subscribe({ planId: plan.id, method: "card" });
    await caller.plans.subscribe({ planId: plan.id, method: "cash" });

    const allPayments = await t.db.select().from(payments).where(eq(payments.userId, member.id));
    expect(allPayments).toHaveLength(2);
    expect(allPayments.every((p) => p.status === "paid")).toBe(true);
    expect(allPayments.map((p) => p.amountCents)).toEqual([300000, 300000]);
  });

  it("the resulting duplicate-membership state feeds directly into activeMembershipFor's furthest-endDate selection", async () => {
    // Ties this real end-to-end reproduction back to the selection
    // behavior already characterized in membership-selection.test.ts,
    // proving the two are the same bug reached two different ways.
    const member = await createMember(t.db);
    const shorterPlan = await createPlan(t.db, { durationDays: 10, classCredits: 5 });
    const longerPlan = await createPlan(t.db, { durationDays: 60, classCredits: 1 });
    const caller = callerAs(t.db, member);

    await caller.plans.subscribe({ planId: shorterPlan.id });
    const secondMembership = await caller.plans.subscribe({ planId: longerPlan.id });

    const testClass = await createClass(t.db, { creditCost: 1 });
    const booking = await caller.bookings.book({ classId: testClass.id });

    // activeMembershipFor picks the membership with the furthest endDate —
    // here, that's unambiguously the second (longer-duration) one.
    expect(booking.membershipId).toBe(secondMembership.id);
  });
});
