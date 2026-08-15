# FlexFit Studio — Refactoring Architecture Plan (Phase 3)

**Status: PLANNING ONLY. No production code has been modified to produce this
document.** Every claim below was checked against the current contents of
`src/server/routers/*.ts` and `src/server/trpc.ts` (re-read in full immediately
before writing this plan — line numbers cited match the files as they exist today).

This plan assumes the Phase 1 audit, Phase 2 characterization suite (189 tests,
30 files), and Phase 2B gap-closing pass as its safety net. Every proposed step
below names the tests that would catch a behavioral regression, and every step
that touches a file with an open BUG-*/DATA-*/DUP-* finding says explicitly
that the finding must still reproduce identically afterward.

---

## 0. Reading order for this document

1. §1–2: what's actually wrong, classified so we don't "fix" things that aren't bugs
2. §3: the corporate/individual decision — read this one carefully, it's the crux
3. §4–8: domain-by-domain analysis
4. §9: the bugs we will not touch, named explicitly
5. §10–12: target structure, dependency shape, and the actual step-by-step order
6. §13–15: risk matrix, preserved-behavior checklist, final recommendation

---

## 1. Method

Re-read in full for this plan: `bookings.ts`, `corporate-bookings.ts`,
`reschedules.ts`, `admin.ts`, `classes.ts`, `trpc.ts`, `trainers.ts`, `members.ts`
(plus `payments.ts`, `notifications.ts`, `plans.ts`, `admin-companies.ts` carried
over from the still-current Phase 1/2B reads, since `git diff --stat -- src/` has
been empty at every checkpoint since Phase 1). Nothing below is a "generic clean
architecture" recommendation — every extraction is tied to a specific block of
code quoted with its file and line numbers.

---

## 2. Highest-value targets, classified

Per the task's A/B/C/D framework — **do not assume every duplicate line should be
extracted**:

| Pattern | Where | Classification | Why |
|---|---|---|---|
| `hoursUntil(iso, now)` | `bookings.ts:16-18`, `corporate-bookings.ts:20-22`, `reschedules.ts:18-20` | **C — accidental** | Byte-identical 3-line pure function, 3 copies. Zero reason for 3 copies to exist. |
| `activeMembershipFor(db, userId)` | `bookings.ts:20-37`, `reschedules.ts:22-39` | **C — accidental** | Byte-identical 17-line function, 2 copies. |
| Cancel ownership check (`isOwner \|\| isStaff`) | `bookings.ts:172-179`, `corporate-bookings.ts:181-188` | **C — accidental** | Byte-identical. |
| Capacity count query *shape* (`count(*) where classId=X and status='booked'`) | `bookings.ts:127-134`, `corporate-bookings.ts:131-141`, `reschedules.ts:163-170` and `:367-374` | **C — the SQL pattern is accidental duplication** | Same query shape, 5 call sites. |
| Capacity count being *two separate tables with no cross-check* | same call sites | **B — currently intentional (or at minimum, unresolved) design, NOT a duplication problem to fix here** | This is BUG-001. Unifying the count across tables would fix the bug. Out of scope. |
| "Already on the list" duplicate-booking check *shape* | `bookings.ts:92-109`, `corporate-bookings.ts:96-113` | **C — accidental** | Same query shape. |
| That check never looking at the *other* table | same | **B/unresolved — this is BUG-002, not a refactor target** | |
| Free-cancellation refund formula *shape* (`hoursUntil >= THRESHOLD && creditsUsed > 0`) | `bookings.ts:188-190`, `corporate-bookings.ts:197-199` | **A — genuinely shared shape** | Safe to parameterize by threshold. |
| Free-cancellation *threshold value* (12h vs 24h) | `FREE_CANCELLATION_HOURS` vs `CORPORATE_FREE_CANCELLATION_HOURS` | **B — intentional, preserve exactly** | Named, commented, different constants. Do not unify. |
| Waitlist-promotion candidate query (oldest `waitlisted` row) | `bookings.ts:214-224`, `corporate-bookings.ts:226-236` | **A — genuinely shared shape** | Identical `orderBy(asc(bookedAt))` pattern, safe to parameterize by table. |
| Waitlist-promotion credit-shortfall handling (floor-to-zero vs skip-if-insufficient) | `bookings.ts:239-249` vs `corporate-bookings.ts:250-260` | **B — unresolved, must NOT be unified (DUP-005)** | Now proven distinguishable by the Phase 2B tests. Merging these is a behavior change requiring a product decision, not a refactor. |
| Unlimited-credit sentinel (999) | individual only | **Not duplication at all — a genuine asymmetry.** Corporate has no equivalent concept. | Any shared "payer" abstraction must not assume this exists on both sides. |
| `reschedule` vs `validateReschedule` (~130 lines) | `reschedules.ts:49-160` vs `:260-374` | **C — accidental, extreme case** | Copy-pasted twice *in the same file*, same order, same messages, one throws and one returns. |
| `trainers.ts` role check (`role !== "trainer"`) | lines 9-14, 39-44, 64-69, 109-114 | **C — accidental** | 4 copies of the same guard, in a codebase that already has `staffProcedure`/`adminProcedure` middleware it could reuse. |
| Intra-file credit-guard (`if (ms.creditsRemaining < UNLIMITED_CREDITS) update...`) | `bookings.ts:148-153` (debit), `:204-209` (refund), `:239-249` (promotion charge) | **A — genuinely shared, same file, same table** | The single cleanest extraction in the codebase — not even cross-file. |
| `corporateBookings.markAttended` inserting `checkins` with `bookingId: null` | `corporate-bookings.ts:296-299` | **B — forced by schema, not an app-logic choice** | `checkins.bookingId` only has an FK to `bookings`. Fixing this needs a schema change (ARCH-008), explicitly out of scope this phase. |
| `admin.ts`'s 8 reporting queries | `admin.ts:15-267` | **D — should stay as individual, un-abstracted queries** | Each is shaped for one specific dashboard tile; nothing else in the app reuses any of them. A shared "repository" here adds indirection, not DRY. |
| `classes.list`'s "booked" definition (status='booked' only) vs `admin.classUtilisation`'s (status in booked,attended) | `classes.ts:36-40` vs `admin.ts:72-76` | **B/unresolved — this divergence *is* BUG-006's root cause** | Do not normalize these to the same definition during a refactor; that silently fixes/changes BUG-006. |

