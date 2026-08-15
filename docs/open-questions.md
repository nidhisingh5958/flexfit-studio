# Open Questions

Business-rule questions surfaced by the Phase 1 audit and the Phase 2
characterization suite that **cannot be answered from the code**. Each one is
backed by a passing characterization test that documents the current behavior
precisely — the question is only about whether that behavior is the intended
one. Do not resolve any of these by guessing; they need a product/business
decision.

Every question links to the behavioral-baseline.md section and the audit
finding ID that motivated it, plus the test that currently pins the behavior
down.

---

### 1. Should corporate and individual bookings share the same physical class capacity?

Right now they don't — `bookings.book` and `corporateBookings.book` each count
fullness against their own table only, so a room can end up hosting more people
than `classes.capacity` allows once both booking types are in play, and one
member can hold a seat both ways in the same class.

- Audit: **BUG-001**, **BUG-002**
- Baseline: §2 (Capacity), §10 (Corporate booking)
- Tests: `tests/corporate/cross-capacity.test.ts`
- Why it matters: this is the single highest-severity behavioral question in
  the whole audit — it determines whether BUG-001/002 are "the bug to fix" or
  "a reserved-allotment feature nobody built the accounting for."

### 2. Is corporate booking still an active product feature?

The entire `corporateBookings` router (book, cancel, mark attended, view
roster, "my bookings") has **zero callers** anywhere in `src/app` or
`src/components`. The admin side (create a company, top up its pool, link
members) is fully built and reachable from `/admin/companies`. The employee
side — actually spending the pool — has no page, no button, and is reachable
today only by a member calling the tRPC procedure directly. The README
describes corporate credit pools as a real, shipped feature.

- Audit: **ARCH-001**
- Baseline: §10 (Corporate booking)
- Tests: every file under `tests/corporate/` exercises this router directly,
  standing in for the missing UI
- Why it matters: this decides whether the refactor should finish the
  frontend, freeze the backend as-is, or remove it — three very different
  scopes of work, and none of them are "just clean up the code."

### 3. Should a member be allowed to have multiple simultaneous active memberships?

Nothing blocks `plans.subscribe` from being called a second time while an
earlier membership is still active. The two rows coexist; booking logic always
draws from whichever has the furthest `endDate`, and credits on the
non-selected membership can go permanently unused if that membership's own
`endDate` passes first.

- Audit: **BUG-010**
- Baseline: §9 (Membership selection)
- Tests: `tests/membership/membership-selection.test.ts`
- Why it matters: could be an intentional "stack passes" business model, or
  could be a missing guard that's quietly stranding money members already paid.

### 4. What should happen when a waitlisted booking is rescheduled into an open class?

Currently: the member gets a confirmed `booked` seat and is never charged —
`creditsUsed` is carried forward from the waitlisted original, which is always
`0`. There's a dead `membership` variable in the reschedule handler fetched
specifically "to check for unlimited credits" and never used again, strongly
suggesting charging logic was planned but never finished.

- Audit: **BUG-003**
- Baseline: §8 (Rescheduling)
- Tests: `tests/reschedule/reschedule-credits.test.ts`
- Why it matters: as written, this is a free-class loophole reachable by any
  member with a waitlisted booking and any open same-named class to move into.

### 5. What should happen to credits during reschedule → waitlist → promotion?

Currently: rescheduling a *paid* booking into a *full* class produces a
waitlisted row that (uniquely, among all waitlisted rows in the system) carries
a nonzero `creditsUsed`. If that row is later promoted through the normal
waitlist-promotion path, the promotion logic charges the member's membership
*again* for the same class — a double deduction.

- Audit: **BUG-004**
- Baseline: §8 (Rescheduling), §4 (Waitlist promotion)
- Tests: `tests/reschedule/reschedule-credits.test.ts`
- Why it matters: directly loses members' paid credits; also the mirror image
  of question 4 — question 4 undercharges, this one overcharges, and both come
  from the same underlying gap (reschedule doesn't touch credits at all, and
  everything downstream assumes it does).

### 6. What should admin class cancellation refund, and to whom?

Currently: cancelling a class from the admin side only flips `booked`
individual bookings to `cancelled`. No membership credit is refunded, no
corporate booking (booked or waitlisted) is touched, no waitlisted individual
booking is cancelled, and no `class_cancelled` notification is sent — despite
the notifications schema defining that exact type and seed data containing a
sample notification for precisely this scenario.

- Audit: **BUG-005**
- Baseline: §13 (Admin class cancellation)
- Tests: `tests/admin/admin-class-cancellation.test.ts`
- Why it matters: highest-severity single bug in the audit by blast radius —
  every class an admin cancels today leaves members' credits, corporate pools,
  waitlists, and notifications all silently out of sync with reality.

