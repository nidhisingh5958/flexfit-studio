import { describe, it, expect } from "vitest";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createClass,
  createActiveMembership,
  createCompany,
  linkMemberToCompany,
  fillClassToCapacity,
} from "../helpers";

// BUG-001 and BUG-002: individual and corporate bookings are counted and
// deduplicated against two separate tables. Source: the `isFull` count in
// src/server/routers/bookings.ts `book` (queries `bookings` only) vs.
// src/server/routers/corporate-bookings.ts `book` (queries `corporateBookings`
// only), and the "already on the list" check in each (same scoping).
describe("BUG-001: class capacity is not shared between individual and corporate bookings", () => {
  const t = useTestDatabase();

  it("CURRENT BEHAVIOR: a corporate booking succeeds as status=booked even after the class is already full via individual bookings", async () => {
    const cls = await createClass(t.db, { capacity: 2, creditCost: 1 });
    await fillClassToCapacity(t.db, cls); // 2 individual "booked" rows, class is at capacity

    const corporateMember = await createMember(t.db);
    const company = await createCompany(t.db, { creditPoolBalance: 20 });
    await linkMemberToCompany(t.db, corporateMember.id, company.id);

    const corporateBooking = await callerAs(t.db, corporateMember).corporateBookings.book({ classId: cls.id });

    // A room with capacity 2 now has 3 people holding a confirmed seat.
    expect(corporateBooking.status).toBe("booked");
  });

  it("CURRENT BEHAVIOR: an individual booking succeeds as status=booked even after the class is already full via corporate bookings", async () => {
    const cls = await createClass(t.db, { capacity: 1, creditCost: 1 });
    const company = await createCompany(t.db, { creditPoolBalance: 20 });
    const corporateMember = await createMember(t.db);
    await linkMemberToCompany(t.db, corporateMember.id, company.id);
    await callerAs(t.db, corporateMember).corporateBookings.book({ classId: cls.id }); // fills the only seat, corporate-side

    const individualMember = await createMember(t.db);
    await createActiveMembership(t.db, individualMember.id, { creditsRemaining: 10 });
    const individualBooking = await callerAs(t.db, individualMember).bookings.book({ classId: cls.id });

    expect(individualBooking.status).toBe("booked"); // classes.list would also report this class as not full
  });

  it("CURRENT BEHAVIOR: classes.list's spotsLeft/full fields only reflect individual bookings, ignoring corporate seats already taken", async () => {
    const cls = await createClass(t.db, { capacity: 1, creditCost: 1 });
    const company = await createCompany(t.db, { creditPoolBalance: 20 });
    const corporateMember = await createMember(t.db);
    await linkMemberToCompany(t.db, corporateMember.id, company.id);
    await callerAs(t.db, corporateMember).corporateBookings.book({ classId: cls.id });

    const anyUser = await createMember(t.db);
    const list = await callerAs(t.db, anyUser).classes.list({});
    const row = list.find((c) => c.id === cls.id);

    expect(row?.full).toBe(false);
    expect(row?.spotsLeft).toBe(1); // the room is actually full
  });
});

describe("BUG-002: the same member can hold both an individual and a corporate booking for one class", () => {
  const t = useTestDatabase();

  it("CURRENT BEHAVIOR: booking individually does not block also booking corporately for the same class, and vice versa", async () => {
    const member = await createMember(t.db);
    const cls = await createClass(t.db, { capacity: 5, creditCost: 1 });
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const company = await createCompany(t.db, { creditPoolBalance: 20 });
    await linkMemberToCompany(t.db, member.id, company.id);

    const individualBooking = await callerAs(t.db, member).bookings.book({ classId: cls.id });
    const corporateBooking = await callerAs(t.db, member).corporateBookings.book({ classId: cls.id });

    expect(individualBooking.status).toBe("booked");
    expect(corporateBooking.status).toBe("booked");

    // Both are simultaneously active for the same user + class, one
    // debiting the member's personal credits and one debiting the
    // company's pool — neither "already on the list" check sees the other.
    const mine = await callerAs(t.db, member).bookings.mine({});
    const corporateMine = await callerAs(t.db, member).corporateBookings.mine({});
    expect(mine.some((b) => b.classId === cls.id)).toBe(true);
    expect(corporateMine.some((b) => b.classId === cls.id)).toBe(true);
  });
});