---

## 3. Corporate vs. individual booking — the central decision

**Do not merge `bookings.ts` and `corporate-bookings.ts`.** Below is exactly what's
shared, what's different, and why forcing them into one abstraction would either
break something or paper over an unresolved bug.

### 3.1 What's genuinely shared (safe to extract, Category A/C)

| Concern | Individual | Corporate | Verdict |
|---|---|---|---|
| Class validity checks in `book()` (not found / cancelled / already started) | `bookings.ts:76-90` | `corporate-bookings.ts:80-94` | **Identical, including exact messages.** Extractable as one function both call. |
| Duplicate-booking check *shape* | `bookings.ts:92-109` | `corporate-bookings.ts:96-113` | Identical shape, different table. Extractable as a parameterized query, called once per table. |
| Capacity count *shape* | `bookings.ts:127-134` | `corporate-bookings.ts:131-141` | Same as above. |
| Cancel: not-found / ownership / status-active checks | `bookings.ts:161-186` | `corporate-bookings.ts:170-195` | Identical. Extractable. |
| Cancel: refund-eligibility formula | `bookings.ts:188-190` | `corporate-bookings.ts:197-199` | Same shape, different threshold constant — extract the *shape*, keep the *constants* separate and named. |
| Cancel: promotion candidate lookup | `bookings.ts:214-224` | `corporate-bookings.ts:226-236` | Same shape, different table. |
| `markAttended`: not-found / status-must-be-booked / flip-to-attended | `bookings.ts:265-284` | `corporate-bookings.ts:275-294` | Identical. |

### 3.2 What's intentionally different (Category B — must NOT be unified)

