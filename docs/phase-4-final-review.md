# Phase 4 — Final Refactoring Review

Read-only review of the completed Phase 4 refactoring work. No production code was
modified in the course of writing this document.

## A. Refactors completed

All 9 core steps from `docs/refactoring-plan.md` §12 are complete and were executed
one at a time, each independently verified (tsc, targeted tests, full suite, and an
explicit re-check of every named finding whose code path the step touched) before
moving on.

| § | Step | Extraction | New file(s) |
|---|------|-----------|--------------|
| 1 | Reschedule validation | ~130 lines of duplicated eligibility checks shared by `reschedules.reschedule` and `reschedules.validateReschedule` | `domain/reschedule/validate.ts` (`validateRescheduleRequest`) |
| 2 | Individual credit guard | The debit/refund/floored-debit arithmetic duplicated 3× in `bookings.ts` | `domain/membership/credits.ts` (`adjustIndividualCredits`) |
| 3 | `hoursUntil` / `activeMembershipFor` | Duplicated between `bookings.ts`, `corporate-bookings.ts`, `reschedules.ts` | `domain/shared/time.ts`, `domain/membership/active-membership.ts` |
| 3 (resumed, §12 numbering) | Ownership predicate | `canManageBooking` — owner-or-staff check duplicated in both cancel handlers | `domain/booking/authorization.ts` |
| 4 | admin.ts restructuring | Split the monolithic router into procedure declarations + grouped query bodies | `routers/admin/dashboard.ts`, `revenue-reports.ts`, `attendance-reports.ts` |
| 5 | Corporate pool guard | Mirror of Step 2 for `corporateBookings`/`companies`, kept fully independent per DUP-005 | `domain/corporate/credit-pool.ts` (`adjustCorporatePool`) |
| 6 | Capacity count | Duplicated `count(*) where status='booked'` query | `domain/booking/capacity.ts` (`countActiveBookings`) |
| 7 | Waitlist candidate query | Duplicated "oldest waitlisted" lookup, split into two explicit wrappers after a union-typed attempt failed `tsc` | `domain/booking/waitlist.ts` (`findOldestWaitlistedBooking`, `findOldestWaitlistedCorporateBooking`) |

(Step numbering matches actual execution order across turns, which followed the
plan's §15.B priority list first, then resumed §12's raw order per the user's
explicit Option B choice — both are reproduced here since the user's own turn
labels used both conventions at different points.)

**Step 10** (shared cancellation orchestration) remains deferred — see section G.

## B. Files changed

**Modified** (4):
- `src/server/routers/bookings.ts`
- `src/server/routers/corporate-bookings.ts`
- `src/server/routers/reschedules.ts`
- `src/server/routers/admin.ts`

**New** (11):
- `src/server/domain/shared/time.ts`
- `src/server/domain/membership/active-membership.ts`
- `src/server/domain/membership/credits.ts`
- `src/server/domain/corporate/credit-pool.ts`
- `src/server/domain/booking/authorization.ts`
- `src/server/domain/booking/capacity.ts`
- `src/server/domain/booking/waitlist.ts`
- `src/server/domain/reschedule/validate.ts`
- `src/server/routers/admin/dashboard.ts`
- `src/server/routers/admin/revenue-reports.ts`
- `src/server/routers/admin/attendance-reports.ts`

**Diff attribution**: the complete `git diff` for each of the 4 modified files was
re-read in full for this review. Every hunk attributes cleanly to one of the 9 steps
above:
- `bookings.ts` — import changes (Steps 2/3/6/7), local `hoursUntil`/`activeMembershipFor`
  removed (Step 3), `book()`'s capacity count → `countActiveBookings` (Step 6), credit
  debit → `adjustIndividualCredits` (Step 2), `cancel()`'s ownership check →
  `canManageBooking` (Step 3-resumed), refund/promotion-charge → `adjustIndividualCredits`
  (Step 2), promotion-candidate query → `findOldestWaitlistedBooking` (Step 7). `desc`
  import removed as orphaned by the `hoursUntil`/`activeMembershipFor` extraction.
- `corporate-bookings.ts` — mirror-image attribution to Steps 3, 3-resumed, 5, 6, 7.
  `sql` import removed, orphaned by Step 6 (confirmed via grep its only prior use was
  the extracted count query).
