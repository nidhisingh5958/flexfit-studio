import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { notifications } from "@/db/schema";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createTrainer,
  createAdmin,
  createClass,
  createActiveMembership,
} from "../helpers";

// HIGH GAP 2: notifications router. Source: src/server/routers/notifications.ts.
describe("notifications.unreadCount", () => {
  const t = useTestDatabase();

  it("is 0 when there are no notifications", async () => {
    const member = await createMember(t.db);
    await expect(callerAs(t.db, member).notifications.unreadCount()).resolves.toBe(0);
  });

  it("counts only this user's unread notifications, ignoring read ones and other users'", async () => {
    const member = await createMember(t.db);
    const other = await createMember(t.db);

    await t.db.insert(notifications).values([
      { userId: member.id, type: "announcement", title: "A", message: "a", read: false },
      { userId: member.id, type: "announcement", title: "B", message: "b", read: false },
      { userId: member.id, type: "announcement", title: "C", message: "c", read: true },
      { userId: other.id, type: "announcement", title: "D", message: "d", read: false },
    ]);

    await expect(callerAs(t.db, member).notifications.unreadCount()).resolves.toBe(2);
  });

  it("requires sign-in", async () => {
    await expect(callerAs(t.db, null).notifications.unreadCount()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Sign in required.",
    });
  });
});

describe("notifications.list", () => {
  const t = useTestDatabase();

  it("returns only the caller's own notifications", async () => {
    const member = await createMember(t.db);
    const other = await createMember(t.db);

    await t.db.insert(notifications).values([
      { userId: member.id, type: "announcement", title: "Mine", message: "m" },
      { userId: other.id, type: "announcement", title: "Not mine", message: "n" },
    ]);

    const list = await callerAs(t.db, member).notifications.list({});
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("Mine");
  });

  it("requires sign-in", async () => {
    await expect(callerAs(t.db, null).notifications.list({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Sign in required.",
    });
  });
});

describe("notifications.markAllAsRead", () => {
  const t = useTestDatabase();

  it("marks all of the caller's unread notifications as read, and does not touch other users' notifications", async () => {
    const member = await createMember(t.db);
    const other = await createMember(t.db);

    await t.db.insert(notifications).values([
      { userId: member.id, type: "announcement", title: "A", message: "a", read: false },
      { userId: member.id, type: "announcement", title: "B", message: "b", read: false },
      { userId: other.id, type: "announcement", title: "C", message: "c", read: false },
    ]);

    const result = await callerAs(t.db, member).notifications.markAllAsRead();
    expect(result.ok).toBe(true);

    const mineAfter = await t.db.select().from(notifications).where(eq(notifications.userId, member.id));
    expect(mineAfter.every((n) => n.read === true)).toBe(true);

    const othersAfter = await t.db.select().from(notifications).where(eq(notifications.userId, other.id));
    expect(othersAfter[0].read).toBe(false); // untouched
  });

  it("requires sign-in", async () => {
    await expect(callerAs(t.db, null).notifications.markAllAsRead()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Sign in required.",
    });
  });
});

describe("notifications.broadcast", () => {
  const t = useTestDatabase();

  it("creates an 'announcement' notification for every user with role='member', and none for trainers/admins", async () => {
    const admin = await createAdmin(t.db);
    const memberA = await createMember(t.db);
    const memberB = await createMember(t.db);
    const trainer = await createTrainer(t.db);

    const result = await callerAs(t.db, admin).notifications.broadcast({
      title: "Studio closed",
      message: "Closed for maintenance on Sunday.",
    });

    expect(result).toEqual({ ok: true, count: 2 });

    const memberARows = await t.db.select().from(notifications).where(eq(notifications.userId, memberA.id));
    const memberBRows = await t.db.select().from(notifications).where(eq(notifications.userId, memberB.id));
    const trainerRows = await t.db.select().from(notifications).where(eq(notifications.userId, trainer.id));
    const adminRows = await t.db.select().from(notifications).where(eq(notifications.userId, admin.id));

    expect(memberARows).toHaveLength(1);
    expect(memberARows[0].type).toBe("announcement");
    expect(memberARows[0].title).toBe("Studio closed");
    expect(memberBRows).toHaveLength(1);
    expect(trainerRows).toHaveLength(0); // CURRENT BEHAVIOR: broadcast only targets role='member'
    expect(adminRows).toHaveLength(0);
  });

  it("returns count:0 and does not error when there are no members", async () => {
    const admin = await createAdmin(t.db);
    const result = await callerAs(t.db, admin).notifications.broadcast({ title: "X", message: "Y" });
    expect(result).toEqual({ ok: true, count: 0 });
  });

  it("requires admin, not just staff", async () => {
    const trainer = await createTrainer(t.db);
    await expect(
      callerAs(t.db, trainer).notifications.broadcast({ title: "X", message: "Y" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "Admins only." });
  });
});

// BUG-005 connection: from the notifications router's own API surface (not
// a raw DB query), confirm that an affected member sees no new notification
// after their class is cancelled by an admin. Source: src/server/routers/
// classes.ts `cancel` never inserts into `notifications`, despite the
// schema defining a `class_cancelled` type specifically for this.
describe("BUG-005 (notifications angle): admin class cancellation never produces a notification", () => {
  const t = useTestDatabase();

  it("CURRENT BEHAVIOR: an affected member's notifications.list/unreadCount are unchanged after their class is cancelled", async () => {
    const admin = await createAdmin(t.db);
    const member = await createMember(t.db);
    await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const cls = await createClass(t.db, { capacity: 5 });
    const memberCaller = callerAs(t.db, member);
    await memberCaller.bookings.book({ classId: cls.id });

    const unreadBefore = await memberCaller.notifications.unreadCount();
    const listBefore = await memberCaller.notifications.list({});

    await callerAs(t.db, admin).classes.cancel({ id: cls.id });

    const unreadAfter = await memberCaller.notifications.unreadCount();
    const listAfter = await memberCaller.notifications.list({});

    expect(unreadAfter).toBe(unreadBefore);
    expect(listAfter).toHaveLength(listBefore.length);
    expect(listAfter.some((n) => n.type === "class_cancelled")).toBe(false);
  });
});