### 7. Should trainers be able to check in / view the roster for any class, or only classes they teach?

Currently: `markAttended` and `rosterFor` are gated by `staffProcedure` (admin
OR trainer) with no check against `classes.trainerId`. Any trainer can check
members into, or view the attendee list for, a class taught by a different
trainer.

- Audit: **SEC-003**
- Baseline: §14 (Check-in / attendance)
- Tests: `tests/admin/admin-authorization.test.ts`
- Why it matters: plausibly a deliberate "shared front-desk duty" design (front
  desk staff often aren't the class's own trainer), but it is a real
  permission boundary and should be confirmed rather than assumed either way.

### 8. How should corporate check-ins be represented?

Currently: `checkins.bookingId` is a single foreign key into the `bookings`
table only. `corporateBookings.markAttended` inserts a `checkins` row with
`bookingId: null` because there's no column to point it at the corporate
booking instead. `bookings.checkinCountFor` (which joins on that FK) never
counts corporate check-ins as a result.

- Audit: **ARCH-008**
- Baseline: §14 (Check-in / attendance)
- Tests: `tests/checkin/corporate-checkin.test.ts`
- Why it matters: a schema decision (second nullable FK column? a polymorphic
  `(bookingType, bookingId)` pair?), not something patchable in application
  code alone — and it's currently masked by question 2 (no UI exercises this
  path in practice, yet).

### 9. What is the intended behavior when corporate credit pool balance is insufficient during promotion?

Currently: promotion succeeds regardless (the waiting member is marked
`booked` either way), but the *pool accounting differs from the individual
flow's*: individual promotion always debits the membership, floored at zero
(`Math.max(0, remaining - cost)`); corporate promotion skips the debit
entirely if the pool can't cover it (`if (balance >= cost)`), leaving the pool
untouched rather than floored.

- Audit: **DUP-005**
- Baseline: §4 (Waitlist promotion), §12 (Corporate waitlist promotion)
- Tests: `tests/waitlist/waitlist-promotion.test.ts`,
  `tests/corporate/corporate-waitlist-promotion.test.ts`
- Why it matters: this is the same business rule (promote-regardless-of-funds)
  implemented two structurally different ways — worth knowing whether either
  was a deliberate choice before merging the individual/corporate booking
  code paths in a refactor.

---

## Additional questions surfaced during characterization (not in the original list)

### 10. Which company is charged when a member is linked to more than one active company?

Nothing in `adminCompanies.linkMember` prevents linking one member to two
different active companies (it only rejects an exact duplicate
company+member pair). `getCompanyForMember` has no `orderBy` on its join, so
which company's pool gets charged for a booking is an artifact of query
plan/insertion order, not a documented rule.

- Audit: **BUG-007**
- Baseline: §16 is adjacent (kiosk); this is really §10 (Corporate booking)
- Tests: `tests/corporate/multi-company.test.ts`
- Why it matters: currently possible to set up via the existing admin UI with
  no warning; worth deciding whether multi-company linking should be
  disallowed outright, or given an explicit priority rule.

### 11. Is the kiosk's membership-status banner supposed to reflect the same "current membership" the booking engine uses?

`members.byId` returns membership history ordered by `desc(startDate)` with no
`status` filter; the kiosk page reads `memberships[0]` directly for its
"expired" / "no credits" warnings. The actual booking gate
(`activeMembershipFor`) filters to `status='active' AND endDate >= today` and
orders by `desc(endDate)`. For a member with more than one membership row,
these can disagree — the kiosk can warn about a membership that isn't the one
that would actually gate their next booking.

- Audit: **BUG-009**
- Baseline: §9 (Membership selection), §16 (Kiosk / member lookup)
- Tests: `tests/kiosk/kiosk-lookup.test.ts`
- Why it matters: purely a UI-data-source question (the warning doesn't
  block anything server-side), but it directly misinforms front-desk staff.

### 12. Is an ambiguous kiosk search result (multiple members matching) supposed to surface the ambiguity, or is "pick one" acceptable?

`members.lookupByEmailOrPhone` has no `orderBy`; if a query substring matches
more than one member (realistic given the seeded phone number pattern,
`+91 90000 1000X`), it silently returns one of them with no indication that
others matched.

- Audit: **BUG-008**
- Baseline: §16 (Kiosk / member lookup)
- Tests: `tests/kiosk/kiosk-lookup.test.ts`
- Why it matters: a front-desk mis-check-in risk if this is ever reached with
  real overlapping data — low severity, but genuinely undecided.
