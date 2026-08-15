import { and, eq, gte, sql } from "drizzle-orm";
import { users, memberships, classes, bookings, payments, checkins } from "@/db/schema";

// Consumed by src/app/admin/page.tsx. Query bodies moved verbatim from the
// original admin.ts — no condition, join, aggregation, or returned field
// was changed.

export async function getAdminStats(db: typeof import("@/db").db) {
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const [{ totalMembers }] = await db
    .select({ totalMembers: sql<number>`count(*)` })
    .from(users)
    .where(eq(users.role, "member"));

  const [{ activeMemberships }] = await db
    .select({ activeMemberships: sql<number>`count(*)` })
    .from(memberships)
    .where(
      and(
        eq(memberships.status, "active"),
        sql`${memberships.endDate} >= ${today}`,
      ),
    );

  const [{ upcomingClasses }] = await db
    .select({ upcomingClasses: sql<number>`count(*)` })
    .from(classes)
    .where(and(gte(classes.startsAt, now), eq(classes.cancelled, false)));

  const [{ revenueCents }] = await db
    .select({ revenueCents: sql<number>`coalesce(sum(amount_cents), 0)` })
    .from(payments)
    .where(eq(payments.status, "paid"));

  const [{ totalCheckins }] = await db
    .select({ totalCheckins: sql<number>`count(*)` })
    .from(checkins);

  const [{ pendingPayments }] = await db
    .select({ pendingPayments: sql<number>`count(*)` })
    .from(payments)
    .where(eq(payments.status, "pending"));

  return {
    totalMembers: Number(totalMembers),
    activeMemberships: Number(activeMemberships),
    upcomingClasses: Number(upcomingClasses),
    revenueCents: Number(revenueCents),
    totalCheckins: Number(totalCheckins),
    pendingPayments: Number(pendingPayments),
  };
}

export async function getClassUtilisation(db: typeof import("@/db").db, limit: number) {
  const rows = await db
    .select({
      id: classes.id,
      name: classes.name,
      startsAt: classes.startsAt,
      capacity: classes.capacity,
      booked: sql<number>`(
        select count(*) from ${bookings}
        where ${bookings.classId} = ${classes.id}
          and ${bookings.status} in ('booked','attended')
      )`.as("booked"),
    })
    .from(classes)
    .where(eq(classes.cancelled, false))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    booked: Number(r.booked),
    utilisation: r.capacity ? Number(r.booked) / r.capacity : 0,
  }));
}
