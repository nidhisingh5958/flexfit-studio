import { describe, it, expect } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { bookings } from "@/db/schema";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createClass,
  createActiveMembership,
} from "../helpers";
import { openSecondConnection } from "../helpers/db";

// DATA-003: no database uniqueness constraint backs the "already on the
// list for this class" rule — it's purely an application-level SELECT
// before the INSERT (src/server/routers/bookings.ts `book`, lines 92-109),
// with no transaction or unique index enforcing it. Two concurrent book()
// calls by the SAME user for the SAME class both pass the "existing"
// check before either has inserted. Reproduced deterministically across
// repeated local trials.
describe("DATA-003: two concurrent booking attempts by the same user for the same class", () => {
  const t = useTestDatabase();

  it("CURRENT BEHAVIOR: both requests succeed, producing two active booking rows for one user on one class (the CONFLICT check is bypassed by the race)", async () => {
    const cls = await createClass(t.db, { capacity: 5 }); // ample capacity — isolates the duplicate-check race from the capacity race
    const member = await createMember(t.db);
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });

    const conn2 = openSecondConnection(t.raw);
    try {
      const callerA = callerAs(t.db, member);
      const callerB = callerAs(conn2.db, member);

      const [resultA, resultB] = await Promise.allSettled([
        callerA.bookings.book({ classId: cls.id }),
        callerB.bookings.book({ classId: cls.id }),
      ]);

      expect(resultA.status).toBe("fulfilled");
      expect(resultB.status).toBe("fulfilled");

      const activeRows = await t.db
        .select()
        .from(bookings)
        .where(
          and(
            eq(bookings.classId, cls.id),
            eq(bookings.userId, member.id),
            inArray(bookings.status, ["booked", "waitlisted"]),
          ),
        );
      // The single-request CONFLICT check (bookings.ts lines 104-109) never
      // fires here, because both requests read "no existing booking" before
      // either had written one.
      expect(activeRows).toHaveLength(2);
    } finally {
      conn2.client.close();
    }
  });
});
