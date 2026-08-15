import { and, eq, inArray, sql } from "drizzle-orm";
import { bookings, classes, users, checkins } from "@/db/schema";

// Consumed by src/app/admin/attendance/page.tsx. Query bodies moved
// verbatim from the original admin.ts — no condition, join, aggregation,
// ordering, or returned field was changed.

export async function getCheckinsPerDay(db: typeof import("@/db").db) {
  const start = new Date();
  start.setDate(start.getDate() - 14);
  const startStr = start.toISOString().slice(0, 10);

  const rows = await db
    .select({
      date: sql<string>`date(${checkins.checkedInAt})`,
      count: sql<number>`count(*)`,
    })
    .from(checkins)
    .where(sql`date(${checkins.checkedInAt}) >= ${startStr}`)
    .groupBy(sql`date(${checkins.checkedInAt})`)
    .orderBy(sql`date(${checkins.checkedInAt}) DESC`);

  return rows.map((r) => ({
    date: r.date,
    count: Number(r.count),
  }));
}

export async function getTopTrainers(db: typeof import("@/db").db) {
  const start = new Date();
  start.setDate(start.getDate() - 14);
  const startStr = start.toISOString().slice(0, 10);

  const rows = await db
    .select({
      trainerId: classes.trainerId,
      trainerName: users.name,
      classCount: sql<number>`count(distinct ${bookings.classId})`,
      attendedCount: sql<number>`count(${bookings.id})`,
    })
    .from(bookings)
    .innerJoin(classes, eq(bookings.classId, classes.id))
    .innerJoin(users, eq(classes.trainerId, users.id))
    .where(
      and(
        eq(bookings.status, "attended"),
        sql`date(${classes.startsAt}) >= ${startStr}`,
      ),
    )
    .groupBy(classes.trainerId, users.name)
    .orderBy(sql`count(${bookings.id}) DESC`)
    .limit(10);

  return rows.map((r) => ({
    trainerId: r.trainerId,
    trainerName: r.trainerName,
    classCount: Number(r.classCount),
    attendedCount: Number(r.attendedCount),
  }));
}

export async function getNoShowList(db: typeof import("@/db").db) {
  const start = new Date();
  start.setDate(start.getDate() - 14);
  const startStr = start.toISOString().slice(0, 10);

  const rows = await db
    .select({
      bookingId: bookings.id,
      memberId: users.id,
      memberName: users.name,
      memberEmail: users.email,
      className: classes.name,
      classDate: classes.startsAt,
      trainerId: classes.trainerId,
    })
    .from(bookings)
    .innerJoin(classes, eq(bookings.classId, classes.id))
    .innerJoin(users, eq(bookings.userId, users.id))
    .where(
      and(
        eq(bookings.status, "no_show"),
        sql`date(${classes.startsAt}) >= ${startStr}`,
      ),
    )
    .orderBy(sql`${classes.startsAt} DESC`);

  const trainerIds = [...new Set(rows.map((r) => r.trainerId).filter((id) => id != null))];
  const trainers = new Map<number | null, string>();

  if (trainerIds.length > 0) {
    const trainerRows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, trainerIds as number[]));

    trainerRows.forEach((t) => {
      trainers.set(t.id, t.name);
    });
  }

  return rows.map((r) => ({
    bookingId: r.bookingId,
    memberId: r.memberId,
    memberName: r.memberName,
    memberEmail: r.memberEmail,
    className: r.className,
    classDate: r.classDate,
    trainerId: r.trainerId,
    trainerName: r.trainerId ? trainers.get(r.trainerId) : undefined,
  }));
}
