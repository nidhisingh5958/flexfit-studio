# Behavioral Coverage Matrix — Phase 2 Review

Produced during the Phase 2 review (critical audit of the characterization suite,
not new test-writing). "Safe to refactor" is a statement about **behavioral-parity
protection only** — whether a test would reliably fail if a refactor silently
changed this behavior. It says nothing about whether the behavior itself is good.

**Phase 2B update:** every row marked CRITICAL or HIGH in the original review's gap
list has been closed — the affected rows below are updated in place (marked with a
*Phase 2B* note) rather than re-numbered, so this file still reads as one coherent
matrix. Rows unrelated to the Phase 2B gap list are unchanged from the original
review.

- **SAFE** — strong test(s): checks DB state and/or exact error code+message and/or
  response shape, and would fail if the behavior changed.
- **CAUTION** — a test exists and touches this behavior, but the assertion is too
  weak to guarantee it would catch a regression (response-only checks, `.toBeDefined()`,
  or — for DUP-005 — a numeric coincidence that erases the distinction being tested).
- **NOT SAFE** — zero automated coverage. A refactor here has no net at all.

Full narrative for every row below is in the Phase 2 review response.

## Booking

| Behavior | Current behavior known? | Automated test? | Test strength | Bug/Issue | Safe to refactor? |
|---|---|---|---|---|---|
| Book open class, credit debit | Yes | Yes | DB + response checked | — | SAFE |
| Book with unlimited (999) membership | Yes | Yes | DB + response checked | Preserve-as-is | SAFE |
| Book insufficient / no / expired membership | Yes | Yes | Exact code+message | — | SAFE |
| Book nonexistent / cancelled / started class | Yes | Yes | Exact code+message | — | SAFE |
| Duplicate booking (same table) | Yes | Yes | Exact code+message | — | SAFE |
| Rebook after cancel | Yes | Yes | Response checked | — | SAFE |
| Credit boundary (=, =-1, 0-cost/0-credit) | Yes | Yes | DB + response checked | — | SAFE |

## Capacity / waitlisting

| Behavior | Current behavior known? | Automated test? | Test strength | Bug/Issue | Safe to refactor? |
|---|---|---|---|---|---|
| Last seat bookable | Yes | Yes | Response checked | — | SAFE |
| Overflow waitlists, creditsUsed=0 | Yes | Yes | Response + separate query checked | — | SAFE |
| classes.list full/spotsLeft (individual only) | Yes | Yes | Response checked | — | SAFE |
| BUG-001: capacity not shared cross-table (both directions) | Yes | Yes | Response + would fail if fixed | **BUG-001** | SAFE (bug well-characterized) |
| BUG-001: classes.list ignores corporate seats | Yes | Yes | Response checked | **BUG-001** | SAFE |
| BUG-002: same user, both booking types | Yes | Yes | Response + cross-query checked | **BUG-002** | SAFE |
| Waitlist position math | Yes | Yes | Deterministic (explicit bookedAt) | — | SAFE |
| Same-second position tie (edge case) | Yes | Yes | DB-forced determinism | — | SAFE |
| Leaving own waitlist spot doesn't promote others | Yes | Yes | Queue re-checked | — | SAFE |

## Waitlist promotion

| Behavior | Current behavior known? | Automated test? | Test strength | Bug/Issue | Safe to refactor? |
|---|---|---|---|---|---|
| Promotes oldest, charges creditCost | Yes | Yes | DB + response checked | — | SAFE |
| No-op when nobody waitlisted | Yes | Yes | Response checked | — | SAFE |
| Individual: floors credits at 0 when short | Yes | Yes | *Phase 2B: rebuilt with a non-zero (2) starting balance against a cost of 6 — floor-to-zero (→0) is now distinguishable from skip-if-insufficient (→2)* | **DUP-005** | **SAFE** |
| Corporate: skips debit entirely when short | Yes | Yes | *Phase 2B: same rebuild, mirrored — final pool (2) now distinguishes it from the individual flow's floor (0)* | **DUP-005** | **SAFE** |

## Cancellation

| Behavior | Current behavior known? | Automated test? | Test strength | Bug/Issue | Safe to refactor? |
|---|---|---|---|---|---|
| Owner cancels own booking | Yes | Yes | DB state checked | — | SAFE |
| Staff (admin/trainer) cancels for someone else | Yes | Yes | *Phase 2B: now checks booking status, cancelledAt, and credit-refund DB state after both the admin and trainer sub-cases* | — | **SAFE** |
| Non-owner/non-staff forbidden | Yes | Yes | Exact code+message | — | SAFE |
| Not-found / already-cancelled | Yes | Yes | Exact code+message | — | SAFE |
| Cancel after class started (no guard) | Yes | Yes | Response checked | — | SAFE |
| 12h boundary (exact/inside/outside) | Yes | Yes | Fake timers, DB balance checked | — | SAFE |
| Waitlisted cancel never refunds | Yes | Yes | DB balance checked | — | SAFE |
| Unlimited membership never refunds | Yes | Yes | DB balance checked | — | SAFE |

