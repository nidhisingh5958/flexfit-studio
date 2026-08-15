# FlexFit Studio — Behavioral Baseline

This document records what the FlexFit Studio codebase **actually does today**, as
verified by the automated characterization suite under `tests/`. It is the
companion to the FlexFit Baseline Audit produced in Phase 1 (bug/architecture IDs
below — `BUG-*`, `ARCH-*`, `DUP-*`, `SEC-*`, `DATA-*` — refer to that document) and
exists to give a future refactor something concrete to be measured against.

**How to read this document:** every row describes an *observed* behavior, not a
*desired* one. Where the audit flagged a behavior as a bug or an inconsistency,
that's noted in the Audit Finding column — but the Current Behavior column always
describes what the code does, not what it should do. Where "Intended behavior" is
"Unresolved," see [`open-questions.md`](./open-questions.md).

Confidence follows the audit's scale: **Confirmed** (directly observed, asserted
by a passing test), **Highly likely**, **Possible**, **Uncertain**.

All 189 tests referenced below pass against the current codebase (see the test run
summary at the bottom). A passing test here means "this is what the code does,"
not "this is correct."

**Revision note (Phase 2B):** this baseline was updated after the Phase 2 review
identified two findings (BUG-010, DUP-005) whose characterization tests could pass
even if the underlying bug were accidentally fixed, plus six areas of the
application with zero automated coverage. Both critical weaknesses were rebuilt and
all six coverage gaps were closed (payments, notifications, `bookings.upcomingForMember`,
staff-cancellation DB assertions on both booking types, and `admin.stats`). Existing
findings' meaning is unchanged — only the sections below noting BUG-010, DUP-005,
and the newly-covered routers were revised or extended.

---

## 1. Individual booking

| Scenario | Current behavior | Procedure / file | Test | Audit finding | Confidence | Intended behavior |
|---|---|---|---|---|---|---|
| Book an open class with sufficient credits | Creates a `booked` row, debits `creditCost` from the active membership | `bookings.book` — `src/server/routers/bookings.ts:67` | `tests/booking/individual-booking.test.ts` | — | Confirmed | Known — this is the golden path |
| Book with an unlimited (999-credit) membership | Booking is created and `creditsUsed` is still recorded on the row, but the membership balance is never debited | `bookings.book`, `UNLIMITED_CREDITS` guard | `tests/booking/individual-booking.test.ts`, `tests/membership/credits.test.ts` | Preserve-as-is (audit §H) | Confirmed | Known — deliberate sentinel |
| Book with insufficient credits | `FORBIDDEN "Not enough class credits remaining."` | `bookings.book:120` | `tests/booking/individual-booking.test.ts` | — | Confirmed | Known |
| Book with no active membership | `FORBIDDEN "An active membership is required to book classes."` | `bookings.book:112` | `tests/booking/individual-booking.test.ts` | — | Confirmed | Known |
| Book with an expired-by-date or cancelled-status membership | Treated identically to "no membership" | `activeMembershipFor` | `tests/membership/membership-selection.test.ts` | — | Confirmed | Known |
| Book a nonexistent class | `NOT_FOUND "Class not found."` | `bookings.book:76` | `tests/booking/individual-booking.test.ts` | — | Confirmed | Known |
| Book a cancelled class | `BAD_REQUEST "This class has been cancelled."` | `bookings.book:79` | `tests/booking/individual-booking.test.ts` | — | Confirmed | Known |
| Book a class that already started | `BAD_REQUEST "This class has already started."` | `bookings.book:85` | `tests/booking/individual-booking.test.ts` | — | Confirmed | Known |
| Book while signed out | `UNAUTHORIZED "Sign in required."` (protectedProcedure) | `src/server/trpc.ts:39` | `tests/booking/individual-booking.test.ts` | — | Confirmed | Known |
| Book the same class twice while the first booking is still active | `CONFLICT "You are already on the list for this class."` | `bookings.book:104` | `tests/booking/individual-booking.test.ts` | — | Confirmed | Known |
| Rebook a class after cancelling the first booking | Succeeds — cancelled bookings don't count toward the duplicate check | `bookings.book:99` (status filter) | `tests/booking/individual-booking.test.ts` | — | Confirmed | Known |
| `creditsRemaining === creditCost` (exact boundary) | Booking succeeds, balance goes to exactly 0 | `bookings.book:120` (`<`, not `<=`) | `tests/membership/credits.test.ts` | — | Confirmed | Known |
| `creditsRemaining === creditCost - 1` | `FORBIDDEN` | same | `tests/membership/credits.test.ts` | — | Confirmed | Known |
| `creditsRemaining === 0` and `creditCost === 0` | Succeeds — `0 < 0` is false | same | `tests/membership/credits.test.ts` | — | Confirmed | Uncertain — likely an accidental consequence of the `<` comparison, not a designed "free class" rule |

