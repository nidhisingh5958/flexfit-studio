import { and, asc, eq } from "drizzle-orm";
import { bookings, corporateBookings, type Booking, type CorporateBooking } from "@/db/schema";

// Two small, independent, explicitly-typed wrappers rather than one
// table-parameterized function: unlike countActiveBookings (which only
// returns a plain number), this query returns the full row, and
// `bookings`/`corporateBookings` have different columns
// (membershipId vs. companyId). A single function taking a union of the
// two tables loses that per-table column information from its return
// type (confirmed via a failing tsc check), which would force an unsafe
// cast at the call site. Two small wrappers keep every return type exact
// with no cast — the smaller, safer option per the approved plan's own
// guidance for this situation.
//
// Both only locate the oldest ("first come, first served") waitlisted
// candidate for a class. Neither changes status, deducts credits, debits
// a pool, looks up the membership/company, or performs any other part of
// promotion — that stays in each caller exactly as before (see DUP-005).

export async function findOldestWaitlistedBooking(
  db: typeof import("@/db").db,
  classId: number,
): Promise<Booking | undefined> {
  return db
    .select()
    .from(bookings)
    .where(and(eq(bookings.classId, classId), eq(bookings.status, "waitlisted")))
    .orderBy(asc(bookings.bookedAt))
    .get();
}

export async function findOldestWaitlistedCorporateBooking(
  db: typeof import("@/db").db,
  classId: number,
): Promise<CorporateBooking | undefined> {
  return db
    .select()
    .from(corporateBookings)
    .where(and(eq(corporateBookings.classId, classId), eq(corporateBookings.status, "waitlisted")))
    .orderBy(asc(corporateBookings.bookedAt))
    .get();
}