## Rescheduling

| Behavior | Current behavior known? | Automated test? | Test strength | Bug/Issue | Safe to refactor? |
|---|---|---|---|---|---|
| Golden path (booked→open, credits carried) | Yes | Yes | DB + response checked | — | SAFE |
| History recorded | Yes | Yes | Query checked | — | SAFE |
| Reschedule into full → waitlisted | Yes | Yes | Response checked | — | SAFE |
| All 8 validation errors (exact messages) | Yes | Yes | Exact code+message, each | — | SAFE |
| validateReschedule parity with reschedule | Yes | Yes | Exact equality + non-mutation checked | — | SAFE |
| **BUG-003**: waitlisted→open produces free booking | Yes | Yes | DB + credit balance checked, would fail if fixed | **BUG-003** | SAFE |
| **BUG-004**: booked→full waitlist carries nonzero creditsUsed | Yes | Yes | DB checked, would fail if fixed | **BUG-004** | SAFE |
| **BUG-004**: later promotion double-charges | Yes | Yes | Full before/after credit trace, would fail if fixed | **BUG-004** | SAFE |

## Membership selection

| Behavior | Current behavior known? | Automated test? | Test strength | Bug/Issue | Safe to refactor? |
|---|---|---|---|---|---|
| Expired-by-date / cancelled-status ignored | Yes | Yes | Exact code+message | — | SAFE |
| Active-status row with a lapsed endDate (realistic prod state) | Yes (by static read) | **No** | — | — | **NOT SAFE** (untested combination — remains open, not in the Phase 2B critical/high list) |
| **BUG-010**: selection picks furthest endDate | Yes | Yes — state fabricated via test factory, **retitled** to accurately describe that it tests `activeMembershipFor` selection only, not `plans.subscribe` | Accurately scoped as of Phase 2B | **BUG-010** | SAFE |
| **BUG-010**: does the real `plans.subscribe` mutation allow a second active membership? | Yes | *Phase 2B: new* `tests/membership/plans-subscribe.test.ts` — calls `plans.subscribe` twice through the actual procedure, inspects `memberships`/`payments` tables directly | Would fail if a uniqueness guard were added to `plans.subscribe` | **BUG-010** | **SAFE** |
| Tie on identical endDate | Yes | Yes | Deliberately weak (`.toContain`), appropriately scoped | — | SAFE (with caveat) |

## Corporate booking