## 2. Capacity / full class

| Scenario | Current behavior | Procedure / file | Test | Audit finding | Confidence | Intended behavior |
|---|---|---|---|---|---|---|
| Book the last open individual seat | Succeeds as `booked` | `bookings.book` isFull check | `tests/booking/capacity.test.ts` | — | Confirmed | Known |
| Book one past capacity | Creates a `waitlisted` row instead of failing | `bookings.book:134-146` | `tests/booking/capacity.test.ts`, `tests/waitlist/waitlist.test.ts` | — | Confirmed | Known |
| `classes.list` capacity fields once individually full | `full: true`, `spotsLeft: 0` | `classes.ts:36-51` | `tests/booking/capacity.test.ts` | — | Confirmed | Known |
| **BUG-001**: class full via individual bookings, then a corporate booking for the same class | Corporate booking still succeeds as `booked` — capacity is counted per-table | `bookings.book` (counts `bookings` only) vs `corporateBookings.book` (counts `corporateBookings` only) | `tests/corporate/cross-capacity.test.ts` | **BUG-001** | Highly likely (now Confirmed by test) | Unresolved — see open-questions.md |
| **BUG-001** (reverse): class full via corporate bookings, then an individual booking | Individual booking still succeeds as `booked` | same | `tests/corporate/cross-capacity.test.ts` | **BUG-001** | Confirmed | Unresolved |
| `classes.list` spotsLeft/full with corporate seats already taken | Ignores corporate bookings entirely — reports open spots that don't physically exist | `classes.ts` `booked` subquery | `tests/corporate/cross-capacity.test.ts` | **BUG-001**, ARCH-007 | Confirmed | Unresolved |
| **BUG-002**: same member books individually AND corporately for one class | Both succeed independently; the "already on the list" check only looks at its own table | `bookings.book:92-109` vs `corporateBookings.book:96-113` | `tests/corporate/cross-capacity.test.ts` | **BUG-002** | Confirmed | Unresolved |
| **BUG-006**: check a "booked" attendee in early (kiosk allows up to 2h before start) | Booking flips to `attended`, which drops out of the `status='booked'` capacity count — the class then reports one more open spot than actually exists, and a new booking can be made into it | `bookings.markAttended` + `bookings.book`/`classes.list` capacity counts | `tests/booking/capacity.test.ts`, `tests/checkin/checkin-attendance.test.ts` | **BUG-006** | Confirmed | Unresolved |

## 3. Waitlisting

| Scenario | Current behavior | Procedure / file | Test | Audit finding | Confidence | Intended behavior |
|---|---|---|---|---|---|---|
| Book a full class | Creates a `waitlisted` row with `creditsUsed: 0` | `bookings.book:142-143` | `tests/waitlist/waitlist.test.ts` | — | Confirmed | Known |
| Join a waitlist with insufficient credits | Blocked — the credit-sufficiency check runs *before* the capacity check, so it's not possible to join a waitlist without enough credits at that moment | `bookings.book:119-134` (order of checks) | `tests/waitlist/waitlist-promotion.test.ts` (setup note) | — | Confirmed | Known — but see the promotion scenarios below for how this can later become stale |
| `bookings.waitlisted` queue position | 1-indexed, computed as `count(earlier bookedAt) + 1` | `bookings.ts:359-403` | `tests/waitlist/waitlist.test.ts` | — | Confirmed | Known |
| Two members waitlisted within the same wall-clock second | Both report position 1 — `bookedAt` (SQLite `CURRENT_TIMESTAMP`) has only second-level resolution, and the position query's `<` comparison ties | same | `tests/waitlist/waitlist.test.ts` | — | Confirmed | Uncertain — not documented as intended, but a narrow/rare window |
| Member leaves their own waitlist spot via cancel | Their row becomes `cancelled`; nobody is promoted | `bookings.cancel:213` (`if (status === "booked")`) | `tests/waitlist/waitlist.test.ts` | — | Confirmed | Known — promotion is deliberately scoped to freeing a *confirmed* seat |

## 4. Waitlist promotion