- `reschedules.ts` — attributes to Steps 1, 3, 8/admin-numbering (reduced 382→~148
  lines; both `reschedule` and `validateReschedule` now call
  `validateRescheduleRequest`). `and` import removed, orphaned (its only use was inside
  the deleted, previously-dead local `activeMembershipFor`).
- `admin.ts` — attributes entirely to Step 4 (268→43 lines; thin composition, every
  procedure name/input schema/authorization wrapper unchanged).

No unattributed lines were found in any of the 4 modified files.

## C. Architectural improvements

- **`src/server/domain/`** now holds pure, I/O-free calculation and predicate
  functions (`adjustIndividualCredits`, `adjustCorporatePool`, `canManageBooking`,
  `hoursUntil`) alongside small typed data-access helpers that return raw rows/counts
  (`activeMembershipFor`, `countActiveBookings`, `findOldestWaitlisted*`,
  `validateRescheduleRequest`). The domain layer is organized by concept
  (`booking/`, `membership/`, `corporate/`, `reschedule/`, `shared/`), not by router,
  which matches how the plan intended callers on both the individual and corporate
  side to independently import from a shared vocabulary without being forced to share
  implementations.
- **`src/server/routers/`** keeps all authorization, error-throwing, and orchestration
  (the sequence of guard checks, what happens on success/failure, which tables get
  written) inline at the call site. This was a deliberate, consistently-applied line:
  domain functions never throw `TRPCError`, never decide *whether* to act, only *what
  the result of acting would be*. Every router file was left responsible for its own
  control flow.
- **`admin.ts` / `admin/`** — the router file is now a pure procedure-shape
  declaration (input schema + `adminProcedure` wrapper + a one-line delegate call).
  Query bodies are grouped by the admin page that actually consumes them
  (`dashboard.ts`, `revenue-reports.ts`, `attendance-reports.ts`), which is a more
  legible grouping than the original single 268-line file but does not change the
  `admin.*` client-facing namespace at all — every original procedure name, input
  shape, and authorization level is unchanged.

Net effect: call sites got shorter and less repetitive; no behavior moved out of the
routers into the domain layer except pure arithmetic/predicates/read-only queries.

## D. Behavioral parity evidence

Full suite for this review pass: **189/189 tests passing, 30/30 test files**,
verbose reporter, run immediately before this document was written.

Per-finding walkthrough (not just "tests pass" — each one's exact code path and
observable value was traced through the current source):

- **BUG-001** (individual/corporate capacity never shared) — `countActiveBookings` is
  called once per router with its own table hardcoded at the call site
  (`bookings` in `bookings.ts:110`, `corporateBookings` in
  `corporate-bookings.ts:132`); the two counts are never combined. `tests/corporate/cross-capacity.test.ts` passes, confirming a corporate booking still succeeds after the class is full via individual bookings and vice versa.
- **BUG-002** (same member can hold both an individual and corporate booking for one
  class) — the "already on the list" check in each `book()` only queries its own
  table (`bookings` vs `corporateBookings`); nothing was added to cross-check the
  other table. Test passes.
- **BUG-003** (rescheduling a waitlisted booking into an open class charges nothing) —
  `validateRescheduleRequest` only validates eligibility and returns `targetIsFull`;
  the actual `creditsUsed: 0` assignment on promotion still lives in
  `reschedules.ts`'s own insert/update logic, untouched by the extraction. Test
  passes with the same "creditsUsed=0" assertion as before.
- **BUG-004** (double credit deduction on promotion of a rescheduled-into-full-class
  booking) — same reasoning as BUG-003; the charge-on-promotion code path was never
  touched by Step 1, it lives entirely in `bookings.ts`/`corporate-bookings.ts`'s
  `cancel()`. Test passes.
- **BUG-005** (`classes.cancel` side effects — no refund, doesn't touch waitlisted or
  corporate bookings, no notification) — this code path lives in `classes.ts`, never
  touched by any Phase 4 step. Test passes unchanged.
- **BUG-006** (checking in before class start opens a phantom seat because
  `countActiveBookings`/`classUtilisation` count `status='booked'`, and
  `markAttended` moves status to `attended`) — `countActiveBookings`'s `WHERE`
  clause (`domain/booking/capacity.ts:26`) was copied verbatim:
  `eq(table.status, "booked")`, and `getClassUtilisation`
  (`routers/admin/dashboard.ts`) still uses the same `status in ('booked','attended')`
  SQL condition as the original inline query. Test passes.