| Concern | Individual | Corporate | Why it must stay different |
|---|---|---|---|
| Payer resource | one `memberships` row per user, has its own `creditsRemaining` | one `companies` row shared by every linked employee | Fundamentally different cardinality — one is instance-scoped, one is org-shared. A generic "payer" interface has to model this difference, not erase it. |
| Unlimited concept | `creditsRemaining >= 999` sentinel exists (`UNLIMITED_CREDITS`, `bookings.ts:14`) | **does not exist** | Corporate pools are always metered. Forcing a shared interface that includes "is this payer unlimited?" would require inventing a concept for corporate that isn't in the code today. |
| Free-cancellation window | 12h (`FREE_CANCELLATION_HOURS`) | 24h (`CORPORATE_FREE_CANCELLATION_HOURS`) | Confirmed deliberate in Phase 1 audit (named, commented constants) and locked in by Phase 2B boundary tests. |
| Promotion credit-shortfall handling | always debits, floored at 0 (`Math.max(0, remaining - cost)`, `bookings.ts:243-246`) | debits only if `balance >= cost`, otherwise skipped entirely (`corporate-bookings.ts:250-259`) | This is DUP-005 — an *unresolved* business question (`docs/open-questions.md` #9). Unifying either direction is a behavior change, not a refactor. |
| Capacity pool | counts only the `bookings` table | counts only the `corporateBookings` table | This is BUG-001. The "fix" (count both tables together) is explicitly a bug fix, not a refactor, and is out of scope. |
| Duplicate-booking scope | only sees other `bookings` rows | only sees other `corporateBookings` rows | This is BUG-002, same reasoning. |
| `mine` query shape | no `companyName` join | joins `companies` for `companyName` | Different response shape members/companies actually consume; not reconcilable without an API shape change. |
| `markAttended`'s `checkins` insert | `bookingId: booking.id` | `bookingId: null` (schema has no FK slot for `corporateBookings`) | ARCH-008 — a schema limitation, not an app decision. Schema changes are out of scope this phase. |
| Authorization tier | `protectedProcedure` / `staffProcedure` | same middleware, same tiers | **Actually identical** — both already import the same `protectedProcedure`/`staffProcedure` from `trpc.ts`. No divergence here; nothing to fix. |

### 3.3 The proposed abstraction (smallest one that's actually safe)

**Do not build a single polymorphic "payer" service that both routers call.**
The asymmetries above (unlimited concept, floor-vs-skip, and — critically — the
two open bugs whose *entire nature* is "this thing isn't shared across tables
when arguably it should be") mean a generic interface would have to either leak
payer-specific branches into itself (defeating the abstraction) or silently
normalize DUP-005/BUG-001/BUG-002 in the process of writing it.

Instead, two tiers:

**Tier 1 — extract the shared shapes, called once per table/constant (LOW risk):**

```ts
// src/server/domain/booking/capacity.ts
export async function countActiveBookings(
  db: Db,
  table: typeof bookings | typeof corporateBookings,
  classId: number,
): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(table)
    .where(and(eq(table.classId, classId), eq(table.status, "booked")));
  return Number(count);
}
```
`bookings.ts` calls `countActiveBookings(ctx.db, bookings, cls.id)`.
`corporate-bookings.ts` calls `countActiveBookings(ctx.db, corporateBookings, cls.id)`.
**Neither call site changes which table it queries — BUG-001 reproduces identically
afterward.** This removes the *duplicated SQL shape* without touching the *fact*
that the two counts never see each other.

**Tier 2 — keep payer-specific arithmetic as two separate, explicitly-named
functions (not a shared interface):**

```ts
// src/server/domain/membership/credits.ts
export function adjustIndividualCredits(remaining: number, delta: number, floor: boolean): number { ... }

// src/server/domain/corporate/credit-pool.ts
export function adjustCorporatePool(balance: number, cost: number): { newBalance: number; debited: boolean } { ... }
```
These are **not** the same function and must not be merged, because their
current behavior genuinely differs (DUP-005). Keeping them as two small,
separately-tested, honestly-named functions is more honest than a shared
interface with an `if (payerType === "corporate")` branch buried inside it.

**BEHAVIORAL RISK — REQUIRES EXPLICIT DECISION:** any future change that makes
these two functions produce the same output for the same shortfall scenario is
a fix to DUP-005, not a refactor. Flag and get sign-off before doing it.

---

## 4. Booking domain — what's actually mixed together

Looking at `bookings.ts` `book()` (lines 67-156) and `cancel()` (lines 158-255),
each function currently fuses several genuinely different responsibilities in
one body. For each candidate module, the test below is: *what responsibility
does this own that's currently mixed with another responsibility?*

| Proposed module | Responsibility it would own | Currently mixed with | Verdict |
|---|---|---|---|
| `domain/shared/time.ts` (`hoursUntil`) | "how far away is this ISO timestamp" | class-cancelled check, capacity check, refund check — all inline in the same function bodies that also do DB I/O | **Extract.** Pure, zero risk. |
| `domain/membership/active-membership.ts` (`activeMembershipFor`) | "which membership row is currently usable for this user" | booking creation, reschedule validation | **Extract.** Already byte-identical in 2 files (DUP-002). |
| `domain/booking/authorization.ts` (`canManageBooking`) | "can this user manage this booking" (ownership OR staff) | cancel's status check, refund calc — all inline | **Extract.** Pure predicate, byte-identical in 2 files. |
| `domain/booking/capacity.ts` (`countActiveBookings`) | "how many confirmed seats does this class have" | booking creation's full/waitlist decision | **Extract the query, not the "is full" comparison** (`count >= capacity` is a one-liner; extracting a 1-line comparison into its own module is over-engineering — Category D). |
| `domain/booking/waitlist.ts` (`findOldestWaitlisted`) | "who's next in line for this class" | promotion charging, which must stay separate per §3.2 | **Extract the query only.** |
| `domain/membership/credits.ts` (`adjustIndividualCredits`) | "apply a credit delta to a membership, respecting the unlimited sentinel" | duplicated 3x *within `bookings.ts` itself* (debit on book, refund on cancel, charge on promotion) | **Extract — highest-confidence extraction in this plan.** Same file, same table, same guard, proven identical by direct comparison. |
| `domain/reschedule/validate.ts` | "is this reschedule request currently allowed, and why not if not" | duplicated verbatim across `reschedule` and `validateReschedule` | **Extract.** See §8. |

**What should NOT become its own module (Category D):**

- The `book()` and `cancel()` orchestration bodies themselves (fetch → validate →
  decide → write → conditionally write again). Turning these into "services"
  would mostly relocate code without removing real duplication, and the *order*
  of the `await`s inside them is exactly what DATA-001/DATA-002/DATA-003
  characterize. Reordering or re-wrapping that sequence — even while preserving
  "the same logic" — can change the race window the concurrency tests measure.
  This is flagged as optional/deferred in §12 (Step 10), not part of the core plan.
- A generic "BookingService" or "CorporateBookingService" class. Nothing here
  needs object-oriented state; every extraction above is a plain function.

---

## 5. Router responsibility boundaries

What's actually in the routers today, checked against the code:

| Concern | Where it lives now | Should it move? |
|---|---|---|
| Input validation (zod schemas) | Every router, e.g. `bookings.ts:68`, `reschedules.ts:43-47` | **Stays in the router.** This is tRPC's own boundary and is already well-factored — zod schemas are colocated with the procedure they validate, which is correct and idiomatic. |
| Role/session authorization | Procedure-level middleware (`protectedProcedure`/`staffProcedure`/`adminProcedure`, `trpc.ts:39-58`) | **Stays exactly where it is.** This is already correctly centralized — the one place it *isn't* centralized is `trainers.ts`'s 4 hand-rolled `role !== "trainer"` checks (Category C, see §2), which should call a new `trainerProcedure` middleware alongside the existing three, not be extracted into "domain" logic. |
| Ownership authorization (`isOwner \|\| isStaff`) | Inline in `cancel()`, both routers | **Extract as a domain predicate** (§4) — this is data-dependent (needs the fetched booking row), not role-based, so it doesn't fit the existing middleware pattern, but it's still small enough to be a pure function, not a "service." |
| Business rules (capacity, refund eligibility, credit sufficiency, reschedule validity) | Inline in router mutation bodies | **Extract the pure/parameterizable pieces** (§4), per the A/C entries in §2's table. Leave the B/D entries inline exactly as they are. |
| Database queries | Inline via `ctx.db`, every router | **Mostly stays.** See §6 for which specific queries are worth extracting. |
| Response shaping (e.g. `spotsLeft`/`full` computed fields in `classes.list`, `classes.ts:47-51`) | Inline, small `.map()` calls | **Stays.** These are one-liners tightly coupled to one procedure's response shape; extracting them buys nothing. |
| Orchestration (the sequence of reads/writes in `book`/`cancel`/`reschedule`) | Inline in each mutation | **Stays inline**, per §4's "what should NOT become its own module." |

**The target is not "move everything into services."** After this plan, routers
still directly call `ctx.db` for anything not identified above as duplicated —
`classes.list`'s bespoke select, `admin.ts`'s 8 one-off reports, `members.search`,
etc. all stay exactly as they are.

---

## 6. Database access — where a shared helper is justified, where it isn't

**No repository layer.** The app has 14 tables and ~5,500 lines total; most
queries are single-purpose and already shaped for exactly one response. A
generic `BookingRepository`/`ClassRepository` would mean either:
(a) writing one-off methods that don't reduce any actual duplication (busywork), or
(b) tempting a "let's make this the one canonical query" cleanup that silently
changes behavior (see the `classes.list` vs `admin.classUtilisation` "booked"
definition divergence in §2 — a repository's `findBookedCount()` method would
force a decision between the two that isn't ours to make).

**Justified extractions (the same query, same purpose, 2+ files — Category A/C
from §2):**
- `countActiveBookings` (5-6 call sites across 3 files)
- `findOldestWaitlisted` (2 call sites)
- `activeMembershipFor` (2 call sites, byte-identical)
- `hoursUntil` (3 call sites, byte-identical)

**Not justified (Category D):**
- `admin.ts`'s 8 reporting queries — each is a one-off shaped for one dashboard
  tile (`stats`, `classUtilisation`, `revenueByMonth`, `revenueByMethod`,
  `expiringMemberships`, `refundCount`, `checkinsPerDay`, `topTrainers`,
  `noShowList`). Nothing else in the app touches any of these query shapes.
- `classes.ts`'s `list`/`byId` roster queries — different column sets, different
  filter semantics, single call site each.
- `members.ts`'s `search`/`lookupByEmailOrPhone` — audit already found these have
  *different* role-filtering rules (§6 of the Phase 1 audit); unifying them into
  one repository method would risk erasing that difference.

---

## 7. Admin router

`admin.ts` (268 lines, one `adminRouter` object) currently bundles 9 procedures
that fall into three groups **defined by which page actually calls them** (this
is not an invented boundary — it's the existing consumption pattern):

| Group | Procedures | Consumed by |
|---|---|---|
| Dashboard | `stats`, `classUtilisation` | `src/app/admin/page.tsx` |
| Financial reporting | `revenueByMonth`, `revenueByMethod`, `expiringMemberships`, `refundCount` | `src/app/admin/reports/page.tsx` |
| Attendance reporting | `checkinsPerDay`, `topTrainers`, `noShowList` | `src/app/admin/attendance/page.tsx` |

**Recommendation:** split the *file*, not the *API*. Move each group's query
bodies verbatim into `src/server/routers/admin/dashboard.ts`,
`.../revenue-reports.ts`, `.../attendance-reports.ts` as plain exported async
functions taking `db` and (where needed) input — then compose them back into one
`adminRouter` object in `admin.ts` (or `admin/index.ts`). tRPC's `router()` just
takes a plain object of procedures; nothing requires them to be defined in one
file. **Client-facing calls (`admin.stats()`, `admin.classUtilisation()`, etc.)
do not change at all** — this is a pure file-organization move with zero
behavioral surface.

This is *not* a "should reporting be its own router" decision — `admin.*` stays
the one tRPC namespace clients already call. It's purely: the 268-line file is
low-cohesion (9 unrelated read-only queries), and the three groups above are a
real, already-observable seam (three different pages consume three different
subsets), not an invented one.

---

## 8. Rescheduling

`reschedules.ts`'s `reschedule` mutation (lines 49-217) and `validateReschedule`
query (lines 260-380) run an **identical 8-step check sequence**, in the same
order, with the same error/reason strings, for ~130 lines each:

1. booking exists (`NOT_FOUND "Booking not found."`)
2. ownership (`FORBIDDEN "You cannot reschedule this booking."`)
3. booking still active (`BAD_REQUEST "This booking is no longer active."`)
4. ≥4h before original start (`BAD_REQUEST "You can only reschedule up to 4 hours..."`)
5. target class exists (`NOT_FOUND "Target class not found."`)
6. target has the same name (`BAD_REQUEST "You can only reschedule to a class with the same name."`)
7. target isn't the same class (`BAD_REQUEST "You are already booked for this class."`)
8. target hasn't started / isn't cancelled / no existing booking on target

**Proposed extraction:** one function in `domain/reschedule/validate.ts` that
runs checks 1-8 and returns a discriminated result:

```ts
type RescheduleCheck =
  | { valid: true; original: {...}; target: {...}; targetIsFull: boolean }
  | { valid: false; code: TRPCErrorCode; reason: string };
```

`reschedule` calls it and throws `new TRPCError({code, message: reason})` on
`valid: false`. `validateReschedule` calls it and returns `{valid: false, reason}`
directly (dropping `code`, matching its current return shape exactly — it never
exposed a `code` field). **The check order and every message string must be
copied verbatim** — this function is not an opportunity to reword anything.

**What this extraction does NOT touch:** the actual booking creation logic after
validation passes (lines 181-210) — the insert, the original-booking cancellation,
and the `reschedules` history row. This is deliberate: **BUG-003 and BUG-004 live
entirely in that untouched section** (the `creditsUsed: originalBooking.creditsUsed`
carry-forward with no charge, and the resulting invariant violation on a
waitlisted-with-nonzero-credits row). Extracting only the validation half keeps
the bug's exact reproduction path (`tests/reschedule/reschedule-credits.test.ts`)
completely undisturbed — those tests exercise the code *after* validation passes,
which isn't moving.

**Duplication with the booking domain** (not just self-duplication): `reschedules.ts`
also re-defines `hoursUntil` (lines 18-20, identical to `bookings.ts`) and
`activeMembershipFor` (lines 22-39, identical to `bookings.ts`) — both already
covered by the Tier-1 extractions in §3.3/§4. Note the reschedule flow fetches
`activeMembershipFor`-equivalent data (line 173-179, "Get the membership to check
for unlimited credits") **but the result is never used** — this dead variable is
itself evidence supporting BUG-003/004 (see Phase 1 audit, ARCH-010). **Do not
delete this dead variable during the extraction** unless deliberately preserving
it produces bizarre code — if it must move, keep it inert exactly as before,
since removing it entirely could be interpreted as "cleaning up" in a way that
nudges toward fixing BUG-003.

---

## 9. Bugs vs. refactoring — explicit boundary

None of the following change during this refactor. Each has a test file that
must still assert the buggy/suspicious behavior identically after every step in
§12.

| ID | Must still reproduce via | Refactor steps that touch this code path |
|---|---|---|
| BUG-001 | `tests/corporate/cross-capacity.test.ts` | Step 6 (capacity query extraction) — table parameter stays hardcoded per call site |
| BUG-002 | `tests/corporate/cross-capacity.test.ts` | Step 3/6 (duplicate-check, capacity extraction) — no cross-table check added |
| BUG-003 | `tests/reschedule/reschedule-credits.test.ts` | Step 8 (reschedule validation extraction) — post-validation code untouched |
| BUG-004 | `tests/reschedule/reschedule-credits.test.ts` | Step 8 — same |
| BUG-005 | `tests/admin/admin-class-cancellation.test.ts`, `tests/notifications/notifications.test.ts` | Not touched by any step in this plan (classes.ts `cancel` isn't refactored here) |
| BUG-006 | `tests/booking/capacity.test.ts`, `tests/checkin/checkin-attendance.test.ts` | Not touched — `classes.list`/`admin.classUtilisation`'s differing "booked" definitions are explicitly left unreconciled (§2) |
| BUG-007 | `tests/corporate/multi-company.test.ts` | Not touched — `getCompanyForMember` isn't part of this plan |
| BUG-008 | `tests/kiosk/kiosk-lookup.test.ts` | Not touched |
| BUG-009 | `tests/kiosk/kiosk-lookup.test.ts` | Not touched — `members.byId` isn't part of this plan |
| BUG-010 | `tests/membership/plans-subscribe.test.ts`, `tests/membership/membership-selection.test.ts` | Step 2 (`activeMembershipFor` extraction) — selection logic copied verbatim, no uniqueness guard added |
| DATA-001 | `tests/concurrency/concurrent-booking.test.ts` | Step 6 — extracting the query shape must not add a transaction or lock; re-run concurrency suite 5x after this step specifically |
| DATA-002 | `tests/concurrency/concurrent-credit.test.ts` | Step 4/5 (credit-adjustment extraction) — same caution, re-run 5x |
| DATA-003 | `tests/concurrency/concurrent-duplicate-booking.test.ts` | Step 3/6 — same caution |
| DUP-005 | `tests/waitlist/waitlist-promotion.test.ts`, `tests/corporate/corporate-waitlist-promotion.test.ts` | Step 5 — the two credit functions must remain behaviorally distinct; this is the plan's single highest-attention item |

**Rule for every step in §12:** if a step's diff would make any row in this table
stop reproducing, that step is out of scope for this refactor and must be
flagged as **BEHAVIORAL RISK — REQUIRES EXPLICIT DECISION** instead of executed.

---

## 10. Proposed target structure

```
src/
  app/                        # unchanged
  components/                 # unchanged
  db/                         # unchanged — no schema changes this phase
  lib/                        # unchanged — format.ts, password.ts, trpc.ts (client)
  server/
    trpc.ts                   # unchanged — middleware stays exactly as-is
    routers/
      _app.ts                 # unchanged — same procedure tree, same names
      auth.ts                 # unchanged (no findings in scope)
      bookings.ts             # thinner — imports from domain/, orchestration stays inline
      corporate-bookings.ts   # thinner — imports from domain/, orchestration stays inline
      reschedules.ts          # thinner — both procedures call domain/reschedule/validate.ts
      classes.ts              # unchanged
      members.ts               # unchanged
      trainers.ts              # unchanged except adopting a new trainerProcedure from trpc.ts
      payments.ts               # unchanged
      plans.ts                  # unchanged
      notifications.ts          # unchanged
      admin/                      # NEW — internal split, one router composed from three files
        dashboard.ts               # stats, classUtilisation
        revenue-reports.ts         # revenueByMonth, revenueByMethod, expiringMemberships, refundCount
        attendance-reports.ts      # checkinsPerDay, topTrainers, noShowList
      admin.ts                    # becomes a thin composition: router({...dashboard, ...revenueReports, ...attendanceReports})
      admin-companies.ts          # unchanged (no findings in scope)
    domain/                       # NEW — logic reused across 2+ routers, nothing else
      shared/
        time.ts                    # hoursUntil
      membership/
        active-membership.ts       # activeMembershipFor
        credits.ts                  # adjustIndividualCredits (bookings.ts's 3 internal call sites)
      corporate/
        credit-pool.ts              # adjustCorporatePool — kept separate from membership/credits.ts, see §3.3
      booking/
        authorization.ts            # canManageBooking
        capacity.ts                  # countActiveBookings (table-parameterized)
        waitlist.ts                   # findOldestWaitlisted (table-parameterized)
      reschedule/
        validate.ts                    # the shared 8-step check, see §8
```

**Why `domain/` and not `services/`:** "service" implies an object with
dependencies/state; everything proposed here is a plain function taking `db`
and primitives, returning a value or a query result. `domain/` signals "business
rules and shared queries reused across routers," which is the actual and only
justification used anywhere in this plan (§2's Category A/C items). Nothing is
in `domain/` because "layered architecture says so" — every file above is named
in §3, §4, or §8 with the specific duplicated code it replaces.

**Why `admin/` is a subdirectory of `routers/` and not `domain/`:** the three
files inside it are not reused by any other router — they're an internal split
of one file for cohesion, not shared logic. Putting them in `domain/` would
misrepresent them as cross-cutting when they aren't (see §6's repository
reasoning — a report query used by exactly one page is not a candidate for a
shared layer).

**What's deliberately absent:** no `services/`, no `repositories/`, no
`use-cases/`, no dependency-injection container. None of those are justified by
anything actually duplicated in this codebase (§2, §6).

---

## 11. Dependency map

**Current (e.g. `bookings.ts` `cancel`):**
```
router procedure (bookings.cancel)
 ├── zod input validation                     [stays]
 ├── ctx.db query: fetch booking + class       [stays — single-purpose]
 ├── ownership check (inline)                  [→ domain/booking/authorization.ts]
 ├── status check (inline)                     [stays — trivial, procedure-specific]
 ├── refund-eligibility calc (inline)          [shape → domain, threshold stays local]
 ├── ctx.db update: booking status             [stays]
 ├── ctx.db query + update: membership refund  [→ domain/membership/credits.ts]
 ├── ctx.db query: find oldest waitlisted      [→ domain/booking/waitlist.ts]
 └── ctx.db update x2: promote + charge        [orchestration stays; charge math → domain/membership/credits.ts]
```

**Proposed:**
```
router procedure (bookings.cancel)
 ├── zod input validation                                    [unchanged]
 ├── ctx.db query: fetch booking + class                     [unchanged]
 ├── domain/booking/authorization.canManageBooking(...)       [pure, no I/O]
 ├── status check (inline)                                   [unchanged]
 ├── domain/booking/*  refund-eligibility shape + local const [pure]
 ├── ctx.db update: booking status                           [unchanged]
 ├── domain/membership/credits.adjustIndividualCredits(...)   [pure calc; router still does the read/write]
 ├── domain/booking/waitlist.findOldestWaitlisted(db, ...)    [I/O, parameterized by table]
 └── domain/membership/credits.adjustIndividualCredits(...)   [reused for the promotion charge too]
```

The router **still owns every actual database read/write and their order** —
domain functions are either pure calculations or single parameterized queries
called *by* the router, not a new layer the router blindly delegates
orchestration to. This is deliberate: it's the smallest change that removes the
duplication in §2 without moving the sequencing that DATA-001/002/003 depend on.

---

## 12. Refactoring order

Every step is independently shippable and independently testable. Run
`npx vitest run` (189 tests) after every step; run the concurrency suite
(`tests/concurrency/`) an extra 3-5 times after any step marked ⚠️.

**Step 0 — Baseline.**
Confirm `npx vitest run` → 189/189, `git diff --stat -- src/` empty. (Already true.)

**Step 1 — Extract `hoursUntil`.**
New file: `src/server/domain/shared/time.ts`. Update `bookings.ts`,
`corporate-bookings.ts`, `reschedules.ts` to import instead of redefining;
delete the 3 local copies. *Files touched:* 4. *Risk:* LOW — pure function,
identical signature. *Tests:* all 189 (every date-boundary test in
`cancellation-boundary.test.ts`, `corporate-cancellation.test.ts`,
`reschedule.test.ts` exercises this function indirectly).

**Step 2 — Extract `activeMembershipFor`.**
New file: `src/server/domain/membership/active-membership.ts`. Update
`bookings.ts`, `reschedules.ts`. *Files touched:* 3. *Risk:* LOW. *Tests:*
`membership/membership-selection.test.ts`, `membership/plans-subscribe.test.ts`
(BUG-010 — must still show two active memberships coexisting), `reschedule/*`.

**Step 3 — Extract the ownership predicate.**
New file: `src/server/domain/booking/authorization.ts` (`canManageBooking`).
Update both `cancel()` methods. *Files touched:* 3. *Risk:* LOW. *Tests:*
`cancellation.test.ts`, `corporate-cancellation.test.ts` (both now DB-verified
per Phase 2B — good coverage for this exact code path).

**Step 4 — Extract the intra-`bookings.ts` credit-adjustment guard.**
New file: `src/server/domain/membership/credits.ts` (`adjustIndividualCredits`).
Replace the 3 duplicated `if (creditsRemaining < UNLIMITED_CREDITS) update...`
blocks inside `bookings.ts` only (book's debit, cancel's refund, cancel's
promotion charge). *Files touched:* 2. *Risk:* MEDIUM ⚠️ (touches the exact
code path DATA-002 characterizes). *Tests:* `membership/credits.test.ts`,
`cancellation-boundary.test.ts`, `waitlist/waitlist-promotion.test.ts` (DUP-005
individual side — must still floor to exactly 0 in the non-zero-balance
scenario), `concurrency/concurrent-credit.test.ts` — **run this test 5x
specifically after this step.**

**Step 5 — Extract the corporate pool-adjustment logic (kept separate).**
New file: `src/server/domain/corporate/credit-pool.ts` (`adjustCorporatePool`).
Replace the equivalent blocks in `corporate-bookings.ts` only — **do not**
reuse Step 4's function. *Files touched:* 2. *Risk:* MEDIUM ⚠️ (DUP-005 is the
whole point of this step — the two functions must keep producing different
outputs for the same shortfall input). *Tests:*
`corporate/corporate-waitlist-promotion.test.ts` (must still show the pool
left at 2, not floored to 0, in the distinguishing scenario) —
**this is the single most important test to watch in the entire plan.**

**Step 6 — Extract the capacity-count query.** ⚠️
New file: `src/server/domain/booking/capacity.ts` (`countActiveBookings`,
table-parameterized). Update `bookings.ts`, `corporate-bookings.ts`,
`reschedules.ts` (2 call sites). *Files touched:* 4. *Risk:* MEDIUM ⚠️ (touches
DATA-001's exact code path; table parameter must remain hardcoded per call
site — **do not** generalize it into a cross-table count). *Tests:*
`booking/capacity.test.ts`, `corporate/cross-capacity.test.ts` (BUG-001 — must
still show a corporate booking succeeding into an individually-full class),
`concurrency/concurrent-booking.test.ts` and
`concurrency/concurrent-duplicate-booking.test.ts` — **run 5x.**

**Step 7 — Extract the waitlist-promotion candidate query.**
New file: `src/server/domain/booking/waitlist.ts` (`findOldestWaitlisted`,
table-parameterized). Update both `cancel()` promotion blocks. *Files touched:*
3. *Risk:* LOW-MEDIUM. *Tests:* `waitlist/waitlist-promotion.test.ts`,
`corporate/corporate-waitlist-promotion.test.ts`.

**Step 8 — Extract reschedule validation.**
New file: `src/server/domain/reschedule/validate.ts`. Both `reschedule` and
`validateReschedule` call it; check order and every message string copied
verbatim; the dead `membership` variable and everything after validation stays
untouched. *Files touched:* 2. *Risk:* MEDIUM (large diff, but the
post-validation code — where BUG-003/BUG-004 actually live — is untouched).
*Tests:* all 18 tests in `reschedule/reschedule.test.ts` (each asserts one
exact error message — the highest-resolution regression net in the whole
suite for this step), plus `reschedule/reschedule-credits.test.ts`
(BUG-003/BUG-004 — must reproduce identically, since this step doesn't touch
that code).

**Step 9 — Reorganize `admin.ts` internally (zero API change).**
New files: `src/server/routers/admin/dashboard.ts`, `.../revenue-reports.ts`,
`.../attendance-reports.ts`. `admin.ts` becomes a thin composition. Query
bodies moved verbatim, not rewritten. *Files touched:* 4. *Risk:* LOW (no
logic changes, just file location). *Tests:* `admin/admin-stats.test.ts`,
`admin/admin-authorization.test.ts`, `admin/admin-class-cancellation.test.ts`.

**Step 10 — (Optional, deferred, not part of the core plan) Shared cancel
orchestration.**
Only if explicitly requested later: express the `book`/`cancel` orchestration
shape itself (not just its pure pieces) as a shared template parameterized by
injected payer callbacks. **Not recommended for this pass** — see §4's "what
should NOT become its own module." If pursued later, it requires re-verifying
DATA-001/002/003 determinism from scratch (re-run the empirical probe-script
methodology from Phase 2, not just the existing tests), since reordering the
`await` sequence can change race timing even when the logic is "equivalent."

After every step: `npx vitest run` must show **189 passed, 0 failed**. If a
step causes any test to fail, the fix is to revert that step, not to update
the test — a red test after a refactor step means the step changed behavior,
which is out of scope.

---

## 13. Risk matrix

| Refactor | Benefit | Complexity | Behavioral Risk | Tests Protecting It | Order |
|---|---|---|---|---|---|
| Extract `hoursUntil` | Removes 3x byte-identical duplication | LOW | LOW | All boundary tests (cancellation, corporate-cancellation, reschedule) | 1 |
| Extract `activeMembershipFor` | Removes 2x byte-identical duplication | LOW | LOW | `membership-selection.test.ts`, `plans-subscribe.test.ts` | 2 |
| Extract ownership predicate | Removes 2x byte-identical duplication | LOW | LOW | `cancellation.test.ts`, `corporate-cancellation.test.ts` | 3 |
| Extract individual credit-adjustment | Removes 3x intra-file duplication | LOW | MEDIUM | `credits.test.ts`, `waitlist-promotion.test.ts`, `concurrent-credit.test.ts` | 4 |
| Extract corporate pool-adjustment (kept separate) | Removes intra-file duplication *without* merging with individual | LOW | MEDIUM | `corporate-waitlist-promotion.test.ts` (DUP-005) | 5 |
| Extract capacity-count query | Removes 5-6x duplicated SQL shape | MEDIUM | MEDIUM | `capacity.test.ts`, `cross-capacity.test.ts` (BUG-001), `concurrent-booking.test.ts`, `concurrent-duplicate-booking.test.ts` | 6 |
| Extract waitlist-candidate query | Removes 2x duplicated SQL shape | LOW | LOW-MEDIUM | `waitlist-promotion.test.ts` ×2 | 7 |
| Extract reschedule validation | Removes ~130 duplicated lines, the largest single win | MEDIUM-HIGH | MEDIUM | All 18 `reschedule.test.ts` tests, `reschedule-credits.test.ts` (BUG-003/004) | 8 |
| Reorganize `admin.ts` (file split only) | Improves cohesion of a 268-line, 9-procedure file | LOW | LOW | `admin-stats.test.ts`, `admin-authorization.test.ts` | 9 |
| Unified cancel-orchestration template | Would remove the *last* layer of duplication (the orchestration shape itself) | HIGH | HIGH (touches DATA-001/002/003's exact sequencing) | Requires re-running the Phase 2 concurrency probe methodology, not just existing tests | Deferred — not in this plan |
| Give `trainers.ts` a `trainerProcedure` middleware | Removes 4x duplicated role check | LOW | LOW | `role-authorization.test.ts` (parameterized, checks all 4) | Optional, can slot in anywhere after Step 0 |
| Merge `bookings.ts`/`corporate-bookings.ts` into one router/table | Would look "DRY" | HIGH | **CRITICAL** — this is BUG-001/BUG-002's actual fix, not a refactor | N/A | **Not proposed. Explicitly rejected — see §3.** |
| Unify DUP-005's floor-vs-skip credit handling | Would look "consistent" | LOW (the change itself is trivial) | **CRITICAL** — this is a business-rule decision, not a refactor | `waitlist-promotion.test.ts`, `corporate-waitlist-promotion.test.ts` would both need rewriting | **Not proposed. Explicitly rejected — see §3.2.** |
| Unify `classes.list` vs `admin.classUtilisation` "booked" definition | Would look "consistent" | LOW | **CRITICAL** — this is BUG-006's actual fix | `booking/capacity.test.ts` | **Not proposed.** |
| Repository layer over all tables | "Clean architecture" | HIGH | MEDIUM (mostly just risk of scope creep / accidentally consolidating divergent queries) | N/A | **Not proposed — see §6.** |

---

## 14. Behavior explicitly preserved

Every item below must produce **identical** observable behavior — same status
codes, same error messages, same database end-state, same edge-case outcomes —
after every step in §12. This list is deliberately redundant with §9; it's
repeated here as the single section to check against before merging any step.

**Suspicious-but-deliberate behavior (audit §H, preserve as designed):**
- Individual free-cancellation window is 12h; corporate is 24h. Two different
  named constants, never unified.
- The 999-credit "unlimited" sentinel exists only for individual memberships.
- Waitlist promotion never re-checks credit/pool sufficiency, and floors
  individual credits to 0 rather than blocking the promotion.
- Reschedule requires the target class to have the exact same `name` string.
- `classes.update` only accepts a subset of fields (not `creditCost`,
  `durationMin`, `description`).
- Kiosk's `hoursAhead` default of 2 hours.
- Substring (`%term%`) search semantics in `members.search`/`lookupByEmailOrPhone`.

**Confirmed bugs (preserve until explicitly approved to fix — full list in §9):**
BUG-001 through BUG-010, DATA-001 through DATA-003, DUP-005.

**Architectural facts that are out of scope to "fix" as a side effect:**
- ARCH-001: `corporateBookings` has no frontend caller. This plan does not add one.
- ARCH-008: corporate check-ins have `bookingId: null`. This plan does not
  change the schema to fix it.
- SEC-003: any trainer can check in / view the roster for any class, not just
  their own. Not touched by this plan.

**Every exact error code + message string** cited in §3, §8, and the 189 existing
tests. None are reworded during this refactor, even ones that read awkwardly.

**Every open question in `docs/open-questions.md`** remains unresolved and
unanswered by this plan. Nothing in §3–§12 requires or assumes an answer to any
of the 12 questions there.

---

## 15. Final recommendation

### A. Recommended target architecture

Keep the current three-layer shape (`app/` → `server/routers/` → `db/`) and add
exactly one new layer, `server/domain/`, containing only functions that are
reused by 2+ routers today (proven by direct code comparison, not assumed).
`admin/` becomes a router-internal subdirectory, not a new layer. No
repository layer, no services layer, no DI container — none of those are
justified by anything actually duplicated in this ~5,500-line codebase.

### B. Top 5 highest-value refactors (in priority order)

1. **Extract reschedule validation** (§8) — single largest line-count reduction
   (~130 lines), best test coverage of any target (18 exact-message tests),
   and the clearest "this is obviously copy-pasted" case in the codebase.
2. **Extract the intra-`bookings.ts` credit-adjustment guard** (§4, Step 4) —
   highest-confidence extraction (same file, same table, proven identical),
   removes 3 duplicated blocks with one function.
3. **Extract `hoursUntil` and `activeMembershipFor`** (Steps 1-2) — lowest risk
   possible, removes 5 duplicated copies total, good warm-up before touching
   anything with a BUG-*/DATA-* finding attached.
4. **Extract the capacity-count query shape** (§3.3, Step 6) — removes the
   biggest *count* of duplicated call sites (5-6), while explicitly preserving
   BUG-001 by keeping the table parameter hardcoded per call site.
5. **Reorganize `admin.ts` into three internal files** (§7, Step 9) — zero
   behavioral risk, directly fixes the lowest-cohesion file in the codebase,
   good "confidence builder" step to run alongside any of the above.

### C. Refactors that should NOT be done

- Merging `bookings.ts` and `corporate-bookings.ts`, or unifying their capacity
  counts across tables — this is BUG-001/BUG-002's fix, not a refactor (§3).
- Unifying DUP-005's floor-vs-skip credit-shortfall handling — a business
  decision, not a refactor (§3.2).
- Unifying `classes.list` vs `admin.classUtilisation`'s differing "booked"
  definitions — this is BUG-006's fix (§2).
- A repository layer over all 14 tables — most queries are one-off and shaped
  for exactly one response; a repository adds indirection without removing
  real duplication (§6).
- The "shared cancel-orchestration template" (§4, §12 Step 10) — real
  potential value, but HIGH risk to the concurrency characterizations; defer
  until there's explicit appetite to re-verify DATA-001/002/003 from scratch.

### D. Bugs that must remain untouched during this refactor

BUG-001, BUG-002, BUG-003, BUG-004, BUG-005, BUG-006, BUG-007, BUG-008,
BUG-009, BUG-010, DATA-001, DATA-002, DATA-003, and DUP-005 (tracked as a
duplication finding in the audit, but functionally a bug-adjacent unresolved
question). Full reproduction-test mapping in §9.

### E. Business questions that must remain unresolved

All 12 questions in `docs/open-questions.md`, unchanged and unanswered by this
plan — most directly relevant to the refactor: whether corporate/individual
capacity should ever be shared (#1), whether DUP-005's two credit-shortfall
behaviors should converge (#9), and whether corporate booking is still an
active feature worth building UI for (#2, since ARCH-001 shapes how much
future investment `corporate-bookings.ts` deserves).

### F. Exact recommended order of implementation

Steps 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9, exactly as specified in §12, running
the full 189-test suite after each step (and the concurrency suite 5x extra
after steps 4, 5, 6). Step 10 is explicitly deferred, not sequenced.

### G. Expected files affected by each step

| Step | Files touched |
|---|---|
| 1 | `domain/shared/time.ts` (new), `bookings.ts`, `corporate-bookings.ts`, `reschedules.ts` |
| 2 | `domain/membership/active-membership.ts` (new), `bookings.ts`, `reschedules.ts` |
| 3 | `domain/booking/authorization.ts` (new), `bookings.ts`, `corporate-bookings.ts` |
| 4 | `domain/membership/credits.ts` (new), `bookings.ts` |
| 5 | `domain/corporate/credit-pool.ts` (new), `corporate-bookings.ts` |
| 6 | `domain/booking/capacity.ts` (new), `bookings.ts`, `corporate-bookings.ts`, `reschedules.ts` |
| 7 | `domain/booking/waitlist.ts` (new), `bookings.ts`, `corporate-bookings.ts` |
| 8 | `domain/reschedule/validate.ts` (new), `reschedules.ts` |
| 9 | `routers/admin/dashboard.ts`, `.../revenue-reports.ts`, `.../attendance-reports.ts` (new), `admin.ts` |

No step touches `src/db/schema.ts`, any file under `src/app/`, or
`src/components/` — the refactor is confined to `src/server/`.

### H. Tests that must remain green after each step

**After every step, without exception:** all 189 tests, 30 files, 0 failures.
Step-specific tests to watch most closely are named in §12 and §13; the
concurrency suite (3 files) gets extra runs (5x) after steps 4, 5, and 6
specifically, since those are the steps touching code that DATA-001/002/003
characterize.

---

## Stop condition

This document is the complete plan. No production code was modified to produce
it. No step in §12 has been executed. Waiting for review before implementing
Step 1.