| Behavior | Current behavior known? | Automated test? | Test strength | Bug/Issue | Safe to refactor? |
|---|---|---|---|---|---|
| Golden path, pool debit | Yes | Yes | DB + response checked | — | SAFE |
| Not linked / inactive company | Yes | Yes | Exact code+message | — | SAFE |
| Insufficient pool (incl. before capacity check) | Yes | Yes | Exact code+message | — | SAFE |
| Duplicate corporate booking | Yes | Yes | Exact code+message | — | SAFE |
| Already-started class | Yes | Yes | Exact code+message | — | SAFE |
| Waitlist once corporate-full | Yes | Yes | Response + pool balance checked | — | SAFE |
| **ARCH-001**: reachable only via direct tRPC, no UI | Yes | Yes (all corporate/* tests exercise the router directly) | Structural finding, correctly noted | **ARCH-001** | n/a (documented, not a test-strength question) |

## Corporate cancellation

| Behavior | Current behavior known? | Automated test? | Test strength | Bug/Issue | Safe to refactor? |
|---|---|---|---|---|---|
| Owner/staff can cancel (3 sub-cases) | Yes | Yes | *Phase 2B: now checks corporate booking status, cancelledAt, and company pool balance after each of the 3 sub-cases* | — | **SAFE** |
| Non-owner forbidden | Yes | Yes | Exact code+message | — | SAFE |
| 24h boundary (exact/inside) + cross-check vs. 12h | Yes | Yes | Fake timers, pool balance checked | — | SAFE |
| markAttended golden + waitlisted-rejected | Yes | Yes | DB + exact code+message | — | SAFE |

## Corporate waitlist promotion

| Behavior | Current behavior known? | Automated test? | Test strength | Bug/Issue | Safe to refactor? |
|---|---|---|---|---|---|
| Golden path, pool debited correctly | Yes | Yes | DB checked | — | SAFE |
| **DUP-005**: pool not debited when short | Yes | Yes | *Phase 2B: rebuilt — pool balance (2) at promotion time now distinguishes "skip" from the individual flow's "floor to zero" (0)* | **DUP-005** | **SAFE** |

## Admin class cancellation (BUG-005)

| Behavior | Current behavior known? | Automated test? | Test strength | Bug/Issue | Safe to refactor? |
|---|---|---|---|---|---|
| Cancels booked individual bookings | Yes | Yes | DB checked | — | SAFE |
| No refund / no waitlist-cancel / no corporate-touch / no notification | Yes | Yes (4 separate tests) | DB checked, would fail if fixed | **BUG-005** | SAFE |
| Class itself marked cancelled | Yes | Yes | Response checked | — | SAFE |
| Not-found / non-admin forbidden | Yes | Yes | Exact code+message | — | SAFE |

## Check-in / attendance

| Behavior | Current behavior known? | Automated test? | Test strength | Bug/Issue | Safe to refactor? |
|---|---|---|---|---|---|
| Golden path, checkins row, source default | Yes | Yes | DB checked | — | SAFE |
| Not-found / waitlisted-rejected / double-checkin-rejected / member-forbidden | Yes | Yes | Exact code+message | — | SAFE |
| **BUG-006**: early check-in frees phantom seat | Yes | Yes | Response checked, would fail if fixed | **BUG-006** | SAFE |
| **ARCH-008**: corporate checkins.bookingId is null / invisible to checkinCountFor | Yes | Yes | DB checked | **ARCH-008** | SAFE |

## Authentication

| Behavior | Current behavior known? | Automated test? | Test strength | Bug/Issue | Safe to refactor? |
|---|---|---|---|---|---|
| Login golden / case-insensitive / wrong-password / unknown-email / deactivated | Yes | Yes | Exact response/code+message | — | SAFE |
| Session row created on login | Yes | Yes | DB checked | — | SAFE |
| Register golden / duplicate-email | Yes | Yes | DB + exact code+message | — | SAFE |
| Register short password (zod) | Yes | Yes | **`.rejects.toBeDefined()` only** — no code/message asserted | — | CAUTION |
| me / logout | Yes | Yes | DB checked | — | SAFE |

## Authorization

| Behavior | Current behavior known? | Automated test? | Test strength | Bug/Issue | Safe to refactor? |
|---|---|---|---|---|---|
| protectedProcedure/staffProcedure/adminProcedure reject correctly | Yes | Yes | Exact code+message | — | SAFE |
| staffProcedure admin/trainer pass-through | Yes | Yes | **`.toBeDefined()` only** | — | CAUTION |
| trainers.ts 4x role checks | Yes | Yes | Exact code+message, parameterized | — | SAFE |
| checkAvailability different message/scope (member side) | Yes | Yes | Exact code+message | — | SAFE |
| checkAvailability admin-allowed (staff side) | Yes | Yes | **`.toBeDefined()` only** | — | CAUTION |
| Trainer sets/reads/removes own availability | Yes | Yes | DB/response checked | — | SAFE |

## Kiosk / member lookup

| Behavior | Current behavior known? | Automated test? | Test strength | Bug/Issue | Safe to refactor? |
|---|---|---|---|---|---|
| lookupByEmailOrPhone golden / not-found / role-filter / staff-required | Yes | Yes | Exact code+message | — | SAFE |
| **BUG-008**: ambiguous match | Yes | Yes | Appropriately scoped (`.toContain`) | **BUG-008** | SAFE (with caveat — see review) |
| **BUG-009**: banner data-source divergence | Yes | Yes | Both sides of the divergence checked | **BUG-009** | SAFE |
| `bookings.upcomingForMember` (kiosk's actual "who can check in" query) | Yes | *Phase 2B: new* `tests/kiosk/upcoming-for-member.test.ts` — 11 tests covering booked/cancelled/attended/waitlisted status filtering, past classes, the hoursAhead window (default and custom), independently-cancelled classes, null trainer, and authorization | Direct coverage, not inferred from kiosk-lookup tests | — | **SAFE** |

## Admin authorization / reporting

| Behavior | Current behavior known? | Automated test? | Test strength | Bug/Issue | Safe to refactor? |
|---|---|---|---|---|---|
| admin.stats — all 6 returned fields | Yes | *Phase 2B: new* `tests/admin/admin-stats.test.ts` — every field (totalMembers, activeMemberships, upcomingClasses, revenueCents, totalCheckins, pendingPayments) independently derived from a controlled fixture and asserted exactly, plus an all-zeros baseline case | Would fail if any single field's computation changed | — | **SAFE** |
| admin.stats FORBIDDEN for member/trainer | Yes | Yes | Exact code+message | — | SAFE |
| members.setActive/setRole admin-only + effect | Yes | Yes | Response checked (returning()-backed) | — | SAFE |
| adminCompanies.create admin-only | Yes | Yes | Exact code+message | — | SAFE |
| **SEC-003**: trainer roster/checkin cross-class access | Yes | Yes (roster), **response-only** (markAttended) | Mixed — not in the Phase 2B critical/high list, left as-is | **SEC-003** | CAUTION |
| admin.classUtilisation/revenueByMonth/revenueByMethod/expiringMemberships/refundCount/checkinsPerDay/topTrainers/noShowList | Yes (by static read) | **No** | — | — | **NOT SAFE** (8 procedures, zero coverage — remains open, not in the Phase 2B list) |

## Corporate / company management (admin side)

| Behavior | Current behavior known? | Automated test? | Test strength | Bug/Issue | Safe to refactor? |
|---|---|---|---|---|---|
| linkMember (incl. **BUG-007** multi-company) | Yes | Yes | DB checked | **BUG-007** | SAFE |
| adminCompanies.list / getById / updateActive / topUp / unlinkMember | Yes (by static read) | **No** | — | — | **NOT SAFE** (5 procedures) |

## Untested routers

| Router / procedures | Current behavior known? | Automated test? | Safe to refactor? |
|---|---|---|---|
| `plans.subscribe` (the BUG-010 double-subscribe path) | Yes | *Phase 2B: new* `tests/membership/plans-subscribe.test.ts` | **SAFE** |
| `plans` — list, create, setActive (all other procedures) | Yes (by static read) | **No** | **NOT SAFE** — not in the Phase 2B list; only `subscribe`'s BUG-010-relevant path was added |
| `payments` — mine, markPaid, refund | Yes | *Phase 2B: new* `tests/payments/payments.test.ts` — 16 tests, DB state + authorization on all three | **SAFE** |
| `payments.all` | Yes | *Phase 2B: new*, covered in the same file | **SAFE** |
| `notifications` — unreadCount, list, markAllAsRead, broadcast | Yes | *Phase 2B: new* `tests/notifications/notifications.test.ts` — 11 tests, DB state + authorization + the BUG-005 connection | **SAFE** |
| `classes` — byId, create, update | Yes (by static read) | **No** | **NOT SAFE** — not in the Phase 2B list; remains open |
| `members` — updateProfile | Yes (by static read) | **No** | **NOT SAFE** — not in the Phase 2B list; remains open |

(`adminCompanies` remainder — list/getById/updateActive/topUp/unlinkMember — is
tracked separately above under "Corporate / company management (admin side)";
also not in the Phase 2B list, still open.)

## Concurrency

| Behavior | Current behavior known? | Automated test? | Test strength | Bug/Issue | Safe to refactor? |
|---|---|---|---|---|---|
| **DATA-001**: two concurrent bookings overbook a capacity-1 class | Yes | Yes | Two independent connections, ground-truth DB row count, verified deterministic across repeated trials | **DATA-001** | SAFE |
| **DATA-002**: two concurrent refunds lose an update | Yes | Yes | Same rigor, final balance checked | **DATA-002** | SAFE |
| **DATA-003**: two concurrent duplicate bookings both succeed | Yes | Yes | Same rigor, active-row count checked | **DATA-003** | SAFE |

---

**Summary count (post–Phase 2B):** ~90 individually-tracked behaviors.
**SAFE: ~82. CAUTION: ~2. NOT SAFE: ~13** (some rows represent multiple procedures,
e.g. the 8 remaining admin reporting queries count as one row but expand to 8
NOT SAFE line items — see the Phase 2B closing report for the itemized before/after).

All CRITICAL and HIGH gaps from the Phase 2 review are now SAFE:
BUG-010 (real `plans.subscribe` characterization added), DUP-005 (both individual
and corporate promotion tests rebuilt to actually distinguish floor-vs-skip),
`payments` router, `notifications` router, `bookings.upcomingForMember`, staff
cancellation DB assertions (both individual and corporate), and `admin.stats`.

Remaining CAUTION/NOT SAFE rows were not in the Phase 2B critical/high list and are
carried forward unchanged: the active-status-with-lapsed-endDate membership
combination, SEC-003's `markAttended` half, and the MEDIUM/LOW gaps (`plans.list/
create/setActive`, `classes.byId/create/update`, `members.updateProfile`,
`adminCompanies` remainder, and 8 of 9 `admin.*` reporting queries).