- **BUG-007** (member linked to two active companies — exactly one is charged,
  deterministically but by no documented rule) — `getCompanyForMember` in
  `corporate-bookings.ts` was never touched by any step; its `.get()` (first-row)
  selection semantics are exactly as before. Test passes.
- **BUG-008** (ambiguous member lookup returns exactly one match) — lives in
  `members.ts`/kiosk lookup code, never touched by Phase 4. Test passes.
- **BUG-009** (`members.byId`'s membership ordering disagrees with the booking
  engine's) — `activeMembershipFor` (`domain/membership/active-membership.ts`) orders
  by `desc(memberships.endDate)`, copied verbatim from the original inline query; the
  disagreement with `members.byId`'s separate ordering (by `startDate desc`, in
  untouched code) is exactly preserved because neither ordering was changed nor
  unified. Test passes.
- **BUG-010** (member can hold two simultaneous active memberships; booking always
  draws from the furthest `endDate`) — same `activeMembershipFor` function, same
  `.get()` single-row selection over `orderBy(desc(endDate))`. Test passes, including
  the tie-break case (two active memberships with identical `endDate`).
- **DATA-001** (two concurrent bookings for the last seat can both succeed) —
  `countActiveBookings` performs the exact same non-atomic
  `SELECT count(*) ... WHERE status='booked'` read that existed inline before, with
  no added locking/transaction/serialization. Concurrency test (two independent
  `@libsql/client` connections) passes, reproducing the overbook.
  Note: this test was NOT rerun 5× in this review pass beyond the single full-suite
  run — the 5× reruns were performed and recorded during Step 6 itself
  (which is the step that touched this exact code path); this review's single run is
  consistent with those results.
- **DATA-002** (two concurrent refunds onto the same membership — one is lost) — the
  refund path (`ctx.db.update(memberships).set({ creditsRemaining:
  adjustIndividualCredits(...) })`) still does a read-then-write with no transaction;
  `adjustIndividualCredits` is pure arithmetic, it doesn't change the read-then-write
  race shape at all. Test passes, confirming the lost-update race still reproduces.
- **DATA-003** (two concurrent duplicate-booking attempts by the same user both
  succeed) — the "already on the list" existence check in `book()` is still a
  plain `SELECT` with no locking, untouched by any extraction. Test passes.
- **DUP-005** (individual promotion shortfall floors to zero; corporate promotion
  shortfall skips the debit entirely) — `adjustIndividualCredits` and
  `adjustCorporatePool` are two independent functions with no shared implementation
  and no cross-calls (confirmed via grep in section E below); the guard that decides
  *whether* to call `adjustCorporatePool` at all
  (`if (company && company.creditPoolBalance >= row.cls.creditCost)` in
  `corporate-bookings.ts:237`) was preserved exactly, while `bookings.ts`
  unconditionally calls `adjustIndividualCredits(..., true)` and lets the floor do the
  work. Both directional tests pass:
  `tests/corporate/corporate-waitlist-promotion.test.ts` (pool left unchanged when it
  can't cover the cost) and `tests/waitlist/waitlist-promotion.test.ts` (individual
  shortfall floored to zero).

## E. Known bugs preserved — explicit confirmation

Grep-verified during this review (not just inferred from passing tests):

```
adjustIndividualCredits is imported/called only in bookings.ts
adjustCorporatePool is imported/called only in corporate-bookings.ts
No function takes a `typeof bookings | typeof corporateBookings` union except
  countActiveBookings, which returns a bare number and never combines counts
  across the two tables it's called with
domain/corporate/credit-pool.ts and domain/membership/credits.ts import nothing
  from each other
```

Combined with the per-finding walkthrough in section D, all 10 BUG findings, all 3
DATA findings, and DUP-005 reproduce identically to the pre-Phase-4 baseline. Nothing
was fixed, floored differently, reordered, or made atomic.

## F. Remaining test-coverage gaps

This is a non-inflated caveat — 189/189 passing does not mean 100% of the codebase's
behavior is characterized.

**Strongly protected** (exact-value assertions on the specific code paths Phase 4
touched): individual/corporate booking golden paths, cancellation + refund +
promotion-charge flows, capacity boundary behavior, reschedule validation sequence
and error codes, admin dashboard/report/attendance query results, all 14 named
BUG/DATA/DUP findings.

