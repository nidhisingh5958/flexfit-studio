import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { bookings } from "@/db/schema";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createClass,
  createActiveMembership,
} from "../helpers";
import { openSecondConnection } from "../helpers/db";

// DATA-001: booking capacity is a read-then-write race. Source:
// src/server/routers/bookings.ts `book` — the `count(status='booked')`
// select and the subsequent insert are two separate statements with no
// transaction around them (see audit ARCH-005).
//
// Two genuinely independent connections (mirroring two concurrent HTTP
// requests, each of which gets its own `db` from createContext in
// production) race to book the last seat of a capacity-1 class.
// Reproduced deterministically across repeated local trials — not a rare
// or flaky window on this driver/OS combination.
describe("DATA-001: two concurrent bookings for the last seat", () => {
  const t = useTestDatabase();

  it("CURRENT BEHAVIOR: both requests can succeed, overbooking a capacity-1 class to 2 confirmed bookings", async () => {
    const cls = await createClass(t.db, { capacity: 1 });
    const memberA = await createMember(t.db);
    const memberB = await createMember(t.db);
    await createActiveMembership(t.db, memberA.id, { creditsRemaining: 10 });
    await createActiveMembership(t.db, memberB.id, { creditsRemaining: 10 });

    // A second, independent connection against the SAME underlying file.
    const conn2 = openSecondConnection(t.raw);
    try {
      const callerA = callerAs(t.db, memberA);
      const callerB = callerAs(conn2.db, memberB);

      const [resultA, resultB] = await Promise.allSettled([
        callerA.bookings.book({ classId: cls.id }),
        callerB.bookings.book({ classId: cls.id }),
      ]);

      expect(resultA.status).toBe("fulfilled");
      expect(resultB.status).toBe("fulfilled");
      if (resultA.status === "fulfilled") expect(resultA.value.status).toBe("booked");
      if (resultB.status === "fulfilled") expect(resultB.value.status).toBe("booked");

      // Ground truth: how many "booked" rows actually exist for a class
      // whose capacity is 1.
      const bookedRows = await t.db
        .select()
        .from(bookings)
        .where(and(eq(bookings.classId, cls.id), eq(bookings.status, "booked")));
      expect(bookedRows).toHaveLength(2); // capacity=1, but 2 confirmed bookings exist
    } finally {
      conn2.client.close();
    }
  });
});
