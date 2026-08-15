import { and, eq, gte, lte, sql } from "drizzle-orm";
import { payments, memberships, users, membershipPlans } from "@/db/schema";

// Consumed by src/app/admin/reports/page.tsx. Query bodies moved verbatim
// from the original admin.ts — no condition, join, aggregation, ordering,
// or returned field was changed.

export async function getRevenueByMonth(db: typeof import("@/db").db) {
  const rows = await db
    .select({
      month: sql<string>`strftime('%Y-%m', ${payments.createdAt})`,
      totalCents: sql<number>`coalesce(sum(${payments.amountCents}), 0)`,
    })
    .from(payments)
    .where(eq(payments.status, "paid"))
    .groupBy(sql`strftime('%Y-%m', ${payments.createdAt})`)
    .orderBy(sql`strftime('%Y-%m', ${payments.createdAt}) DESC`);

  return rows.map((r) => ({
    month: r.month,
    totalCents: Number(r.totalCents),
  }));
}

export async function getRevenueByMethod(db: typeof import("@/db").db) {
  const rows = await db
    .select({
      method: payments.method,
      totalCents: sql<number>`coalesce(sum(${payments.amountCents}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(payments)
    .where(eq(payments.status, "paid"))
    .groupBy(payments.method)
    .orderBy(sql`sum(${payments.amountCents}) DESC`);

  return rows.map((r) => ({
    method: r.method,
    totalCents: Number(r.totalCents),
    count: Number(r.count),
  }));
}

export async function getExpiringMemberships(db: typeof import("@/db").db) {
  const today = new Date().toISOString().slice(0, 10);
  const in14Days = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const rows = await db
    .select({
      memberId: users.id,
      memberName: users.name,
      memberEmail: users.email,
      planName: membershipPlans.name,
      expiresAt: memberships.endDate,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .innerJoin(membershipPlans, eq(memberships.planId, membershipPlans.id))
    .where(
      and(
        eq(memberships.status, "active"),
        gte(memberships.endDate, today),
        lte(memberships.endDate, in14Days),
      ),
    )
    .orderBy(memberships.endDate);

  return rows;
}

export async function getRefundCount(db: typeof import("@/db").db) {
  const [result] = await db
    .select({ count: sql<number>`count(*)` })
    .from(payments)
    .where(eq(payments.status, "refunded"));

  return { count: Number(result.count) };
}