**Indirectly protected** (exercised as a side effect of other tests, not the direct
subject of an assertion): `activeMembershipFor`'s tie-break ordering is only directly
asserted for BUG-010's two-membership case, not for every possible multi-membership
shape; `canManageBooking`'s trainer-can-manage-anyone's-booking branch is covered by
the existing authorization suite but not fuzzed against every role combination.

**Weakly covered**: the admin sub-router split (`admin/dashboard.ts`,
`revenue-reports.ts`, `attendance-reports.ts`) is covered by the pre-existing
`admin-stats.test.ts` and `admin-authorization.test.ts`, but several individual
report endpoints (`revenueByMonth`, `revenueByMethod`, `expiringMemberships`,
`refundCount`, `checkinsPerDay`, `topTrainers`, `noShowList`) have no dedicated
exact-value characterization test of their own — they were verified in Phase 4 only
via the line-by-line diff proving the SQL was copied verbatim, not via a new test
asserting their output against a fixture.

**Currently uncovered**: no test exists that calls the domain functions directly
(unit-level) — all coverage is through the router integration tests via
`createCaller`. This means a hypothetical future change that broke a domain
function's behavior in a way that happened to cancel out at a specific router call
site could theoretically pass the suite; this risk is low given the functions are
each called from only one or two call sites total, but it is not zero.

## G. Deferred Step 10

Step 10 (shared cancellation orchestration — unifying the individual and corporate
`cancel()` handlers' overall sequence into one orchestrating function) remains
deferred, untouched, exactly as after the earlier ambiguity resolution.

Rationale, reconfirmed here: the two `cancel()` handlers are structurally similar
(fetch → authorize → status-check → compute refundability → cancel → conditionally
refund → conditionally promote) but operate over different tables, different payer
types (membership vs. company pool), and — per DUP-005 — genuinely different
shortfall semantics on the promotion-charge step. Steps 2/3/5/6/7 already extracted
every piece of *actually* duplicated logic inside that sequence (the guard predicate,
the arithmetic, the capacity count, the candidate lookup). What's left is the
orchestration glue itself, and unifying that would require either a generic
"payer" abstraction (explicitly ruled out by the user for Step 5) or a
conditional-branching orchestrator whose complexity would likely exceed the ~15 lines
of duplication it would remove in each router. No evidence surfaced during Steps 1–9
suggesting the current duplication is a source of bugs or maintenance friction beyond
what was already addressed by the extractions that did happen. This remains a
judgment call to defer, not a finding that Step 10 is unsafe — but no compelling
evidence emerged to justify doing it now.

## H. Pre-existing issues (not introduced by, and not fixed by, Phase 4)

- `tests/helpers/caller.ts:14` — `Type 'string | null' is not assignable to type
  'string | undefined'`. Present in `npx tsc --noEmit` before, during, and after
  every Phase 4 step; the file was never touched. This also surfaces as a `pnpm build`
  failure, since Next's production build type-checks the `tests/` directory. Left
  untouched per explicit instruction.
- No ESLint config exists in the repo (`next lint` prompts to interactively scaffold
  one rather than running against an existing config). Lint was not run, since doing
  so would have meant creating a new config file — out of scope for a read-only
  review.
- `pnpm build` was run (no `pnpm dev` process was found running) and fails solely on
  the pre-existing `caller.ts` error above — compilation of all application code
  (`Compiled successfully in 5.7s`) succeeded before the type-check phase hit that
  file.

## I. Overall assessment

All 9 planned refactoring steps are complete, individually verified at the time each
was executed, and reconfirmed here as a whole: diff attribution is clean across all 4
modified and 11 new files, the full 189-test suite passes, every one of the 14 named
audit findings (BUG-001–010, DATA-001–003, DUP-005) was traced through the current
code and confirmed to reproduce identically, individual and corporate logic remain
fully independent (grep-confirmed, no shared calls), `tsc --noEmit` shows no new
errors, and the only build/type-check failure is the pre-existing, out-of-scope
`caller.ts` issue. Step 10 remains deferred with a documented rationale rather than
either being silently skipped or executed without justification. Test-coverage gaps
are disclosed rather than papered over.

**Final verdict: READY FOR SUBMISSION REVIEW**
