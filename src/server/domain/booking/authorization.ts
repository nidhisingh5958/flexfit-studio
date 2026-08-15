import type { User } from "@/db/schema";

/**
 * Whether `user` is allowed to manage (cancel) a booking owned by
 * `ownerId` — true if they own it themselves, or if they're staff
 * (admin or trainer). Pure predicate only: it does not throw and does
 * not know about any caller's error code/message — each call site keeps
 * its own error handling exactly as before.
 */
export function canManageBooking(
  user: Pick<User, "id" | "role">,
  ownerId: number,
): boolean {
  const isOwner = ownerId === user.id;
  const isStaff = user.role === "admin" || user.role === "trainer";
  return isOwner || isStaff;
}