| Scenario | Current behavior | Procedure / file | Test | Audit finding | Confidence | Intended behavior |
|---|---|---|---|---|---|---|
| Cancel a `booked` seat with someone waitlisted | The oldest waitlisted booking is promoted to `booked`, charged `cls.creditCost`, and the membership is decremented | `bookings.cancel:213-252` | `tests/waitlist/waitlist-promotion.test.ts` | — | Confirmed | Known |
| Two+ people waitlisted | The one with the earliest `bookedAt` is promoted, not the most recent | same | `tests/waitlist/waitlist-promotion.test.ts` | — | Confirmed | Known |
| Cancel a `booked` seat with nobody waitlisted | No-op — cancellation still succeeds | same (`next` query returns nothing) | `tests/waitlist/waitlist-promotion.test.ts` | — | Confirmed | Known |
| Promote a waiter who has since spent most (not all) of their credits elsewhere, leaving a non-zero balance short of the cost | Promotion still succeeds; membership balance is floored at 0 via `Math.max(0, remaining - cost)`, not blocked | `bookings.cancel:239-249` | `tests/waitlist/waitlist-promotion.test.ts` | Preserve-as-is (audit §H) | Confirmed | Uncertain — looks deliberate (explicit `Math.max`) but not documented |
| **DUP-005**: same promotion rule, corporate side, pool has a non-zero balance too small to cover the cost | Promotion still succeeds, but the pool is **left unchanged** (not floored to zero) — a different failure mode than the individual flow's floor-to-zero | `corporateBookings.cancel:250-260` | `tests/corporate/corporate-waitlist-promotion.test.ts` | **DUP-005** | Confirmed | Unresolved — which (if either) behavior is "correct" is unknown |

*Phase 2B revision:* both rows above were originally tested with a starting balance
of exactly 0, which made "floor to zero" and "skip the debit entirely" produce the
same observable number (0) in both flows — the tests could not actually tell the
two implementations apart, and would have kept passing even if one flow's behavior
were changed to match the other's. Both tests now use a non-zero-but-insufficient
starting balance (2, against a promotion cost of 6) so the final balance is
distinguishing: the individual flow lands on 0 (proving the floor), the corporate
flow lands on 2 (proving the skip).

## 5. Cancellation

