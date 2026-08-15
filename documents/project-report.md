# FlexFit Studio — Audit & Refactoring Project Report

FlexFit Studio is a Next.js / tRPC / Drizzle (SQLite) gym-booking app covering
individual and corporate class bookings, waitlists, memberships, payments, and
admin reporting. This report covers the full project arc: auditing the existing
codebase, building a behavioral safety net around it, planning a refactor, and
executing that refactor incrementally — without ever changing business logic,
fixing bugs, or altering the public tRPC API.

Full supporting detail lives in `docs/`: `behavioral-baseline.md` (the
characterization suite's findings, scenario by scenario), `behavioral-coverage.md`
(the coverage audit), `open-questions.md` (unresolved business questions),
`refactoring-plan.md` (the approved plan), and `phase-4-final-review.md` (the
final sign-off on the executed refactor). This document is the polished,
narrative summary of all of it.

---

## 1. What we found

The project began with a full read-through of every router, schema table, and
middleware file, with every finding classified as one of four things —
**confirmed bug**, **architecture problem**, **duplication**, or **edge
case/deliberate quirk** — so that later work wouldn't "fix" something that was
actually an intentional design choice.

### Confirmed bugs (10)

| ID | What happens |
|---|---|
| BUG-001 | Individual and corporate bookings count capacity against two separate tables with no cross-check — a room can end up overbooked once both booking types are in play. |
| BUG-002 | The same member can hold both an individual and a corporate booking for one class simultaneously. |
| BUG-003 | Rescheduling a waitlisted booking into an open class grants a confirmed seat for free — no charge is ever applied. |
| BUG-004 | Rescheduling a paid booking into a full class produces a waitlisted row with a nonzero `creditsUsed`; if later promoted, the member is charged a second time for the same class. |
| BUG-005 | Admin class cancellation only flips `booked` individual bookings to `cancelled` — no refund, no waitlist cleanup, no corporate-booking handling, and no notification, despite the schema defining exactly that notification type. |
| BUG-006 | Checking a member in early removes them from the "booked" capacity count, opening a phantom seat that can be double-booked. |
| BUG-007 | A member linked to two active companies has their booking charged to whichever company wins an undocumented query-order tiebreak. |
| BUG-008 | An ambiguous kiosk search (multiple matching members) silently returns one of them with no indication of the ambiguity. |
| BUG-009 | The kiosk's membership-status banner and the actual booking-eligibility check can read two different membership rows for the same member, misinforming staff. |
| BUG-010 | Nothing blocks a member from holding two simultaneous active memberships; booking always draws credits from whichever has the furthest expiry, silently stranding credits on the other. |

### Data-race findings (3) — reproduced deterministically

| ID | Race |
|---|---|
| DATA-001 | Two concurrent bookings for the last open seat can both succeed, overbooking a capacity-1 class to 2. |
| DATA-002 | Two concurrent refunds onto the same membership: one update is lost (classic read-then-write race). |
| DATA-003 | Two concurrent booking attempts by the same user for the same class both succeed, bypassing the duplicate-booking check. |

All three stem from the same root cause — reads and writes with no transaction
or locking around them — and were reproduced 8/8 (then reconfirmed on repeated
reruns) using two independent SQLite connections against the same file, standing
in for two concurrent HTTP requests.

### Duplication (DUP-005 and architectural duplication)

The most significant duplication finding, **DUP-005**, sits at the boundary
between "duplication" and "bug": individual and corporate waitlist promotion
implement the *same* business rule ("promote regardless of available funds")
with two structurally different outcomes on a credit shortfall — individual
floors the balance at zero, corporate skips the debit entirely, leaving the
pool untouched. It reads as copy-paste drift, but it's just as plausibly two
independently-designed policies, so it was documented as an open question, not
"fixed."

Beyond DUP-005, the audit found straightforward accidental duplication: a
3-line `hoursUntil` helper copied verbatim into 3 routers, a 17-line
`activeMembershipFor` query copied into 2, an ownership predicate copied into
both cancellation handlers, and — the largest single case — an ~130-line,
8-step reschedule-eligibility check duplicated verbatim within one file
(`reschedules.ts`'s `reschedule` mutation and `validateReschedule` query).

### Deliberate quirks (preserve-as-is)

Several behaviors that look suspicious are almost certainly intentional and
were explicitly flagged as *do not touch*: the 999-credit "unlimited
membership" sentinel, the differing 12h (individual) vs. 24h (corporate)
free-cancellation windows, and waitlist promotion's floor-rather-than-block
policy on the individual side.

### Twelve open business questions

The audit and characterization work surfaced 12 questions that genuinely can't
be answered from the code — e.g., *should individual and corporate capacity
ever be shared? Is corporate booking still an active product feature (its
entire booking flow has zero frontend callers)? Should DUP-005's two
behaviors converge?* These are catalogued in `docs/open-questions.md` and
were deliberately left unresolved throughout the refactor — resolving any of
them would be a product decision, not a refactor.

---

## 2. What we changed

Nine refactoring steps were planned and executed, each shipped and verified
independently:

| Step | Extraction | Removes |
|---|---|---|
| 1 | `hoursUntil` → `domain/shared/time.ts` | 3 byte-identical copies |
| 2 | `activeMembershipFor` → `domain/membership/active-membership.ts` | 2 byte-identical copies |
| 3 | `canManageBooking` (ownership predicate) → `domain/booking/authorization.ts` | 2 byte-identical copies |
| 4 | `adjustIndividualCredits` → `domain/membership/credits.ts` | 3 duplicated blocks inside `bookings.ts` alone |
| 5 | `adjustCorporatePool` → `domain/corporate/credit-pool.ts` | mirrors Step 4 for `corporate-bookings.ts`, kept fully independent |
| 6 | `countActiveBookings` → `domain/booking/capacity.ts` | 5–6 duplicated capacity-count call sites |
| 7 | `findOldestWaitlistedBooking` / `findOldestWaitlistedCorporateBooking` → `domain/booking/waitlist.ts` | 2 duplicated "oldest waitlisted" queries |
| 8 | `validateRescheduleRequest` → `domain/reschedule/validate.ts` | the ~130-line duplicated reschedule check sequence |
| 9 | `admin.ts` split into `admin/dashboard.ts`, `admin/revenue-reports.ts`, `admin/attendance-reports.ts` | a 268-line, 9-procedure, low-cohesion file |

**What did not change, anywhere in this project:** the tRPC API surface (every
procedure name, input schema, and response shape), every error code and
message string, authorization rules, the database schema, and every one of the
14 findings above (10 bugs, 3 races, DUP-005) — all still reproduce identically.

**Four production files were modified** (`bookings.ts`, `corporate-bookings.ts`,
`reschedules.ts`, `admin.ts`); **eleven new files were added**, all under
`src/server/domain/` and `src/server/routers/admin/`. `reschedules.ts` shrank
from 382 to ~148 lines; `admin.ts` from 268 to 43.

---

## 3. Architecture: before → after

**Before** — three routers each carried a mix of concerns in one file: input
validation, authorization, pure calculations, one-off queries, and mutation
orchestration, with several pieces of logic copy-pasted across files because
there was nowhere shared to put them.

**After** — a new `src/server/domain/` layer holds only logic that is *actually*
reused by two or more routers, organized by concept rather than by router:

```
src/server/
  routers/
    bookings.ts              thinner — imports from domain/, orchestration stays inline
    corporate-bookings.ts    thinner — imports from domain/, orchestration stays inline
    reschedules.ts           thinner — both procedures call domain/reschedule/validate.ts
    admin.ts                 thin composition: router({ ...dashboard, ...revenueReports, ...attendanceReports })
    admin/
      dashboard.ts            stats, classUtilisation
      revenue-reports.ts      revenueByMonth, revenueByMethod, expiringMemberships, refundCount
      attendance-reports.ts   checkinsPerDay, topTrainers, noShowList
  domain/
    shared/time.ts                    hoursUntil
    membership/active-membership.ts   activeMembershipFor
    membership/credits.ts             adjustIndividualCredits
    corporate/credit-pool.ts          adjustCorporatePool (deliberately separate — see §6)
    booking/authorization.ts          canManageBooking
    booking/capacity.ts               countActiveBookings
    booking/waitlist.ts               findOldestWaitlistedBooking / findOldestWaitlistedCorporateBooking
    reschedule/validate.ts            validateRescheduleRequest
```

Every domain function is either a **pure calculation/predicate** (no I/O, no
error handling — `hoursUntil`, `adjustIndividualCredits`,
`adjustCorporatePool`, `canManageBooking`) or a **single parameterized query**
(`activeMembershipFor`, `countActiveBookings`, `findOldestWaitlisted*`,
`validateRescheduleRequest`, which bundles a read-only 8-check sequence and
returns a result rather than throwing). Authorization, error-throwing, and the
*sequence* of reads/writes in `book()`/`cancel()`/`reschedule()` all
deliberately stayed inline in the routers — moving orchestration itself was
explicitly out of scope (see §6, Step 10).

**What was deliberately not introduced:** a repository layer, a services
layer, or a dependency-injection container. With 14 tables and ~5,500 lines,
most queries are single-purpose and shaped for exactly one response; a generic
repository would have added indirection without removing any real duplication,
and risked silently normalizing behaviors (like `classes.list` vs.
`admin.classUtilisation`'s differing definitions of "booked," which is
BUG-006's root cause) that must stay divergent.

---

## 4. Testing methodology

**Characterization testing, not TDD.** The test suite records what the code
*currently does*, not what it *should* do — including tests that assert buggy
behavior on purpose. A "passing" test on a BUG-* finding means "the code still
does exactly what the audit said it does," not "this is correct." If a future
change intentionally fixes one of these behaviors, the corresponding test is
expected to fail and should be updated deliberately, with a note — never
silently adjusted.

**How tests run:** each test gets a fresh SQLite file
(`mkdtempSync` + `drizzle-orm/libsql/migrator`), and tRPC procedures are
invoked directly via `appRouter.createCaller(ctx)`, bypassing HTTP and
Next.js's request scope (with `next/headers`'s `cookies()` mocked). This keeps
tests fast and deterministic while still exercising the real procedure code,
real authorization middleware, and real database queries.

**Concurrency testing.** DATA-001/002/003 are true race conditions, so they're
tested with two independent `@libsql/client` connections against the same
underlying file — not simulated with mocks — which reproduces the races
deterministically. These were run repeatedly (8/8 initially, then reconfirmed
on 5x reruns after every refactor step that touched the relevant code path) to
rule out flakiness before trusting the result.

**A dedicated coverage review pass.** After the initial suite was built, it was
independently audited for whether it would actually *catch* a regression —
not just whether it currently passes. That review found two **critical**
weaknesses (BUG-010 and DUP-005 tests that used input values which happened to
produce the same output whether the bug was present or fixed) and several
**high**-priority gaps with zero coverage (payments, notifications,
`bookings.upcomingForMember`, staff-cancellation DB assertions, `admin.stats`).
All of these were closed in a dedicated pass: DUP-005's tests were rebuilt with
a starting balance (2) and cost (6) chosen specifically so the two flows'
outputs are distinguishable (individual floors to 0, corporate skips to 2),
and the coverage gaps were filled with new test files. The suite grew from 25
files / 146 tests to **30 files / 189 tests**.

**Per-refactor-step verification ritual**, repeated for every one of the 9
steps: re-read the exact code being touched and every call site; verify the
extraction was genuinely behavior-preserving before writing it; run
`tsc --noEmit`; run the targeted test files for that step with verbose output
(exact test names and values, not just pass/fail counts); run the full
189-test suite; explicitly re-verify every BUG-*/DATA-*/DUP-005 finding whose
code path the step touched, by exact value, not by "tests are green"; review
the complete diff for scope creep; and only then consider the step done.

---

## 5. Known bugs (preserved, not fixed)

All 14 findings below were re-traced through the *current*, post-refactor
source and confirmed to reproduce identically — not merely inferred from a
passing test count.

| Findings | Status after refactor |
|---|---|
| BUG-001, BUG-002 | Unchanged — `countActiveBookings` and the duplicate-check query are still called once per table, hardcoded at each call site; capacity and duplicate-booking checks are still never cross-referenced between `bookings` and `corporateBookings`. |
| BUG-003, BUG-004 | Unchanged — `validateRescheduleRequest` extracted only the *eligibility checks*; the credit-carry-forward and double-charge-on-promotion code (where these bugs actually live) was never touched. |
| BUG-005 | Unchanged — lives in `classes.ts`, outside the scope of every step in this refactor. |
| BUG-006 | Unchanged — `countActiveBookings`'s `WHERE status = 'booked'` clause and `admin.classUtilisation`'s differing `status in ('booked','attended')` condition were both copied verbatim, kept deliberately divergent. |
| BUG-007 | Unchanged — `getCompanyForMember` was never touched. |
| BUG-008, BUG-009 | Unchanged — kiosk lookup and `members.byId` are outside this refactor's scope. |
| BUG-010 | Unchanged — `activeMembershipFor`'s selection query (`status='active' AND endDate>=today`, ordered by furthest `endDate`) was copied verbatim; no uniqueness guard was added anywhere. |
| DATA-001, DATA-002, DATA-003 | Unchanged — every extraction that touched these code paths (Steps 4, 5, 6) kept the exact same non-atomic read-then-write shape; no transaction, lock, or atomic operation was introduced anywhere. |
| DUP-005 | Unchanged — `adjustIndividualCredits` and `adjustCorporatePool` are two fully independent functions (grep-confirmed: neither imports or calls the other); the guard deciding *whether* to debit the corporate pool at all was preserved exactly at its call site. |

---

## 6. Decisions and trade-offs

**Individual and corporate booking logic were never merged.** This was the
single highest-stakes decision in the plan. The two flows share several
*shapes* (capacity-count query, duplicate-check query, ownership predicate,
waitlist-candidate lookup) — those were extracted. But their payer models are
fundamentally different cardinality (one `memberships` row per user vs. one
shared `companies` pool per employer), the "unlimited" concept only exists on
the individual side, the free-cancellation windows are deliberately different
constants (12h vs. 24h), and — critically — BUG-001, BUG-002, and DUP-005 are
each, in one way or another, *about* the two sides not talking to each other.
Building a shared "payer" abstraction would have forced a choice between
leaking payer-specific branches back into the abstraction (defeating it) or
silently normalizing one of those three findings. Two small, independently
named, non-cross-calling functions (`adjustIndividualCredits` /
`adjustCorporatePool`) were judged more honest than one function with a
hidden `if (payerType === "corporate")`.

**A typing trade-off surfaced mid-refactor.** Step 6's `countActiveBookings`
takes a narrow union type (`typeof bookings | typeof corporateBookings`) and
compiled cleanly, because it only returns a primitive count. The same pattern
was tried first for Step 7's "find oldest waitlisted" query, but failed
`tsc --noEmit` — returning a full row under a union table parameter loses
per-table column information (`membershipId` vs. `companyId`), which would
have forced an unsafe cast at the call site. The resolution was two small,
independently-typed wrapper functions instead of one generic one — a
deliberate choice to keep every return type exact over minimizing line count.

**`admin.ts` was split by actual page consumption, not an invented layer.**
The three resulting files (`dashboard.ts`, `revenue-reports.ts`,
`attendance-reports.ts`) map exactly to which admin page already calls which
procedures — this is an existing, observable seam, not a new abstraction
imposed on the code. The client-facing `admin.*` namespace, every input
schema, and every authorization level are byte-for-byte unchanged.

**No repository layer, no services layer.** Explicitly considered and
rejected (see §3) — nothing in this ~5,500-line codebase's actual duplication
justified one.

**Step 10 (shared cancellation orchestration) remains deferred.** The two
`cancel()` handlers still repeat their overall orchestration shape (fetch →
authorize → status-check → compute refund → cancel → conditionally refund →
conditionally promote) even after Steps 2/3/5/6/7 extracted every genuinely
duplicated *piece* inside that sequence. Unifying the orchestration itself
would require either a generic "payer" abstraction (already rejected above)
or a branching orchestrator whose complexity would likely exceed the ~15 lines
per router it would save — and reordering that `await` sequence is exactly
the kind of change that could quietly shift DATA-001/002/003's race timing
even while "preserving the same logic." This was judged a defer, not a
rejection: no evidence surfaced during the refactor that the remaining
duplication is causing real problems.

---

## 7. Limitations

**Test coverage is strong where it was touched, not universal.** All 189
tests pass and every finding this refactor's code paths could affect was
individually re-verified. But several admin report endpoints
(`revenueByMonth`, `revenueByMethod`, `expiringMemberships`, `refundCount`,
`checkinsPerDay`, `topTrainers`, `noShowList`) have no dedicated exact-value
characterization test — their extraction (Step 9) was verified by proving the
SQL was copied verbatim via diff, not by a new fixture-backed assertion. And
no test calls any `domain/` function directly at the unit level — all
coverage is indirect, through router integration tests via `createCaller`.
Given most domain functions have only one or two call sites total, the risk
this masks a regression is low but not zero.

**A handful of areas were out of scope for the Phase 2/2B coverage work and
remain genuinely untested**, independent of this refactor: `plans.list`/
`create`/`setActive`, `classes.byId`/`create`/`update`, `members.updateProfile`,
and most of `adminCompanies`'s procedures. These were flagged, not silently
ignored — see `docs/behavioral-coverage.md` for the full itemized list.

**A pre-existing TypeScript error was left untouched, as instructed.**
`tests/helpers/caller.ts:14` has a `string | null` vs. `string | undefined`
type mismatch that predates this entire project (the file was never touched
by any refactor step). It also makes `pnpm build` fail at the type-check
phase, since Next.js type-checks the `tests/` directory during a production
build — application code itself compiles successfully first. Fixing this was
explicitly out of scope ("do not change code merely to make tooling pass").

**No ESLint config exists in the repository.** `next lint` prompts to
interactively scaffold a new config rather than running against an existing
one, so lint was not run as part of this review rather than creating new
config as a side effect.

**Twelve business questions remain genuinely open**, by design — see
`docs/open-questions.md`. None of this project's phases attempted to answer
them; doing so would be a product decision, not engineering work. The two
with the highest blast radius are whether individual and corporate capacity
should ever be shared (the root question behind BUG-001/002) and whether
corporate booking is still an active feature worth building a UI for at all
(its entire employee-facing flow currently has zero frontend callers).

---

## Final status

- **189/189 tests passing**, 30/30 test files, re-run as part of the final
  review (not just trusted from earlier steps).
- **`tsc --noEmit`** clean except for the single pre-existing, out-of-scope
  `caller.ts` error.
- **Every one of the 14 named findings** (10 bugs, 3 races, DUP-005)
  individually re-traced through the current source and confirmed to
  reproduce identically.
- **Individual and corporate logic confirmed independent** by direct grep, not
  just by design intent.
- **Every changed line attributes cleanly** to one of the 9 approved
  refactoring steps — verified by re-reading the complete diff for all 4
  modified and 11 new files.

**Verdict: READY FOR SUBMISSION REVIEW.**
