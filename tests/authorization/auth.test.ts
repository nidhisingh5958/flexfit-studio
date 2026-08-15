import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { sessions, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { useTestDatabase, callerAs, createMember } from "../helpers";

// Flow 15 (authentication). Source: src/server/routers/auth.ts.
describe("auth.login", () => {
  const t = useTestDatabase();

  it("succeeds with the correct email/password and returns id, name, role", async () => {
    const member = await createMember(t.db, {
      email: "login-test@test.local",
      passwordHash: hashPassword("correct-horse"),
      name: "Login Test",
    });
    const result = await callerAs(t.db, null).auth.login({ email: "login-test@test.local", password: "correct-horse" });
    expect(result).toEqual({ id: member.id, name: "Login Test", role: "member" });
  });

  it("lowercases the email before matching (login is case-insensitive on email)", async () => {
    // Note: zod's `.email()` validator rejects leading/trailing whitespace
    // before the handler's own `.trim()` ever runs, so only case-folding is
    // actually reachable through this input — `.trim()` guards a case zod
    // input validation already forecloses.
    await createMember(t.db, {
      email: "case.test@test.local",
      passwordHash: hashPassword("pw"),
    });
    await expect(
      callerAs(t.db, null).auth.login({ email: "Case.Test@Test.Local", password: "pw" }),
    ).resolves.toMatchObject({ role: "member" });
  });

  it('rejects an unknown email with UNAUTHORIZED "Email or password is incorrect."', async () => {
    await expect(
      callerAs(t.db, null).auth.login({ email: "nobody@test.local", password: "whatever" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "Email or password is incorrect." });
  });

  it('rejects a wrong password with the identical UNAUTHORIZED message (no distinct "wrong password" leak)', async () => {
    await createMember(t.db, { email: "wrongpw@test.local", passwordHash: hashPassword("right") });
    await expect(
      callerAs(t.db, null).auth.login({ email: "wrongpw@test.local", password: "wrong" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "Email or password is incorrect." });
  });

  it('rejects a deactivated account with FORBIDDEN "This account has been deactivated." even with the right password', async () => {
    await createMember(t.db, { email: "deactivated@test.local", passwordHash: hashPassword("pw"), active: false });
    await expect(
      callerAs(t.db, null).auth.login({ email: "deactivated@test.local", password: "pw" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "This account has been deactivated." });
  });

  it("creates a sessions row on successful login", async () => {
    await createMember(t.db, { email: "session-check@test.local", passwordHash: hashPassword("pw") });
    await callerAs(t.db, null).auth.login({ email: "session-check@test.local", password: "pw" });
    const rows = await t.db.select().from(sessions);
    expect(rows).toHaveLength(1);
  });
});

describe("auth.register", () => {
  const t = useTestDatabase();

  it("creates a member-role account regardless of any other role hint", async () => {
    const result = await callerAs(t.db, null).auth.register({
      email: "new.signup@test.local",
      password: "password123",
      name: "New Signup",
    });
    const row = await t.db.select().from(users).where(eq(users.id, result.id)).get();
    expect(row?.role).toBe("member"); // SEC-007: role is always forced server-side
  });

  it('rejects a duplicate email with CONFLICT "An account with that email already exists."', async () => {
    await createMember(t.db, { email: "dupe@test.local" });
    await expect(
      callerAs(t.db, null).auth.register({ email: "dupe@test.local", password: "password123", name: "Someone" }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "An account with that email already exists." });
  });

  it("rejects a password shorter than 6 characters with BAD_REQUEST (zod validation)", async () => {
    await expect(
      callerAs(t.db, null).auth.register({ email: "shortpw@test.local", password: "abc", name: "X" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("auth.me / auth.logout", () => {
  const t = useTestDatabase();

  it("auth.me returns null when signed out", async () => {
    await expect(callerAs(t.db, null).auth.me()).resolves.toBeNull();
  });

  it("auth.me returns the current user object when signed in", async () => {
    const member = await createMember(t.db);
    const me = await callerAs(t.db, member).auth.me();
    expect(me?.id).toBe(member.id);
  });

  it("auth.logout requires sign-in", async () => {
    await expect(callerAs(t.db, null).auth.logout()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Sign in required.",
    });
  });

  it("auth.logout deletes the session row matching ctx.token", async () => {
    const member = await createMember(t.db);
    await t.db.insert(sessions).values({
      userId: member.id,
      token: "test-token",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    await callerAs(t.db, member, "test-token").auth.logout();

    const remaining = await t.db.select().from(sessions).where(eq(sessions.token, "test-token"));
    expect(remaining).toHaveLength(0);
  });
});