| Scenario | Current behavior | Procedure / file | Test | Audit finding | Confidence | Intended behavior |
|---|---|---|---|---|---|---|
| Owner cancels their own booking | Succeeds, `status` → `cancelled`, `cancelledAt` set | `bookings.cancel` | `tests/cancellation/cancellation.test.ts` | — | Confirmed | Known |
| Admin or trainer cancels someone else's booking | Succeeds — staff bypasses ownership; the booking row's `status`/`cancelledAt` are actually updated and credits are actually refunded (both DB-verified after each cancel, not just the response) | `bookings.cancel:172-179` | `tests/cancellation/cancellation.test.ts` | — | Confirmed | Known |
| A different member cancels someone else's booking | `FORBIDDEN "You cannot cancel this booking."` | same | `tests/cancellation/cancellation.test.ts` | — | Confirmed | Known |
| Cancel an unknown booking id | `NOT_FOUND "Booking not found."` | same | `tests/cancellation/cancellation.test.ts` | — | Confirmed | Known |
| Cancel an already-cancelled booking | `BAD_REQUEST "This booking is no longer active."` | same | `tests/cancellation/cancellation.test.ts` | — | Confirmed | Known |
| Cancel a booking for a class that already started | Succeeds — `cancel` has no `hoursUntil <= 0` guard, unlike `book` | `bookings.cancel` (no start-time check) | `tests/cancellation/cancellation.test.ts` | — | Confirmed | Uncertain — likely intentional (can't undo attendance retroactively, but nothing stops a very-late cancel) |

## 6 & 7. Credit deduction & refund

| Scenario | Current behavior | Procedure / file | Test | Audit finding | Confidence | Intended behavior |
|---|---|---|---|---|---|---|
| Cancel exactly 12h before start (`FREE_CANCELLATION_HOURS`) | `refunded: true`, boundary is inclusive (`>=`) | `bookings.ts:11`, `cancel:188-190` | `tests/cancellation/cancellation-boundary.test.ts` | — | Confirmed | Known |
| Cancel at 11h59m before start | `refunded: false` | same | `tests/cancellation/cancellation-boundary.test.ts` | — | Confirmed | Known |
| Cancel at 12h01m before start | `refunded: true` | same | `tests/cancellation/cancellation-boundary.test.ts` | — | Confirmed | Known |
| Cancel a waitlisted booking (creditsUsed=0), any timing | `refunded: false` — nothing was ever charged | same (`creditsUsed > 0` guard) | `tests/cancellation/cancellation-boundary.test.ts` | — | Confirmed | Known |
| Cancel an unlimited-membership booking inside the window | No refund is applied — guarded by `< UNLIMITED_CREDITS` | `bookings.cancel:204` | `tests/cancellation/cancellation-boundary.test.ts` | Preserve-as-is | Confirmed | Known |
| Corporate cancel at the 24h boundary (`CORPORATE_FREE_CANCELLATION_HOURS`) | Same inclusive-boundary shape as individual, but a different (larger) threshold | `corporate-bookings.ts:18`, `cancel:197-199` | `tests/corporate/corporate-cancellation.test.ts` | DUP (preserve both thresholds) | Confirmed | Known — deliberate, do not unify with the 12h individual value |

## 8. Rescheduling

| Scenario | Current behavior | Procedure / file | Test | Audit finding | Confidence | Intended behavior |
|---|---|---|---|---|---|---|
| Reschedule a booked booking to an open same-named class | New `booked` booking created, original cancelled, `creditsUsed` carried over unchanged (not re-charged) | `reschedules.ts:42-217` | `tests/reschedule/reschedule.test.ts` | — | Confirmed | Known |
| Reschedule to a full same-named class | New booking is `waitlisted` | same | `tests/reschedule/reschedule.test.ts` | — | Confirmed | Known |
| Reschedule with < 4h (`FREE_RESCHEDULE_HOURS`) until the *original* class | `BAD_REQUEST "You can only reschedule up to 4 hours before the class starts."` | `reschedules.ts:16`, `:88-94` | `tests/reschedule/reschedule.test.ts` | — | Confirmed | Known |
| Reschedule to a differently-named class | `BAD_REQUEST "You can only reschedule to a class with the same name."` | `reschedules.ts:111-116` | `tests/reschedule/reschedule.test.ts` | Preserve-as-is | Confirmed | Known — fragile but deliberate |
| Reschedule to the same class | `BAD_REQUEST "You are already booked for this class."` | `reschedules.ts:119-124` | `tests/reschedule/reschedule.test.ts` | — | Confirmed | Known |
| Reschedule to a class the member already has an active booking on | `CONFLICT "You already have an active booking for this class."` | `reschedules.ts:142-160` | `tests/reschedule/reschedule.test.ts` | — | Confirmed | Known |
| `validateReschedule` (dry-run query) | Mirrors every check in `reschedule` with identical wording, returns `{valid, reason}` instead of throwing | `reschedules.ts:252-380` | `tests/reschedule/reschedule.test.ts` | **ARCH-003** (duplicated ~130 lines) | Confirmed | Known |
| **BUG-003**: reschedule a *waitlisted* booking into an open class | New booking is `booked` with `creditsUsed: 0` — a confirmed seat is granted for free | `reschedules.ts:181-192` | `tests/reschedule/reschedule-credits.test.ts` | **BUG-003** | Confirmed | Unresolved |
| **BUG-004**: reschedule a paid `booked` booking into a full class | New `waitlisted` booking carries a **nonzero** `creditsUsed`, breaking the invariant that waitlisted rows always have `creditsUsed: 0` | `reschedules.ts:181-192` | `tests/reschedule/reschedule-credits.test.ts` | **BUG-004** | Confirmed | Unresolved |
| **BUG-004** (full chain): that waitlisted booking is later promoted via `bookings.cancel` | Promotion overwrites `creditsUsed` and decrements the membership *again* — the member is charged twice for one class | `reschedules.ts` + `bookings.cancel:226-250` | `tests/reschedule/reschedule-credits.test.ts` | **BUG-004** | Confirmed | Unresolved |

## 9. Membership selection

| Scenario | Current behavior | Procedure / file | Test | Audit finding | Confidence | Intended behavior |
|---|---|---|---|---|---|---|
| Which membership does `book()` use? | The one with `status='active' AND endDate >= today`, ordered by furthest `endDate` | `activeMembershipFor` (`bookings.ts:20-37`, duplicated in `reschedules.ts:22-39`) | `tests/membership/membership-selection.test.ts` | DUP-002 (identical duplicate) | Confirmed | Known |
| **BUG-010**: member has two simultaneous active membership rows (planted directly, selection-logic only) | Both persist; booking always draws from the one with the furthest `endDate`, regardless of credits or purchase order | `activeMembershipFor` | `tests/membership/membership-selection.test.ts` | **BUG-010** | Confirmed | Unresolved |
| **BUG-010**: `plans.subscribe` called twice through the real procedure, without the first lapsing | Not blocked — creates a second, independent `active` membership row and a second `paid` payment row; both are simultaneously active in the database | `plans.ts:21-70` (no existing-membership check) | `tests/membership/plans-subscribe.test.ts` | **BUG-010** | Confirmed | Unresolved |
| Two memberships with the identical `endDate` | Exactly one is selected deterministically per query plan, but which one is not documented anywhere | `activeMembershipFor` (`orderBy` has no tiebreaker) | `tests/membership/membership-selection.test.ts` | — | Confirmed | Uncertain |

*Phase 2B revision:* the "subscribe called twice" claim was originally tested by
planting two membership rows directly via the test factory — it never actually
called `plans.subscribe`, so it proved nothing about whether the real subscription
mechanism allows this. `tests/membership/plans-subscribe.test.ts` now calls
`plans.subscribe` twice through the actual tRPC procedure and inspects the database
afterward; the original factory-based test was retitled in
`tests/membership/membership-selection.test.ts` to accurately describe what it
proves (the *selection* query's tolerance for two coexisting rows), not the
subscription mechanism.
| **BUG-009**: kiosk's expired/no-credits banner vs. the actual booking gate | `members.byId` returns membership history ordered by `desc(startDate)` with **no status filter**; the kiosk page reads `memberships[0]` directly. This can be a different row than `activeMembershipFor` would select, so the kiosk can warn "expired"/"no credits" for a member who can, in fact, still book | `members.ts:94-106` vs `bookings.ts` `activeMembershipFor` | `tests/kiosk/kiosk-lookup.test.ts` | **BUG-009** | Confirmed | Unresolved |

## 10. Corporate booking

| Scenario | Current behavior | Procedure / file | Test | Audit finding | Confidence | Intended behavior |
|---|---|---|---|---|---|---|
| Book against a linked, active company's credit pool | Creates a `booked` corporate booking, debits `creditCost` from `creditPoolBalance` | `corporate-bookings.ts:71-165` | `tests/corporate/corporate-booking.test.ts` | — | Confirmed | Known |
| Book while not linked to any company | `FORBIDDEN "You are not linked to an active company."` | same | `tests/corporate/corporate-booking.test.ts` | — | Confirmed | Known |
| Book while linked only to an *inactive* company | Same `FORBIDDEN` as unlinked | `getCompanyForMember` (`companies.active` filter) | `tests/corporate/corporate-booking.test.ts` | — | Confirmed | Known |
| Book with an insufficient pool balance | `FORBIDDEN "Your company does not have enough credits."` — checked before capacity, so it fires even for a non-full class | `corporate-bookings.ts:124-129` | `tests/corporate/corporate-booking.test.ts` | — | Confirmed | Known |
| Book a full class corporately | Waitlists (`creditsUsed: 0`, no pool debit) | `corporate-bookings.ts:141-153` | `tests/corporate/corporate-booking.test.ts` | — | Confirmed | Known |
| **ARCH-001**: is any of this reachable from the UI? | No — `corporateBookings.mine/.book/.cancel/.markAttended/.rosterFor` have zero callers anywhere in `src/app` or `src/components` (confirmed by repo-wide search). Reachable only via a direct tRPC call by any logged-in member linked to a company | entire `corporate-bookings.ts` router | (all corporate/* tests exercise this router directly, bypassing the missing UI) | **ARCH-001** | Confirmed | Unresolved — is this still an active product feature? |

## 11. Corporate cancellation

| Scenario | Current behavior | Procedure / file | Test | Audit finding | Confidence | Intended behavior |
|---|---|---|---|---|---|---|
| Owner/staff cancellation rules | Identical shape to individual `bookings.cancel` (owner or admin/trainer only); each of the three ownership paths (owner, admin, trainer) is DB-verified to actually flip the booking's status and refund the company pool, not just return `{ok: true}` | `corporate-bookings.ts:167-265` | `tests/corporate/corporate-cancellation.test.ts` | DUP-003 (identical duplicate) | Confirmed | Known |
| Free-cancellation boundary | 24h, inclusive — see §6/7 above | same | `tests/corporate/corporate-cancellation.test.ts` | — | Confirmed | Known |
| `corporateBookings.markAttended` | Same booked→attended transition as the individual flow | `corporate-bookings.ts:267-302` | `tests/corporate/corporate-cancellation.test.ts`, `tests/checkin/corporate-checkin.test.ts` | — | Confirmed | Known |

## 12. Corporate waitlist promotion

See §4 above (DUP-005) — the corporate promotion rule is structurally identical to
the individual one but diverges on credit-shortfall handling. Covered by
`tests/corporate/corporate-waitlist-promotion.test.ts`.

## 13. Admin class cancellation

| Scenario | Current behavior | Procedure / file | Test | Audit finding | Confidence | Intended behavior |
|---|---|---|---|---|---|---|
| Admin cancels a class | `classes.cancelled → true`; `booked` individual bookings → `cancelled` | `classes.ts:132-154` | `tests/admin/admin-class-cancellation.test.ts` | — | Confirmed | Known |
| **BUG-005**: are affected members refunded? | No — no membership credit is restored | same | `tests/admin/admin-class-cancellation.test.ts` | **BUG-005** | Confirmed | Unresolved |
| **BUG-005**: are waitlisted individual bookings cancelled? | No — only `status='booked'` rows are touched; waitlisted rows are left dangling against a cancelled class | same | `tests/admin/admin-class-cancellation.test.ts` | **BUG-005** | Confirmed | Unresolved |
| **BUG-005**: are corporate bookings touched? | No — `corporateBookings` is never referenced by `classes.cancel` at all | same | `tests/admin/admin-class-cancellation.test.ts` | **BUG-005**, ARCH-001 | Confirmed | Unresolved |
| **BUG-005**: is a `class_cancelled` notification sent? | No — despite the schema defining this exact notification type and seed data implying it's expected | same, `src/db/schema.ts` notifications enum | `tests/admin/admin-class-cancellation.test.ts` | **BUG-005** | Confirmed | Unresolved |
| Non-admin (trainer) attempts `classes.cancel` | `FORBIDDEN "Admins only."` — this is `adminProcedure`, stricter than the `staffProcedure` used elsewhere for class check-in | `src/server/trpc.ts:53-58` | `tests/admin/admin-class-cancellation.test.ts` | — | Confirmed | Known |

## 14. Check-in / attendance

| Scenario | Current behavior | Procedure / file | Test | Audit finding | Confidence | Intended behavior |
|---|---|---|---|---|---|---|
| Staff checks a booked member in | `status → attended`, a `checkins` row is inserted with the given `source` | `bookings.markAttended` | `tests/checkin/checkin-attendance.test.ts` | — | Confirmed | Known |
| Default `source` when omitted | `"front_desk"` | same (zod default) | `tests/checkin/checkin-attendance.test.ts` | — | Confirmed | Known |
| Check in a waitlisted or already-attended booking | `BAD_REQUEST "Only confirmed bookings can be checked in."` | same | `tests/checkin/checkin-attendance.test.ts` | — | Confirmed | Known |
| A member checks themself in | `FORBIDDEN "Staff only."` (staffProcedure) | same | `tests/checkin/checkin-attendance.test.ts` | — | Confirmed | Known |
| **SEC-003**: a trainer who doesn't teach the class checks a member in / views its roster | Allowed — `markAttended`/`rosterFor` have no ownership check against `classes.trainerId` | `bookings.ts` (staffProcedure only) | `tests/admin/admin-authorization.test.ts` | **SEC-003** | Confirmed | Unresolved — plausibly intentional shared front-desk duty |
| **ARCH-008**: corporate check-in traceability | `corporateBookings.markAttended` inserts a `checkins` row with `bookingId: null` (schema has no FK slot for it); `bookings.checkinCountFor` (joins on that FK) never counts corporate check-ins | `corporate-bookings.ts:291-299`, `bookings.ts:347-357` | `tests/checkin/corporate-checkin.test.ts` | **ARCH-008** | Confirmed | Unresolved |

## 15. Authentication / authorization

| Scenario | Current behavior | Procedure / file | Test | Audit finding | Confidence | Intended behavior |
|---|---|---|---|---|---|---|
| Login with correct credentials | Returns `{id, name, role}`, creates a `sessions` row | `auth.ts:20-62` | `tests/authorization/auth.test.ts` | — | Confirmed | Known |
| Login email matching is case-insensitive | `.toLowerCase().trim()` before the query | same | `tests/authorization/auth.test.ts` | — | Confirmed | Known — but see note below |
| Login with a leading/trailing-whitespace email | zod's `.email()` validator rejects it **before** the handler's own `.trim()` ever runs | `auth.ts:21` (zod schema) | (documented in test comment, `auth.test.ts`) | — | Confirmed | Uncertain — the `.trim()` call is effectively dead code for whitespace, only reachable for case-folding |
| Login with an unknown email or a wrong password | Identical `UNAUTHORIZED "Email or password is incorrect."` either way — no user-enumeration signal | same | `tests/authorization/auth.test.ts` | SEC (no issue found) | Confirmed | Known |
| Login to a deactivated account | `FORBIDDEN "This account has been deactivated."`, even with the correct password | `auth.ts:36-41` | `tests/authorization/auth.test.ts` | — | Confirmed | Known |
| Register | Always creates `role: "member"` server-side, regardless of any client input | `auth.ts:88-98` | `tests/authorization/auth.test.ts` | SEC-007 (no issue found — confirmed no privilege escalation) | Confirmed | Known |
| Register with a duplicate email | `CONFLICT "An account with that email already exists."` | `auth.ts:75-86` | `tests/authorization/auth.test.ts` | — | Confirmed | Known |
| `protectedProcedure` / `staffProcedure` / `adminProcedure` | UNAUTHORIZED "Sign in required." / FORBIDDEN "Staff only." / FORBIDDEN "Admins only." respectively | `src/server/trpc.ts:39-58` | `tests/authorization/role-authorization.test.ts` | — | Confirmed | Known |
| `trainers.ts` role checks | Each of 4 procedures independently checks `role !== "trainer"` and throws `FORBIDDEN "Only trainers can access this."` — a 5th (`checkAvailability`) uses a different message ("Staff only.") and a different allowed set (trainer OR admin) | `trainers.ts` (hand-rolled per procedure) | `tests/authorization/role-authorization.test.ts` | **ARCH-004** (duplicated, inconsistent) | Confirmed | Known (behaviorally), messy (architecturally) |

## 16. Kiosk / member lookup

| Scenario | Current behavior | Procedure / file | Test | Audit finding | Confidence | Intended behavior |
|---|---|---|---|---|---|---|
| Look up a member by exact email or phone substring | Returns the matching member | `members.ts:134-161` | `tests/kiosk/kiosk-lookup.test.ts` | — | Confirmed | Known |
| No match | `NOT_FOUND "Member not found."` | same | `tests/kiosk/kiosk-lookup.test.ts` | — | Confirmed | Known |
| Match is a trainer or admin, not a member | Also `NOT_FOUND "Member not found."` — role-filtered | same | `tests/kiosk/kiosk-lookup.test.ts` | — | Confirmed | Known |
| **BUG-008**: query matches two members | Returns exactly one, arbitrarily (no `orderBy`), with no indication the match was ambiguous | same (`.get()` with no ordering) | `tests/kiosk/kiosk-lookup.test.ts` | **BUG-008** | Confirmed | Unresolved |
| **BUG-009**: kiosk membership banner | See §9 above | `members.byId` vs. `activeMembershipFor` | `tests/kiosk/kiosk-lookup.test.ts` | **BUG-009** | Confirmed | Unresolved |
| `bookings.upcomingForMember` — the kiosk's actual "who can be checked in" query (Phase 2B: previously only covered indirectly) | Returns bookings for the given user where `status='booked'`, `classes.cancelled=false`, and `startsAt` falls within `[now, now+hoursAhead]` (default `hoursAhead=2`); cancelled/waitlisted/attended bookings, past classes, out-of-window classes, and classes independently marked cancelled are all excluded; a class with no assigned trainer returns `trainerName: null` rather than erroring | `bookings.ts:313-345` | `tests/kiosk/upcoming-for-member.test.ts` | — | Confirmed | Known |
| `bookings.upcomingForMember` authorization | `staffProcedure` — trainers and admins both allowed, members forbidden (`FORBIDDEN "Staff only."`) | same | `tests/kiosk/upcoming-for-member.test.ts` | — | Confirmed | Known |

## 17. Payments (Phase 2B: new coverage)

| Scenario | Current behavior | Procedure / file | Test | Audit finding | Confidence | Intended behavior |
|---|---|---|---|---|---|---|
| `payments.mine` | Returns only the caller's own payments, left-joined to the plan name via the linked membership | `payments.ts:8-24` | `tests/payments/payments.test.ts` | — | Confirmed | Known |
| `payments.markPaid` | Flips `pending` (or already-`paid`) payments to `paid`; no error for re-marking an already-paid payment | `payments.ts:46-71` | `tests/payments/payments.test.ts` | — | Confirmed | Known |
| `payments.markPaid` on a refunded payment | `BAD_REQUEST "Refunded payments cannot be marked paid."` | same | `tests/payments/payments.test.ts` | — | Confirmed | Known |
| `payments.refund` | Flips the payment to `refunded`, and — if `membershipId` is set — directly sets the linked membership's `status` to `"cancelled"` | `payments.ts:73-107` | `tests/payments/payments.test.ts` | audit open-question §6 (what should refund do) | Confirmed | Unresolved (whether this cascade is intended) |
| `payments.refund`: does it touch `creditsRemaining`? | No — the membership's remaining credit balance is left exactly as it was; only `status` changes | same | `tests/payments/payments.test.ts` | — | Confirmed | Unresolved |
| `payments.refund`: does it touch existing bookings made with that membership's credits? | No — a `booked` booking made against the now-cancelled membership is left completely untouched | same | `tests/payments/payments.test.ts` | audit open-question §6 | Confirmed | Unresolved |
| `payments.refund` on a non-`paid` payment | `BAD_REQUEST "Only paid payments can be refunded."` (applies to `pending` and already-`refunded` alike — refund is not idempotent) | same | `tests/payments/payments.test.ts` | — | Confirmed | Known |
| `payments.markPaid` / `.refund` / `.all` authorization | `adminProcedure` — trainers and members both forbidden | same | `tests/payments/payments.test.ts` | — | Confirmed | Known |

## 18. Notifications (Phase 2B: new coverage)

| Scenario | Current behavior | Procedure / file | Test | Audit finding | Confidence | Intended behavior |
|---|---|---|---|---|---|---|
| `notifications.unreadCount` / `.list` | Scoped strictly to the caller's own `userId`; unread count excludes `read=true` rows | `notifications.ts:7-32` | `tests/notifications/notifications.test.ts` | — | Confirmed | Known |
| `notifications.markAllAsRead` | Sets `read=true` on every unread row for the caller only; other users' rows are untouched | `notifications.ts:34-46` | `tests/notifications/notifications.test.ts` | — | Confirmed | Known |
| `notifications.broadcast` | Inserts one `type: "announcement"` row per user with `role='member'` — trainers and admins never receive a broadcast notification | `notifications.ts:48-75` | `tests/notifications/notifications.test.ts` | — | Confirmed | Known |
| `notifications.broadcast` with zero members | Returns `{ok: true, count: 0}`, no error, no rows inserted | same | `tests/notifications/notifications.test.ts` | — | Confirmed | Known |
| `notifications.broadcast` authorization | `adminProcedure` — trainers forbidden | same | `tests/notifications/notifications.test.ts` | — | Confirmed | Known |
| **BUG-005** (notifications-router angle): affected member's `notifications.list`/`.unreadCount` after their class is admin-cancelled | Unchanged — no new notification of any type appears, confirmed via the actual notifications router (not a raw DB query) | `classes.ts` `cancel` (never inserts into `notifications`) | `tests/notifications/notifications.test.ts` | **BUG-005** | Confirmed | Unresolved |

## Admin reporting (partial coverage)

| Scenario | Current behavior | Procedure / file | Test | Audit finding | Confidence | Intended behavior |
|---|---|---|---|---|---|---|
| `admin.stats` (Phase 2B: previously only checked `.toBeDefined()`) | Returns exact computed values: `totalMembers` (role='member' only), `activeMemberships` (status='active' AND endDate>=today), `upcomingClasses` (startsAt>=now AND cancelled=false), `revenueCents` (sum of `paid` payments only), `totalCheckins` (unconditional count), `pendingPayments` (count of `pending` payments) — every field independently verified against a fully-controlled fixture | `admin.ts:15-61` | `tests/admin/admin-stats.test.ts` | — | Confirmed | Known |
| `admin.classUtilisation`, `.revenueByMonth`, `.revenueByMethod`, `.expiringMemberships`, `.refundCount`, `.checkinsPerDay`, `.topTrainers`, `.noShowList` | Not characterized — remains a gap (see `docs/behavioral-coverage.md`) | `admin.ts` | — | — | — | — |

## Concurrency (DATA-001, DATA-002, DATA-003)

All three reproduced **deterministically** across repeated local trials (8/8, then
confirmed again via 5 full suite reruns) using two independent SQLite connections
against the same underlying file, mirroring two concurrent HTTP requests in
production (each of which gets its own `db` from `createContext`).

| Scenario | Current behavior | Root cause | Test | Audit finding | Confidence |
|---|---|---|---|---|---|
| Two users book the last seat of a capacity-1 class concurrently | **Both succeed** — the class ends up with 2 `booked` rows against a capacity of 1 | No transaction around the count-then-insert in `bookings.book` | `tests/concurrency/concurrent-booking.test.ts` | **DATA-001**, ARCH-005 | Confirmed |
| Two concurrent cancellations refund credit onto the same membership row | **One refund is lost** — both requests read the same starting balance before either writes back | Read-then-write credit update, no atomic increment, no transaction | `tests/concurrency/concurrent-credit.test.ts` | **DATA-002**, ARCH-005 | Confirmed |
| One user books the same class twice, concurrently | **Both succeed** — two active booking rows for one user on one class | No transaction around the existing-booking check, no unique constraint | `tests/concurrency/concurrent-duplicate-booking.test.ts` | **DATA-003**, ARCH-005 | Confirmed |

---

## Test run summary (as of this baseline)

```
Test Files  30 passed (30)
     Tests  189 passed (189)
```

(Grew from 25 files / 146 tests at the end of Phase 2 to 30 files / 189 tests after
the Phase 2B gap-closing pass — new files: `tests/membership/plans-subscribe.test.ts`,
`tests/payments/payments.test.ts`, `tests/notifications/notifications.test.ts`,
`tests/kiosk/upcoming-for-member.test.ts`, `tests/admin/admin-stats.test.ts`.)

Every test in the suite currently **passes** — including the ones that assert
buggy/suspicious current behavior (BUG-001 through BUG-010, DATA-001 through
DATA-003, DUP-005, ARCH-001, ARCH-003, ARCH-004, ARCH-008, SEC-003). A "pass" on
one of those tests means *the code does exactly what the audit said it does* —
not that the behavior is correct. If a future refactor changes any of these
behaviors on purpose, the corresponding test is expected to start failing, and
should be updated deliberately (with a note on why), not silently adjusted.
