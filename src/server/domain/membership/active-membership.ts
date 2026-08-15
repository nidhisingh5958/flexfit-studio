import { and, desc, eq, sql } from "drizzle-orm";
import { memberships } from "@/db/schema";

/**
 * The membership currently usable for booking: status='active' AND
 * endDate >= today, ordered by furthest endDate first. If a user has more
 * than one row matching that filter, this returns exactly one of them
 * (the one with the furthest endDate) — it does not flag or prevent that
 * situation. That selection behavior is preserved exactly as it existed
 * before this extraction.
 */
export async function activeMembershipFor(
  db: typeof import("@/db").db,
  userId: number,
) {
  const today = new Date().toISOString().slice(0, 10);
  return db
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.status, "active"),
        sql`${memberships.endDate} >= ${today}`,
      ),
    )
    .orderBy(desc(memberships.endDate))
    .get();
}
