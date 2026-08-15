import { eq } from "drizzle-orm";
import {
  users,
  membershipPlans,
  memberships,
  classes,
  bookings,
  companies,
  companyMembers,
  corporateBookings,
  checkins,
  payments,
  type User,
  type MembershipPlan,
  type Membership,
  type GymClass,
  type Booking,
  type Company,
  type CorporateBooking,
} from "@/db/schema";
import { hashPassword } from "@/lib/password";
import type { TestDb } from "./db";

// ---------------------------------------------------------------------------
// Time helpers — mirror the ISO-string convention used throughout the app
// (classes.startsAt, memberships.endDate, etc. are all stored as strings).
// ---------------------------------------------------------------------------

export function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 60 * 60 * 1000).toISOString();
}

export function daysFromNowDateOnly(d: number): string {
  const dt = new Date(Date.now() + d * 24 * 60 * 60 * 1000);
  return dt.toISOString().slice(0, 10);
}

export function todayDateOnly(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

let emailCounter = 0;
function uniqueEmail(prefix: string): string {
  emailCounter += 1;
  return `${prefix}${emailCounter}@test.local`;
}

export async function createUser(
  db: TestDb,
  overrides: Partial<typeof users.$inferInsert> = {},
): Promise<User> {
  return db
    .insert(users)
    .values({
      email: overrides.email ?? uniqueEmail("member"),
      passwordHash: overrides.passwordHash ?? hashPassword("password123"),
      name: overrides.name ?? "Test Member",
      phone: overrides.phone,
      role: overrides.role ?? "member",
      active: overrides.active ?? true,
    })
    .returning()
    .get();
}

export function createMember(db: TestDb, overrides: Partial<typeof users.$inferInsert> = {}) {
  return createUser(db, { role: "member", ...overrides });
}

export function createTrainer(db: TestDb, overrides: Partial<typeof users.$inferInsert> = {}) {
  return createUser(db, { role: "trainer", name: "Test Trainer", email: uniqueEmail("trainer"), ...overrides });
}

export function createAdmin(db: TestDb, overrides: Partial<typeof users.$inferInsert> = {}) {
  return createUser(db, { role: "admin", name: "Test Admin", email: uniqueEmail("admin"), ...overrides });
}

// ---------------------------------------------------------------------------
// Membership plans & memberships
// ---------------------------------------------------------------------------

export async function createPlan(
  db: TestDb,
  overrides: Partial<typeof membershipPlans.$inferInsert> = {},
): Promise<MembershipPlan> {
  return db
    .insert(membershipPlans)
    .values({
      name: overrides.name ?? "Test Plan",
      description: overrides.description ?? null,
      priceCents: overrides.priceCents ?? 100000,
      durationDays: overrides.durationDays ?? 30,
      classCredits: overrides.classCredits ?? 10,
      active: overrides.active ?? true,
    })
    .returning()
    .get();
}

/** Active membership, valid today, with `creditsRemaining` credits, unless overridden. */
export async function createActiveMembership(
  db: TestDb,
  userId: number,
  overrides: Partial<typeof memberships.$inferInsert> & { planId?: number } = {},
): Promise<Membership> {
  let planId = overrides.planId;
  if (!planId) {
    const plan = await createPlan(db, { classCredits: overrides.creditsRemaining ?? 10 });
    planId = plan.id;
  }
  return db
    .insert(memberships)
    .values({
      userId,
      planId,
      startDate: overrides.startDate ?? daysFromNowDateOnly(-1),
      endDate: overrides.endDate ?? daysFromNowDateOnly(30),
      creditsRemaining: overrides.creditsRemaining ?? 10,
      status: overrides.status ?? "active",
    })
    .returning()
    .get();
}

export function createUnlimitedMembership(
  db: TestDb,
  userId: number,
  overrides: Partial<typeof memberships.$inferInsert> = {},
) {
  return createActiveMembership(db, userId, { creditsRemaining: 999, ...overrides });
}

/**
 * A membership whose date range has lapsed. Sets status="expired" AND an
 * endDate in the past — activeMembershipFor()'s filter
 * (status='active' AND endDate>=today) rejects this row on either count, so
 * this factory mirrors what real expiry looks like (see src/db/seed.ts,
 * which sets status this way based on the computed date range) rather than
 * relying on date range alone.
 */
export function createExpiredMembership(
  db: TestDb,
  userId: number,
  overrides: Partial<typeof memberships.$inferInsert> = {},
) {
  return createActiveMembership(db, userId, {
    startDate: daysFromNowDateOnly(-60),
    endDate: daysFromNowDateOnly(-1),
    status: "expired",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

let classCounter = 0;

export async function createClass(
  db: TestDb,
  overrides: Partial<typeof classes.$inferInsert> = {},
): Promise<GymClass> {
  classCounter += 1;
  return db
    .insert(classes)
    .values({
      name: overrides.name ?? `Test Class ${classCounter}`,
      description: overrides.description ?? null,
      trainerId: overrides.trainerId,
      room: overrides.room ?? "Studio A",
      capacity: overrides.capacity ?? 2,
      startsAt: overrides.startsAt ?? hoursFromNow(48),
      durationMin: overrides.durationMin ?? 60,
      creditCost: overrides.creditCost ?? 1,
      cancelled: overrides.cancelled ?? false,
    })
    .returning()
    .get();
}

// ---------------------------------------------------------------------------
// Raw booking rows — for seeding pre-existing state without going through
// the router (e.g. filling a class to capacity, or planting a booking with a
// specific status/creditsUsed to test what a mutation does to it).
// ---------------------------------------------------------------------------

export async function insertBooking(
  db: TestDb,
  overrides: Partial<typeof bookings.$inferInsert> & { classId: number; userId: number },
): Promise<Booking> {
  return db
    .insert(bookings)
    .values({
      classId: overrides.classId,
      userId: overrides.userId,
      membershipId: overrides.membershipId,
      status: overrides.status ?? "booked",
      creditsUsed: overrides.creditsUsed ?? 1,
      bookedAt: overrides.bookedAt,
      cancelledAt: overrides.cancelledAt,
    })
    .returning()
    .get();
}

/** Fills a class to capacity with distinct members holding "booked" rows. */
export async function fillClassToCapacity(
  db: TestDb,
  cls: GymClass,
  opts: { membershipCreditsEach?: number } = {},
): Promise<User[]> {
  const filledBy: User[] = [];
  for (let i = 0; i < cls.capacity; i++) {
    const member = await createMember(db);
    const ms = await createActiveMembership(db, member.id, {
      creditsRemaining: opts.membershipCreditsEach ?? 10,
    });
    await insertBooking(db, {
      classId: cls.id,
      userId: member.id,
      membershipId: ms.id,
      status: "booked",
      creditsUsed: cls.creditCost,
    });
    filledBy.push(member);
  }
  return filledBy;
}

export async function getBooking(db: TestDb, id: number): Promise<Booking | undefined> {
  return db.select().from(bookings).where(eq(bookings.id, id)).get();
}

export async function getMembership(db: TestDb, id: number): Promise<Membership | undefined> {
  return db.select().from(memberships).where(eq(memberships.id, id)).get();
}

// ---------------------------------------------------------------------------
// Corporate: companies, company members, corporate bookings
// ---------------------------------------------------------------------------

export async function createCompany(
  db: TestDb,
  overrides: Partial<typeof companies.$inferInsert> = {},
): Promise<Company> {
  return db
    .insert(companies)
    .values({
      name: overrides.name ?? "Test Co",
      contactEmail: overrides.contactEmail ?? uniqueEmail("hr"),
      creditPoolBalance: overrides.creditPoolBalance ?? 50,
      active: overrides.active ?? true,
    })
    .returning()
    .get();
}

export async function linkMemberToCompany(db: TestDb, userId: number, companyId: number) {
  return db.insert(companyMembers).values({ userId, companyId }).returning().get();
}

export async function insertCorporateBooking(
  db: TestDb,
  overrides: Partial<typeof corporateBookings.$inferInsert> & {
    classId: number;
    userId: number;
    companyId: number;
  },
): Promise<CorporateBooking> {
  return db
    .insert(corporateBookings)
    .values({
      classId: overrides.classId,
      userId: overrides.userId,
      companyId: overrides.companyId,
      status: overrides.status ?? "booked",
      creditsUsed: overrides.creditsUsed ?? 1,
      bookedAt: overrides.bookedAt,
      cancelledAt: overrides.cancelledAt,
    })
    .returning()
    .get();
}

export async function getCompany(db: TestDb, id: number): Promise<Company | undefined> {
  return db.select().from(companies).where(eq(companies.id, id)).get();
}

export async function getCorporateBooking(db: TestDb, id: number): Promise<CorporateBooking | undefined> {
  return db.select().from(corporateBookings).where(eq(corporateBookings.id, id)).get();
}

// ---------------------------------------------------------------------------
// Check-ins / payments (minimal helpers for check-in & refund flows)
// ---------------------------------------------------------------------------

export async function countCheckins(db: TestDb) {
  return db.select().from(checkins);
}

export async function createPayment(
  db: TestDb,
  overrides: Partial<typeof payments.$inferInsert> & { userId: number },
) {
  return db
    .insert(payments)
    .values({
      userId: overrides.userId,
      membershipId: overrides.membershipId,
      amountCents: overrides.amountCents ?? 100000,
      method: overrides.method ?? "card",
      status: overrides.status ?? "paid",
      reference: overrides.reference,
    })
    .returning()
    .get();
}
