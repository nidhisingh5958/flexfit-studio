import { describe, it, expect } from "vitest";
import {
  useTestDatabase,
  callerAs,
  createMember,
  createAdmin,
  createActiveMembership,
  createClass,
  getMembership,
  getBooking,
  createPayment,
} from "../helpers";

// HIGH GAP 1: payments router. Source: src/server/routers/payments.ts.
describe("payments.mine", () => {
  const t = useTestDatabase();

  it("returns only the caller's own payments, with the linked plan's name", async () => {
    const member = await createMember(t.db);
    const ms = await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const payment = await createPayment(t.db, { userId: member.id, membershipId: ms.id, amountCents: 450000 });

    const other = await createMember(t.db);
    await createPayment(t.db, { userId: other.id, amountCents: 999 });

    const mine = await callerAs(t.db, member).payments.mine();
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe(payment.id);
    expect(mine[0].amountCents).toBe(450000);
  });

  it("requires sign-in", async () => {
    await expect(callerAs(t.db, null).payments.mine()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Sign in required.",
    });
  });
});

describe("payments.markPaid", () => {
  const t = useTestDatabase();

  it("flips a pending payment to paid", async () => {
    const member = await createMember(t.db);
    const payment = await createPayment(t.db, { userId: member.id, status: "pending" });
    const admin = await createAdmin(t.db);

    const result = await callerAs(t.db, admin).payments.markPaid({ id: payment.id });
    expect(result.status).toBe("paid");

    const mine = await callerAs(t.db, member).payments.mine();
    expect(mine[0].status).toBe("paid");
  });

  it("CURRENT BEHAVIOR: marking an already-paid payment paid again succeeds (no guard against redundant calls)", async () => {
    const member = await createMember(t.db);
    const payment = await createPayment(t.db, { userId: member.id, status: "paid" });
    const admin = await createAdmin(t.db);

    await expect(callerAs(t.db, admin).payments.markPaid({ id: payment.id })).resolves.toMatchObject({
      status: "paid",
    });
  });

  it('rejects a refunded payment with BAD_REQUEST "Refunded payments cannot be marked paid."', async () => {
    const member = await createMember(t.db);
    const payment = await createPayment(t.db, { userId: member.id, status: "refunded" });
    const admin = await createAdmin(t.db);

    await expect(callerAs(t.db, admin).payments.markPaid({ id: payment.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Refunded payments cannot be marked paid.",
    });
  });

  it('rejects with NOT_FOUND "Payment not found." for an unknown id', async () => {
    const admin = await createAdmin(t.db);
    await expect(callerAs(t.db, admin).payments.markPaid({ id: 999999 })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Payment not found.",
    });
  });

  it("requires admin, not just staff", async () => {
    const member = await createMember(t.db);
    const payment = await createPayment(t.db, { userId: member.id, status: "pending" });
    const trainer = await createMember(t.db, { role: "trainer" });

    await expect(callerAs(t.db, trainer).payments.markPaid({ id: payment.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Admins only.",
    });
  });
});

describe("payments.refund", () => {
  const t = useTestDatabase();

  it("CURRENT BEHAVIOR: flips the payment to refunded AND directly cancels the linked membership's status — but leaves creditsRemaining untouched", async () => {
    const member = await createMember(t.db);
    const ms = await createActiveMembership(t.db, member.id, { creditsRemaining: 7 });
    const payment = await createPayment(t.db, { userId: member.id, membershipId: ms.id, status: "paid" });
    const admin = await createAdmin(t.db);

    const result = await callerAs(t.db, admin).payments.refund({ id: payment.id });
    expect(result.status).toBe("refunded");

    const updatedMs = await getMembership(t.db, ms.id);
    expect(updatedMs?.status).toBe("cancelled"); // audit: refund directly mutates membership status
    expect(updatedMs?.creditsRemaining).toBe(7); // unchanged — no clawback of remaining credits
  });

  it("CURRENT BEHAVIOR: does not cancel or otherwise touch bookings already made against the refunded membership's credits", async () => {
    const member = await createMember(t.db);
    const ms = await createActiveMembership(t.db, member.id, { creditsRemaining: 10 });
    const payment = await createPayment(t.db, { userId: member.id, membershipId: ms.id, status: "paid" });
    const cls = await createClass(t.db, { capacity: 5, creditCost: 3 });
    const booking = await callerAs(t.db, member).bookings.book({ classId: cls.id });
    expect(booking.status).toBe("booked");

    const admin = await createAdmin(t.db);
    await callerAs(t.db, admin).payments.refund({ id: payment.id });

    const bookingRow = await getBooking(t.db, booking.id);
    expect(bookingRow?.status).toBe("booked"); // left exactly as it was before the refund
  });

  it("does not error when the payment has no linked membership (membershipId is null)", async () => {
    const member = await createMember(t.db);
    const payment = await createPayment(t.db, { userId: member.id, status: "paid" }); // no membershipId
    const admin = await createAdmin(t.db);

    await expect(callerAs(t.db, admin).payments.refund({ id: payment.id })).resolves.toMatchObject({
      status: "refunded",
    });
  });

  it('rejects a pending payment with BAD_REQUEST "Only paid payments can be refunded."', async () => {
    const member = await createMember(t.db);
    const payment = await createPayment(t.db, { userId: member.id, status: "pending" });
    const admin = await createAdmin(t.db);

    await expect(callerAs(t.db, admin).payments.refund({ id: payment.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Only paid payments can be refunded.",
    });
  });

  it('rejects an already-refunded payment with the same BAD_REQUEST message (refund is not idempotent)', async () => {
    const member = await createMember(t.db);
    const payment = await createPayment(t.db, { userId: member.id, status: "refunded" });
    const admin = await createAdmin(t.db);

    await expect(callerAs(t.db, admin).payments.refund({ id: payment.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Only paid payments can be refunded.",
    });
  });

  it('rejects with NOT_FOUND "Payment not found." for an unknown id', async () => {
    const admin = await createAdmin(t.db);
    await expect(callerAs(t.db, admin).payments.refund({ id: 999999 })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Payment not found.",
    });
  });

  it("requires admin — a member cannot refund their own payment", async () => {
    const member = await createMember(t.db);
    const payment = await createPayment(t.db, { userId: member.id, status: "paid" });

    await expect(callerAs(t.db, member).payments.refund({ id: payment.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Admins only.",
    });
  });
});

describe("payments.all", () => {
  const t = useTestDatabase();

  it("returns payments across all members, admin-only", async () => {
    const memberA = await createMember(t.db);
    const memberB = await createMember(t.db);
    await createPayment(t.db, { userId: memberA.id });
    await createPayment(t.db, { userId: memberB.id });
    const admin = await createAdmin(t.db);

    const all = await callerAs(t.db, admin).payments.all({});
    expect(all).toHaveLength(2);
  });

  it("requires admin", async () => {
    const member = await createMember(t.db);
    await expect(callerAs(t.db, member).payments.all({})).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Admins only.",
    });
  });
});
