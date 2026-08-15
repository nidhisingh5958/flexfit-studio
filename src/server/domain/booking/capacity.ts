import { and, eq, sql } from "drizzle-orm";
import { bookings, corporateBookings } from "@/db/schema";

/**
 * Counts how many rows in the given table currently hold a confirmed
 * ("booked") seat for a class.
 *
 * Table-parameterized, but deliberately NOT cross-table: each caller
 * passes exactly one of `bookings` or `corporateBookings`, hardcoded at
 * the call site — this function never combines the two, and the table
 * argument is a narrow union of exactly those two tables, not a generic
 * "any table" parameter. Per audit finding BUG-001, individual and
 * corporate bookings are deliberately counted against separate tables
 * with no shared capacity pool; this extraction removes the duplicated
 * query shape without changing which table each caller counts, or
 * combining the two counts in any way.
 */
export async function countActiveBookings(
  db: typeof import("@/db").db,
  table: typeof bookings | typeof corporateBookings,
  classId: number,
): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(table)
    .where(and(eq(table.classId, classId), eq(table.status, "booked")));
  return Number(count);
}
